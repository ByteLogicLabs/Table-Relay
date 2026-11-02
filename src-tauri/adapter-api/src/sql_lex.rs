//! Dialect-aware SQL lexing shared by the SQL adapters: statement splitting,
//! statement classification, and the row cap in [`crate::query_cap`].
//!
//! Everything works on a *masked* copy of the SQL: string literals and quoted
//! identifiers are filled with [`LITERAL_FILL`], comments with spaces, and the
//! rest is upper-cased, byte length preserved. A `;`, keyword or paren in the
//! masked text is therefore real code, and offsets into it are offsets into the
//! original. The query editor's TS lexer (`src/features/sql-editor/sql-lexer.ts`)
//! implements the same rules — keep the two in sync.

use crate::manifest::SqlDialect;

/// Lexical rules that differ between dialects. Getting these wrong shifts the
/// masked region — e.g. treating Postgres' `#>` JSON operator as a MySQL `#`
/// comment hides a real `LIMIT` that follows it on the same line.
#[derive(Clone, Copy)]
struct LexRules {
    /// `# …` line comments (MySQL).
    hash_comment: bool,
    /// `--` only starts a comment when followed by whitespace (MySQL), so
    /// `5--3` stays arithmetic.
    dash_comment_needs_space: bool,
    /// A bare `\r` ends a line comment too (Postgres); elsewhere only `\n` does.
    cr_ends_line_comment: bool,
    /// Backslash escapes inside `'…'` / `"…"` (MySQL default sql_mode).
    backslash_escapes: bool,
    /// `E'…'` strings with backslash escapes (Postgres).
    e_strings: bool,
    /// `` `…` `` quoted identifiers (MySQL, SQLite).
    backticks: bool,
    /// `[…]` quoted identifiers (SQLite).
    brackets: bool,
    /// `$tag$ … $tag$` strings (Postgres).
    dollar_quotes: bool,
    /// `/* /* */ */` nests (Postgres).
    nested_block_comments: bool,
    /// `/*! … */` and `/*M! … */` bodies are executed as SQL (MySQL/MariaDB).
    executable_comments: bool,
}

impl LexRules {
    fn for_dialect(dialect: SqlDialect) -> Self {
        let ansi = LexRules {
            hash_comment: false,
            dash_comment_needs_space: false,
            cr_ends_line_comment: false,
            backslash_escapes: false,
            e_strings: false,
            backticks: false,
            brackets: false,
            dollar_quotes: false,
            nested_block_comments: false,
            executable_comments: false,
        };
        match dialect {
            SqlDialect::Mysql => LexRules {
                hash_comment: true,
                dash_comment_needs_space: true,
                backslash_escapes: true,
                backticks: true,
                executable_comments: true,
                ..ansi
            },
            SqlDialect::Postgres => LexRules {
                cr_ends_line_comment: true,
                e_strings: true,
                dollar_quotes: true,
                nested_block_comments: true,
                ..ansi
            },
            SqlDialect::Sqlite => LexRules {
                backticks: true,
                brackets: true,
                ..ansi
            },
            SqlDialect::Generic | SqlDialect::None => LexRules {
                backticks: true,
                ..ansi
            },
        }
    }
}

/// Whitespace as the SQL lexers see it. Shared with the editor's TS lexer
/// (`isSqlSpace`) so both sides trim identically; non-ASCII spaces count as
/// word bytes on both sides.
pub(crate) fn is_sql_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

/// Bytes that can continue an unquoted identifier or keyword. Non-ASCII bytes
/// count so UTF-8 identifiers stay whole.
pub(crate) fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

/// Fill for masked string literals and quoted identifiers: significant (not
/// whitespace, so a trailing literal isn't trimmed off) but never part of a
/// word, a paren, or a `;`.
const LITERAL_FILL: u8 = b'\'';
/// Fill for masked comments: insignificant, exactly like whitespace.
const COMMENT_FILL: u8 = b' ';

/// Replaces string literals and quoted identifiers with [`LITERAL_FILL`],
/// comments (and the `/*!12345` executable-comment opener) with
/// [`COMMENT_FILL`], and upper-cases the rest. The output has exactly the same
/// byte length as the input, so offsets into it are offsets into `sql`.
pub(crate) fn mask_sql_literals_and_comments(sql: &str, dialect: SqlDialect) -> Vec<u8> {
    mask(sql, dialect, false)
}

/// Like the literal mask, but quoted identifiers (`` `db` ``, `[db]`, and
/// `"db"` outside MySQL) stay readable — for scans that need identifier names
/// ("does this reference another database?") but must not be fooled by string
/// contents or comments. Upper-cased, same length as `sql`.
pub fn mask_strings_and_comments(sql: &str, dialect: SqlDialect) -> String {
    String::from_utf8(mask(sql, dialect, true)).expect("masking keeps UTF-8 sequences whole")
}

fn mask(sql: &str, dialect: SqlDialect, keep_identifiers: bool) -> Vec<u8> {
    let rules = LexRules::for_dialect(dialect);
    let double_quote_is_identifier = !matches!(dialect, SqlDialect::Mysql);
    let src = sql.as_bytes();
    let len = src.len();
    let mut out = src.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize, fill: u8| out[from..to].fill(fill);

    let mut in_executable_comment = false;
    let mut i = 0;
    while i < len {
        let c = src[i];
        let next = src.get(i + 1).copied();

        // Line comments: `-- …` and (MySQL) `# …`.
        let dash_comment = c == b'-'
            && next == Some(b'-')
            && (!rules.dash_comment_needs_space || src.get(i + 2).map_or(true, |&b| b <= b' '));
        if dash_comment || (c == b'#' && rules.hash_comment) {
            let end = src[i..]
                .iter()
                .position(|&b| b == b'\n' || (rules.cr_ends_line_comment && b == b'\r'))
                .map_or(len, |p| i + p);
            blank(&mut out, i, end, COMMENT_FILL);
            i = end;
            continue;
        }

        if c == b'/' && next == Some(b'*') {
            // MySQL executable comment: drop the `/*!12345` marker, keep the body.
            let marker = match (src.get(i + 2).copied(), src.get(i + 3).copied()) {
                (Some(b'!'), _) => Some(3),
                (Some(b'M'), Some(b'!')) => Some(4),
                _ => None,
            };
            if let Some(marker) = marker.filter(|_| rules.executable_comments) {
                let mut end = i + marker;
                while end < len && src[end].is_ascii_digit() {
                    end += 1;
                }
                blank(&mut out, i, end, COMMENT_FILL);
                in_executable_comment = true;
                i = end;
                continue;
            }

            let mut depth = 1;
            let mut j = i + 2;
            while j < len && depth > 0 {
                if src[j] == b'*' && src.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else if rules.nested_block_comments && src[j] == b'/' && src.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j, COMMENT_FILL);
            i = j;
            continue;
        }

        // The `*/` closing an executable comment stays unmasked, so a body cut
        // after the last significant token keeps it: `/*!50000 SELECT 1 */`
        // must not be cut to an unterminated `/*!50000 SELECT 1`.
        if in_executable_comment && c == b'*' && next == Some(b'/') {
            in_executable_comment = false;
            i += 2;
            continue;
        }

        if c == b'\'' || c == b'"' || (c == b'`' && rules.backticks) {
            let e_string = c == b'\''
                && rules.e_strings
                && i > 0
                && src[i - 1].eq_ignore_ascii_case(&b'E')
                && (i == 1 || !is_word_byte(src[i - 2]));
            let backslash = (rules.backslash_escapes && c != b'`') || e_string;
            let end = scan_quoted(src, i, c, backslash);
            let identifier = c == b'`' || (c == b'"' && double_quote_is_identifier);
            if !(keep_identifiers && identifier) {
                blank(&mut out, i, end, LITERAL_FILL);
            }
            i = end;
            continue;
        }

        if c == b'[' && rules.brackets {
            let end = src[i..].iter().position(|&b| b == b']').map_or(len, |p| i + p + 1);
            if !keep_identifiers {
                blank(&mut out, i, end, LITERAL_FILL);
            }
            i = end;
            continue;
        }

        // `$tag$` opens a dollar quote unless the `$` continues an identifier
        // (`a$b`). Tags can't start with a digit, so `$1` stays a parameter.
        if c == b'$' && rules.dollar_quotes && (i == 0 || !is_word_byte(src[i - 1])) {
            let mut j = i + 1;
            if j < len && (src[j].is_ascii_alphabetic() || src[j] == b'_' || src[j] >= 0x80) {
                while j < len && is_word_byte(src[j]) && src[j] != b'$' {
                    j += 1;
                }
            }
            if src.get(j) == Some(&b'$') {
                let tag = &src[i..=j];
                let body = j + 1;
                let end = src[body..]
                    .windows(tag.len())
                    .position(|w| w == tag)
                    .map_or(len, |p| body + p + tag.len());
                blank(&mut out, i, end, LITERAL_FILL);
                i = end;
                continue;
            }
        }

        i += 1;
    }

    out.make_ascii_uppercase();
    out
}

/// Index just past the closing quote of the literal opening at `start`, or the
/// end of input when it's unterminated. A doubled quote is an escaped quote.
fn scan_quoted(src: &[u8], start: usize, quote: u8, backslash_escapes: bool) -> usize {
    let mut j = start + 1;
    while j < src.len() {
        let b = src[j];
        if backslash_escapes && b == b'\\' {
            j += 2;
            continue;
        }
        if b == quote {
            if src.get(j + 1) == Some(&quote) {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    src.len()
}

pub(crate) struct Word {
    pub(crate) text: String,
    pub(crate) depth: u32,
}

/// Splits masked SQL into words, tagging each with its paren depth.
pub(crate) fn tokenize(masked: &[u8]) -> Vec<Word> {
    let mut words = Vec::new();
    let mut depth: u32 = 0;
    let mut i = 0;
    while i < masked.len() {
        let b = masked[i];
        if is_word_byte(b) {
            let start = i;
            while i < masked.len() && is_word_byte(masked[i]) {
                i += 1;
            }
            words.push(Word {
                text: String::from_utf8_lossy(&masked[start..i]).into_owned(),
                depth,
            });
            continue;
        }
        match b {
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    words
}

/// The statement's first keyword, upper-cased, skipping leading whitespace,
/// comments and opening parens — so callers that classify by verb see
/// `SELECT` in `/*+ SeqScan(t) */ SELECT …` and `(SELECT …) UNION (…)`.
/// MySQL executable comments count as code: `/*!50000 SELECT 1 */` → `SELECT`.
pub fn leading_keyword(sql: &str, dialect: SqlDialect) -> String {
    let masked = mask_sql_literals_and_comments(sql, dialect);
    let start = masked
        .iter()
        .position(|&b| !is_sql_space(b) && b != b'(')
        .unwrap_or(masked.len());
    let end = masked[start..]
        .iter()
        .position(|&b| !is_word_byte(b))
        .map_or(masked.len(), |p| start + p);
    String::from_utf8_lossy(&masked[start..end]).into_owned()
}

/// The statement's words outside literals and comments, upper-cased, each with
/// its paren depth — for classifying what a statement does.
pub fn code_words(sql: &str, dialect: SqlDialect) -> Vec<(String, u32)> {
    tokenize(&mask_sql_literals_and_comments(sql, dialect))
        .into_iter()
        .map(|w| (w.text, w.depth))
        .collect()
}

/// Whether `keyword` (upper-case) appears as a word at paren depth 0, outside
/// literals and comments — e.g. `RETURNING` in `INSERT … RETURNING id` but not
/// in `UPDATE t SET note = 'returning'`.
pub fn has_top_level_keyword(sql: &str, dialect: SqlDialect, keyword: &str) -> bool {
    tokenize(&mask_sql_literals_and_comments(sql, dialect))
        .iter()
        .any(|w| w.depth == 0 && w.text == keyword)
}

/// Splits a batch into statements at top-level delimiters, honouring the
/// dialect's literals and comments: a `;` inside a string, quoted identifier,
/// comment or dollar quote never splits. On top of that:
/// - MySQL: client-style `DELIMITER xx` lines switch the delimiter and are
///   dropped, so `CREATE PROCEDURE … BEGIN …; END //` stays one statement.
/// - SQLite: a `;` inside a `CREATE TRIGGER … BEGIN … END` body doesn't split.
///
/// Pieces holding only whitespace and comments are dropped — sending one makes
/// the server fail with an "empty query" error. Statement text is returned
/// as written (untrimmed, comments kept).
pub fn split_sql_statements(sql: &str, dialect: SqlDialect) -> Vec<String> {
    let masked = mask_sql_literals_and_comments(sql, dialect);
    let len = masked.len();
    let is_mysql = matches!(dialect, SqlDialect::Mysql);
    let is_sqlite = matches!(dialect, SqlDialect::Sqlite);

    let mut out = Vec::new();
    let mut delimiter: Vec<u8> = b";".to_vec();
    let mut start = 0;
    // Statement state since `start`.
    let mut has_code = false;
    let mut head: Vec<String> = Vec::new();
    let mut in_trigger = false;
    let mut block_depth: u32 = 0;

    let mut i = 0;
    while i < len {
        if is_mysql && !has_code && (i == 0 || masked[i - 1] == b'\n') {
            if let Some((new_delimiter, next)) = parse_delimiter_line(sql, &masked, i) {
                if !new_delimiter.is_empty() {
                    delimiter = new_delimiter;
                }
                i = next;
                start = next;
                continue;
            }
        }

        if !(in_trigger && block_depth > 0) && masked[i..].starts_with(&delimiter) {
            push_statement(&mut out, sql, start, i, has_code);
            i += delimiter.len();
            start = i;
            has_code = false;
            head.clear();
            in_trigger = false;
            block_depth = 0;
            continue;
        }

        let b = masked[i];
        if is_word_byte(b) {
            let word_start = i;
            // A word-like delimiter (`$$`, `;;` aside) can follow a word with
            // no space: `END$$`.
            while i < len && is_word_byte(masked[i]) && (i == word_start || !masked[i..].starts_with(&delimiter)) {
                i += 1;
            }
            has_code = true;
            if is_sqlite {
                let word = &masked[word_start..i];
                if head.len() < 3 {
                    head.push(String::from_utf8_lossy(word).into_owned());
                    let h: Vec<&str> = head.iter().map(String::as_str).collect();
                    in_trigger = matches!(
                        h.as_slice(),
                        ["CREATE", "TRIGGER", ..] | ["CREATE", "TEMP" | "TEMPORARY", "TRIGGER"]
                    );
                }
                if in_trigger {
                    match word {
                        b"BEGIN" | b"CASE" => block_depth += 1,
                        b"END" => block_depth = block_depth.saturating_sub(1),
                        _ => {}
                    }
                }
            }
            continue;
        }
        if !is_sql_space(b) {
            has_code = true;
        }
        i += 1;
    }
    push_statement(&mut out, sql, start, sql.len(), has_code);
    out
}

/// Keeps `sql[start..end]` unless it holds no code — only whitespace (Unicode
/// spaces included) and comments.
fn push_statement(out: &mut Vec<String>, sql: &str, start: usize, end: usize, has_code: bool) {
    let text = &sql[start..end];
    if has_code && !text.trim().is_empty() {
        out.push(text.to_string());
    }
}

/// A MySQL client `DELIMITER xx` command on the line starting at `line_start`:
/// returns the new delimiter (upper-cased to compare against masked text) and
/// the offset just past the line.
fn parse_delimiter_line(sql: &str, masked: &[u8], line_start: usize) -> Option<(Vec<u8>, usize)> {
    let line_end = masked[line_start..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(masked.len(), |p| line_start + p);
    let line = &masked[line_start..line_end];
    let indent = line.iter().position(|&b| !is_sql_space(b)).unwrap_or(line.len());
    let rest = &line[indent..];
    if !rest.starts_with(b"DELIMITER") || rest.get(9).is_some_and(|&b| !is_sql_space(b)) {
        return None;
    }
    let token_from = line_start + indent + 9;
    let token: Vec<u8> = sql.as_bytes()[token_from..line_end]
        .iter()
        .copied()
        .skip_while(|&b| is_sql_space(b))
        .take_while(|&b| !is_sql_space(b))
        .map(|b| b.to_ascii_uppercase())
        .collect();
    Some((token, (line_end + 1).min(masked.len())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: SqlDialect = SqlDialect::Mysql;
    const PG: SqlDialect = SqlDialect::Postgres;
    const LITE: SqlDialect = SqlDialect::Sqlite;

    fn split(sql: &str, dialect: SqlDialect) -> Vec<String> {
        split_sql_statements(sql, dialect).iter().map(|s| s.trim().to_string()).collect()
    }

    #[test]
    fn test_leading_keyword() {
        assert_eq!(leading_keyword("/*+ SeqScan(t) */ SELECT 1", PG), "SELECT");
        assert_eq!(leading_keyword("-- note\n  # x\nshow tables", MY), "SHOW");
        assert_eq!(leading_keyword("/*!50000 SELECT 1 */", MY), "SELECT");
        assert_eq!(leading_keyword("  ((select 1)) union (select 2)", PG), "SELECT");
        assert_eq!(leading_keyword("/* unterminated", PG), "");
        assert_eq!(leading_keyword("'lit' AS x", PG), "");
        assert_eq!(leading_keyword("# not a comment in pg", PG), "");
        assert_eq!(leading_keyword("CALL p()", MY), "CALL");
    }

    #[test]
    fn test_mask_strings_and_comments_keeps_identifiers() {
        let m = mask_strings_and_comments("SELECT `sakila`.film, 'x@sakila.com' -- sakila.x\nFROM t", MY);
        assert!(m.contains("`SAKILA`.FILM"));
        assert!(!m.contains("SAKILA.COM"));
        assert!(!m.contains("SAKILA.X"));
        assert_eq!(m.len(), "SELECT `sakila`.film, 'x@sakila.com' -- sakila.x\nFROM t".len());
        // In MySQL "..." is a string; elsewhere an identifier.
        assert!(!mask_strings_and_comments(r#"SELECT "db".t"#, MY).contains("DB"));
        assert!(mask_strings_and_comments(r#"SELECT "db".t"#, PG).contains(r#""DB".T"#));
    }

    #[test]
    fn test_has_top_level_keyword() {
        assert!(has_top_level_keyword("INSERT INTO t VALUES (1) RETURNING id", PG, "RETURNING"));
        assert!(!has_top_level_keyword("UPDATE t SET note = 'returning' WHERE id = 1", PG, "RETURNING"));
        assert!(!has_top_level_keyword("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", PG, "RETURNING"));
        assert!(!has_top_level_keyword("UPDATE t SET a = 1 -- returning", PG, "RETURNING"));
    }

    #[test]
    fn test_split_basic() {
        assert_eq!(split("SELECT 1; SELECT 2;", MY), ["SELECT 1", "SELECT 2"]);
        assert_eq!(split("SELECT 1", PG), ["SELECT 1"]);
        assert_eq!(split("", PG), Vec::<String>::new());
    }

    #[test]
    fn test_split_respects_literals_and_comments() {
        assert_eq!(split("SELECT 'a;b'; SELECT \"c;d\"", PG), ["SELECT 'a;b'", "SELECT \"c;d\""]);
        assert_eq!(split("SELECT `a;b` FROM t; SELECT 2", MY), ["SELECT `a;b` FROM t", "SELECT 2"]);
        assert_eq!(split("SELECT 1 -- x; y\n; SELECT 2", PG), ["SELECT 1 -- x; y", "SELECT 2"]);
        assert_eq!(split("SELECT 1 /* a; b */; SELECT 2", LITE), ["SELECT 1 /* a; b */", "SELECT 2"]);
        assert_eq!(split("SELECT [a;b] FROM t; SELECT 2", LITE), ["SELECT [a;b] FROM t", "SELECT 2"]);
    }

    #[test]
    fn test_split_dialect_escapes() {
        // MySQL: `\\` closes before the quote; `\'` doesn't.
        assert_eq!(split(r"SELECT 'C:\\'; SELECT 2", MY), [r"SELECT 'C:\\'", "SELECT 2"]);
        assert_eq!(split(r"SELECT 'it\'s;'; SELECT 2", MY), [r"SELECT 'it\'s;'", "SELECT 2"]);
        // Postgres / SQLite: backslash is literal, except in E-strings.
        assert_eq!(split(r"SELECT 'C:\'; SELECT 2", PG), [r"SELECT 'C:\'", "SELECT 2"]);
        assert_eq!(split(r"SELECT 'C:\'; SELECT 2", LITE), [r"SELECT 'C:\'", "SELECT 2"]);
        assert_eq!(split(r"SELECT E'a\'b;'; SELECT 2", PG), [r"SELECT E'a\'b;'", "SELECT 2"]);
        // MySQL `5--3` is arithmetic, so the `;` after it splits.
        assert_eq!(split("SELECT 5--3; SELECT 2", MY), ["SELECT 5--3", "SELECT 2"]);
    }

    #[test]
    fn test_split_postgres_dollar_quotes_and_nested_comments() {
        let f = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'a;b'; END $$ LANGUAGE plpgsql";
        assert_eq!(split(&format!("{f}; SELECT 1"), PG), [f, "SELECT 1"]);
        let g = "CREATE FUNCTION g() RETURNS void AS $fn$ BEGIN PERFORM 1; END $fn$ LANGUAGE plpgsql";
        assert_eq!(split(&format!("{g};"), PG), [g]);
        assert_eq!(split("SELECT 1 /* x /* y */ ; */; SELECT 2", PG), ["SELECT 1 /* x /* y */ ; */", "SELECT 2"]);
    }

    #[test]
    fn test_split_mysql_delimiter() {
        let script = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END //\nDELIMITER ;\nSELECT 3;\nSELECT 4;";
        assert_eq!(
            split(script, MY),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END", "SELECT 3", "SELECT 4"]
        );
        // Delimiter glued to a word, and mysqldump's `;;`.
        let dump = "delimiter $$\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END$$\ndelimiter ;\nSELECT 1";
        assert_eq!(
            split(dump, MY),
            ["CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END", "SELECT 1"]
        );
        let dump2 = "DELIMITER ;;\nCREATE PROCEDURE q() BEGIN SELECT 1; END ;;\nDELIMITER ;";
        assert_eq!(split(dump2, MY), ["CREATE PROCEDURE q() BEGIN SELECT 1; END"]);
        // `DELIMITER` mid-statement or inside a literal is just text.
        assert_eq!(split("SELECT 'x\nDELIMITER //'; SELECT 2", MY), ["SELECT 'x\nDELIMITER //'", "SELECT 2"]);
        // Only MySQL knows the client command.
        assert_eq!(split("DELIMITER //\nSELECT 1 //", PG), ["DELIMITER //\nSELECT 1 //"]);
    }

    #[test]
    fn test_split_sqlite_trigger_body() {
        let trigger = "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a = CASE WHEN 1 THEN 2 END; DELETE FROM z; END";
        assert_eq!(split(&format!("{trigger}; SELECT 1"), LITE), [trigger, "SELECT 1"]);
        let temp = "CREATE TEMP TRIGGER t2 AFTER DELETE ON x BEGIN SELECT 1; END";
        assert_eq!(split(&format!("{temp};"), LITE), [temp]);
        // Outside triggers BEGIN/END are transactions and split normally.
        assert_eq!(split("BEGIN; SELECT 1; END;", LITE), ["BEGIN", "SELECT 1", "END"]);
    }

    #[test]
    fn test_split_drops_comment_only_pieces() {
        assert_eq!(split("SELECT 1; -- trailing note\n", MY), ["SELECT 1"]);
        assert_eq!(split("SELECT 1;\u{3000}\u{00A0}", PG), ["SELECT 1"]);
        assert_eq!(split("/* header */ ; SELECT 1", PG), ["SELECT 1"]);
        // A MySQL executable comment is code.
        assert_eq!(split("/*!40101 SET NAMES utf8 */; SELECT 1", MY), ["/*!40101 SET NAMES utf8 */", "SELECT 1"]);
        // Leading comments stay attached to their statement.
        assert_eq!(split("-- list users\nSELECT 1", PG), ["-- list users\nSELECT 1"]);
    }
}
