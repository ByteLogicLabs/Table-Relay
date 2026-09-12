//! Safe query row-limit handling for SQL queries.
//!
//! Rather than blindly appending `LIMIT N` onto whatever query the user wrote
//! (which breaks `SHOW`, `DESCRIBE`, `EXPLAIN`, `PRAGMA`, `FOR UPDATE`,
//! queries ending with semicolons, line comments, etc.), this module inspects
//! the statement and only injects `LIMIT` when safe to do so.

use crate::types::MAX_RESULT_ROWS;

/// Prepares a query for execution by checking if a row limit can safely be
/// appended to the SQL string.
///
/// Returns a tuple of:
/// - `effective_sql`: the SQL to execute (either with `LIMIT {cap}` appended, or unmodified).
/// - `can_be_truncated`: true only if a `LIMIT` clause was safely injected and could cap the results.
pub fn prepare_capped_query(sql: &str, row_limit: Option<u32>) -> (String, bool) {
    // If row_limit is explicitly Some(0), the user/caller requested Unlimited — do not cap!
    if row_limit == Some(0) {
        return (sql.to_string(), false);
    }
    let cap = row_limit.unwrap_or(MAX_RESULT_ROWS);

    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return (sql.to_string(), false);
    }

    let masked = mask_sql_literals_and_comments(trimmed);
    let upper = masked.to_ascii_uppercase();
    let trimmed_upper = upper.trim_start();

    // Must start with SELECT or WITH.
    // Explicitly reject SHOW, DESCRIBE, DESC, EXPLAIN, PRAGMA, CALL, EXEC, etc.
    let is_select = trimmed_upper.starts_with("SELECT")
        && (trimmed_upper.len() == 6
            || matches!(
                trimmed_upper.as_bytes()[6],
                b' ' | b'\t' | b'\n' | b'\r' | b'('
            ));
    let is_with = trimmed_upper.starts_with("WITH")
        && (trimmed_upper.len() == 4
            || matches!(
                trimmed_upper.as_bytes()[4],
                b' ' | b'\t' | b'\n' | b'\r'
            ));

    if !is_select && !is_with {
        return (sql.to_string(), false);
    }

    // If it starts with WITH, verify it's a WITH … SELECT and not WITH … INSERT/UPDATE/DELETE.
    if is_with {
        let mut depth: u32 = 0;
        let mut main_keyword = "";
        let mut past_first_paren = false;
        let bytes = upper.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'(' => {
                    depth += 1;
                    past_first_paren = true;
                }
                b')' => depth = depth.saturating_sub(1),
                _ if past_first_paren && depth == 0 => {
                    let rest = &upper[i..];
                    let word = rest
                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                        .find(|s| !s.is_empty())
                        .unwrap_or("");
                    if matches!(word, "SELECT" | "INSERT" | "UPDATE" | "DELETE") {
                        main_keyword = word;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        if main_keyword != "SELECT" && !main_keyword.is_empty() {
            return (sql.to_string(), false);
        }
    }

    // Check if query already contains LIMIT, OFFSET, or FETCH
    if contains_keyword(&upper, "LIMIT")
        || contains_keyword(&upper, "OFFSET")
        || contains_keyword(&upper, "FETCH")
    {
        return (sql.to_string(), false);
    }

    // Check for locking clauses or clauses that forbid appending LIMIT at the end:
    // - FOR UPDATE, FOR SHARE, FOR NO KEY UPDATE, FOR KEY SHARE
    // - LOCK IN SHARE MODE
    // - INTO OUTFILE, INTO DUMPFILE
    // - PROCEDURE ANALYSE
    if contains_phrase(&upper, "FOR UPDATE")
        || contains_phrase(&upper, "FOR SHARE")
        || contains_phrase(&upper, "FOR NO KEY UPDATE")
        || contains_phrase(&upper, "FOR KEY SHARE")
        || contains_phrase(&upper, "LOCK IN SHARE MODE")
        || contains_phrase(&upper, "INTO OUTFILE")
        || contains_phrase(&upper, "INTO DUMPFILE")
        || contains_phrase(&upper, "PROCEDURE ANALYSE")
    {
        return (sql.to_string(), false);
    }

    // Strip trailing semicolons from the original sql before appending LIMIT
    let clean = clean_trailing_semicolon(trimmed);

    (format!("{clean}\nLIMIT {cap}"), true)
}

/// Replaces string literals (`'...'`, `"..."`, `` `...` ``), dollar quotes (`$$...$$`),
/// line comments (`-- ...`, `# ...`), and block comments (`/* ... */`) with spaces.
/// Preserves exact byte/char indices so keyword matching is accurate and unpolluted.
fn mask_sql_literals_and_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_back = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_tag: Option<String> = None;
    let mut prev = '\0';

    while let Some(ch) = chars.next() {
        if in_line_comment {
            out.push(' ');
            if ch == '\n' {
                in_line_comment = false;
            }
            prev = ch;
            continue;
        }

        if in_block_comment {
            out.push(' ');
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                out.push(' ');
                in_block_comment = false;
            }
            prev = ch;
            continue;
        }

        if let Some(ref tag) = dollar_tag {
            out.push(' ');
            if ch == '$' {
                // Check if closing tag matches
                let mut peek_chars = chars.clone();
                let mut tag_matches = true;
                for tc in tag.chars() {
                    if peek_chars.next() != Some(tc) {
                        tag_matches = false;
                        break;
                    }
                }
                if tag_matches && peek_chars.next() == Some('$') {
                    // Consume tag chars + closing '$'
                    for _ in 0..tag.len() + 1 {
                        chars.next();
                        out.push(' ');
                    }
                    dollar_tag = None;
                }
            }
            prev = ch;
            continue;
        }

        if in_single {
            out.push(' ');
            if ch == '\'' && prev != '\\' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    out.push(' ');
                } else {
                    in_single = false;
                }
            }
            prev = ch;
            continue;
        }

        if in_double {
            out.push(' ');
            if ch == '"' && prev != '\\' {
                in_double = false;
            }
            prev = ch;
            continue;
        }

        if in_back {
            out.push(' ');
            if ch == '`' {
                in_back = false;
            }
            prev = ch;
            continue;
        }

        // Check for comment starts
        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            out.push(' ');
            out.push(' ');
            in_line_comment = true;
            prev = '-';
            continue;
        }
        if ch == '#' {
            out.push(' ');
            in_line_comment = true;
            prev = '#';
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            out.push(' ');
            out.push(' ');
            in_block_comment = true;
            prev = '*';
            continue;
        }

        // Check for dollar quotes ($tag$ or $$)
        if ch == '$' {
            let mut peek_chars = chars.clone();
            let mut tag = String::new();
            let mut valid_tag = false;
            while let Some(pc) = peek_chars.next() {
                if pc == '$' {
                    valid_tag = true;
                    break;
                }
                if pc.is_ascii_alphanumeric() || pc == '_' {
                    tag.push(pc);
                } else {
                    break;
                }
            }
            if valid_tag {
                for _ in 0..tag.len() + 1 {
                    chars.next();
                }
                out.push_str(&" ".repeat(tag.len() + 2));
                dollar_tag = Some(tag);
                prev = '$';
                continue;
            }
        }

        // Quotes
        if ch == '\'' {
            in_single = true;
            out.push(' ');
            prev = ch;
            continue;
        }
        if ch == '"' {
            in_double = true;
            out.push(' ');
            prev = ch;
            continue;
        }
        if ch == '`' {
            in_back = true;
            out.push(' ');
            prev = ch;
            continue;
        }

        out.push(ch);
        prev = ch;
    }

    out
}

fn contains_keyword(haystack: &str, kw: &str) -> bool {
    haystack
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|w| w == kw)
}

fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    let words: Vec<&str> = phrase.split_whitespace().collect();
    if words.is_empty() {
        return false;
    }
    let h_words: Vec<&str> = haystack
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .collect();
    if h_words.len() < words.len() {
        return false;
    }
    for i in 0..=h_words.len() - words.len() {
        if h_words[i..i + words.len()] == words[..] {
            return true;
        }
    }
    false
}

fn clean_trailing_semicolon(sql: &str) -> &str {
    let mut s = sql.trim_end();
    while s.ends_with(';') {
        s = s[..s.len() - 1].trim_end();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_show_statements_not_capped() {
        let (res, truncated) = prepare_capped_query("SHOW SESSION VARIABLES;", None);
        assert_eq!(res, "SHOW SESSION VARIABLES;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SHOW TABLES", None);
        assert_eq!(res, "SHOW TABLES");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SHOW CREATE TABLE users;", None);
        assert_eq!(res, "SHOW CREATE TABLE users;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SHOW GLOBAL STATUS;", None);
        assert_eq!(res, "SHOW GLOBAL STATUS;");
        assert!(!truncated);
    }

    #[test]
    fn test_describe_and_explain_not_capped() {
        let (res, truncated) = prepare_capped_query("DESCRIBE users;", None);
        assert_eq!(res, "DESCRIBE users;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("DESC users;", None);
        assert_eq!(res, "DESC users;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("EXPLAIN SELECT * FROM users;", None);
        assert_eq!(res, "EXPLAIN SELECT * FROM users;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("EXPLAIN ANALYZE SELECT * FROM users;", None);
        assert_eq!(res, "EXPLAIN ANALYZE SELECT * FROM users;");
        assert!(!truncated);
    }

    #[test]
    fn test_pragma_not_capped() {
        let (res, truncated) = prepare_capped_query("PRAGMA table_info('users');", None);
        assert_eq!(res, "PRAGMA table_info('users');");
        assert!(!truncated);
    }

    #[test]
    fn test_plain_select_capped_cleanly() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users", None);
        assert_eq!(res, "SELECT * FROM users\nLIMIT 10000");
        assert!(truncated);

        // Strips trailing semicolon so `; LIMIT` syntax error doesn't happen
        let (res, truncated) = prepare_capped_query("SELECT * FROM users;", None);
        assert_eq!(res, "SELECT * FROM users\nLIMIT 10000");
        assert!(truncated);

        // Preserves custom limit when passed
        let (res, truncated) = prepare_capped_query("SELECT * FROM users;", Some(500));
        assert_eq!(res, "SELECT * FROM users\nLIMIT 500");
        assert!(truncated);
    }

    #[test]
    fn test_unlimited_mode_not_capped() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users;", Some(0));
        assert_eq!(res, "SELECT * FROM users;");
        assert!(!truncated);
    }

    #[test]
    fn test_select_with_comments() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users -- comment", None);
        assert_eq!(res, "SELECT * FROM users -- comment\nLIMIT 10000");
        assert!(truncated);
    }

    #[test]
    fn test_existing_limit_or_offset_not_capped() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users LIMIT 10;", None);
        assert_eq!(res, "SELECT * FROM users LIMIT 10;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SELECT * FROM users OFFSET 5;", None);
        assert_eq!(res, "SELECT * FROM users OFFSET 5;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SELECT * FROM users FETCH FIRST 10 ROWS ONLY;", None);
        assert_eq!(res, "SELECT * FROM users FETCH FIRST 10 ROWS ONLY;");
        assert!(!truncated);
    }

    #[test]
    fn test_locking_clauses_not_capped() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users FOR UPDATE;", None);
        assert_eq!(res, "SELECT * FROM users FOR UPDATE;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SELECT * FROM users FOR SHARE;", None);
        assert_eq!(res, "SELECT * FROM users FOR SHARE;");
        assert!(!truncated);

        let (res, truncated) = prepare_capped_query("SELECT * FROM users LOCK IN SHARE MODE;", None);
        assert_eq!(res, "SELECT * FROM users LOCK IN SHARE MODE;");
        assert!(!truncated);
    }

    #[test]
    fn test_literal_with_limit_keyword() {
        // 'limit exceeded' inside literal shouldn't count as LIMIT clause
        let (res, truncated) = prepare_capped_query("SELECT * FROM users WHERE status = 'limit exceeded';", None);
        assert_eq!(res, "SELECT * FROM users WHERE status = 'limit exceeded'\nLIMIT 10000");
        assert!(truncated);
    }

    #[test]
    fn test_with_cte() {
        let (res, truncated) = prepare_capped_query("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;", None);
        assert_eq!(res, "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte\nLIMIT 10000");
        assert!(truncated);

        let (res, truncated) = prepare_capped_query("WITH cte AS (SELECT 1 AS id) INSERT INTO target SELECT * FROM cte;", None);
        assert_eq!(res, "WITH cte AS (SELECT 1 AS id) INSERT INTO target SELECT * FROM cte;");
        assert!(!truncated);
    }
}
