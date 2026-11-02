//! Safe query row-limit handling for SQL queries.
//!
//! Rather than blindly appending `LIMIT N` onto whatever query the user wrote
//! (which breaks `SHOW`, `DESCRIBE`, `EXPLAIN`, `PRAGMA`, `FOR UPDATE`,
//! queries ending with semicolons, line comments, etc.), this module inspects
//! the statement and only injects `LIMIT` when safe to do so.
//!
//! Inspection runs on the dialect-aware masked copy from [`crate::sql_lex`],
//! so `'limit 5'`, `` `limit` `` or `-- limit` never read as clauses. Only
//! clauses at paren depth 0 count — a `LIMIT` inside a subquery doesn't bound
//! the outer result.

use crate::manifest::SqlDialect;
use crate::sql_lex::{is_sql_space, is_word_byte, mask_sql_literals_and_comments, tokenize};
use crate::types::MAX_RESULT_ROWS;

/// Prepares a query for execution by checking if a row limit can safely be
/// appended to the SQL string.
///
/// Returns a tuple of:
/// - `effective_sql`: the SQL to execute (either with `LIMIT {cap}` appended, or unmodified).
/// - `can_be_truncated`: true only if a `LIMIT` clause was safely injected and could cap the results.
pub fn prepare_capped_query(
    sql: &str,
    row_limit: Option<u32>,
    dialect: SqlDialect,
) -> (String, bool) {
    // If row_limit is explicitly Some(0), the user/caller requested Unlimited — do not cap!
    if row_limit == Some(0) {
        return (sql.to_string(), false);
    }
    let cap = row_limit.unwrap_or(MAX_RESULT_ROWS);

    match cappable_select_body(sql, dialect) {
        Some(body) => (format!("{body}\nLIMIT {cap}"), true),
        None => (sql.to_string(), false),
    }
}

/// Returns the statement body a trailing `LIMIT` can be appended to, or `None`
/// when the statement must run untouched. The body is the original text cut
/// right after its last significant token, so trailing semicolons and comments
/// are dropped and can't swallow the appended clause.
///
/// A statement is cappable when it is a single row-returning query — `SELECT`,
/// `WITH … SELECT`, `TABLE t`, `VALUES …`, or one of those in parentheses
/// (`(SELECT …) UNION (SELECT …)`) — with no top-level `LIMIT` (or, where they
/// are reserved words, `OFFSET` / `FETCH`) of its own, no `INTO` target
/// (`SELECT … INTO new_table` would silently copy only the capped rows), and no
/// trailing locking or `PROCEDURE` clause that `LIMIT` can't follow.
fn cappable_select_body(sql: &str, dialect: SqlDialect) -> Option<&str> {
    let sql = &sql[sql.bytes().position(|b| !is_sql_space(b)).unwrap_or(sql.len())..];
    let masked = mask_sql_literals_and_comments(sql, dialect);

    // End of the last significant byte: trailing whitespace, `;` and (already
    // masked) comments don't count.
    let end = masked
        .iter()
        .rposition(|&b| !is_sql_space(b) && b != b';')?
        + 1;
    // A `;` before the end means more than one statement.
    if masked[..end].contains(&b';') {
        return None;
    }
    // SQLite takes LIMIT only on SELECT — not after a bare VALUES — and has no
    // parenthesized top-level queries.
    let sqlite = matches!(dialect, SqlDialect::Sqlite);
    // Only opening parens may come before the first keyword.
    let first_word_at = masked[..end].iter().position(|&b| is_word_byte(b))?;
    if masked[..first_word_at]
        .iter()
        .any(|&b| !is_sql_space(b) && (b != b'(' || sqlite))
    {
        return None;
    }

    let words = tokenize(&masked[..end]);
    let first = words.first()?;
    let main = if first.text == "WITH" {
        // `WITH …` must feed a query, not INSERT/UPDATE/DELETE/MERGE.
        words[1..].iter().find(|w| {
            w.depth == first.depth
                && matches!(
                    w.text.as_str(),
                    "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "VALUES" | "TABLE"
                )
        })?
    } else {
        first
    };
    let returns_rows = match main.text.as_str() {
        "SELECT" => true,
        "TABLE" | "VALUES" => !sqlite,
        _ => false,
    };
    if !returns_rows {
        return None;
    }

    // MySQL and SQLite only accept OFFSET after LIMIT and have no FETCH clause,
    // so there the words are plain identifiers (`SELECT t.offset FROM t`).
    let paging_words: &[&str] = match dialect {
        SqlDialect::Mysql | SqlDialect::Sqlite => &["LIMIT"],
        _ => &["LIMIT", "OFFSET", "FETCH"],
    };
    let top: Vec<&str> = words
        .iter()
        .filter(|w| w.depth == 0)
        .map(|w| w.text.as_str())
        .collect();
    for (i, word) in top.iter().enumerate() {
        let next = top.get(i + 1).copied().unwrap_or("");
        let blocks = match *word {
            // The query already pages itself — respect the user's bounds.
            w if paging_words.contains(&w) => true,
            // SELECT … INTO @var / OUTFILE / DUMPFILE (MySQL), SELECT … INTO
            // new_table (Postgres).
            "INTO" => true,
            // FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE.
            "FOR" => matches!(next, "UPDATE" | "SHARE" | "NO" | "KEY"),
            // LOCK IN SHARE MODE (MySQL).
            "LOCK" => next == "IN",
            // PROCEDURE ANALYSE (MySQL 5.x).
            "PROCEDURE" => true,
            _ => false,
        };
        if blocks {
            return None;
        }
    }

    Some(&sql[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: SqlDialect = SqlDialect::Mysql;
    const PG: SqlDialect = SqlDialect::Postgres;
    const LITE: SqlDialect = SqlDialect::Sqlite;

    fn capped(sql: &str, dialect: SqlDialect) -> String {
        let (res, truncated) = prepare_capped_query(sql, None, dialect);
        assert!(truncated, "expected {sql:?} to be capped, got {res:?}");
        res
    }

    fn untouched(sql: &str, dialect: SqlDialect) {
        let (res, truncated) = prepare_capped_query(sql, None, dialect);
        assert_eq!(res, sql, "expected {sql:?} to run unmodified");
        assert!(!truncated);
    }

    #[test]
    fn test_show_statements_not_capped() {
        untouched("SHOW SESSION VARIABLES;", MY);
        untouched("SHOW TABLES", MY);
        untouched("SHOW CREATE TABLE users;", MY);
        untouched("SHOW GLOBAL STATUS;", MY);
        untouched("SHOW VARIABLES LIKE 'max_connections'", MY);
        untouched("SHOW VARIABLES LIKE A", MY);
        untouched("SHOW search_path", PG);
    }

    #[test]
    fn test_describe_and_explain_not_capped() {
        untouched("DESCRIBE users;", MY);
        untouched("DESC users;", MY);
        untouched("EXPLAIN SELECT * FROM users;", MY);
        untouched("EXPLAIN ANALYZE SELECT * FROM users;", PG);
        untouched("EXPLAIN QUERY PLAN SELECT * FROM users", LITE);
    }

    #[test]
    fn test_pragma_not_capped() {
        untouched("PRAGMA table_info('users');", LITE);
    }

    #[test]
    fn test_plain_select_capped_cleanly() {
        assert_eq!(capped("SELECT * FROM users", MY), "SELECT * FROM users\nLIMIT 10000");

        // Strips trailing semicolon so `; LIMIT` syntax error doesn't happen
        assert_eq!(capped("SELECT * FROM users;", MY), "SELECT * FROM users\nLIMIT 10000");
        assert_eq!(capped("SELECT * FROM users ; ; \n", PG), "SELECT * FROM users\nLIMIT 10000");

        // Preserves custom limit when passed
        let (res, truncated) = prepare_capped_query("SELECT * FROM users;", Some(500), MY);
        assert_eq!(res, "SELECT * FROM users\nLIMIT 500");
        assert!(truncated);

        // Lowercase / leading whitespace / parenthesised select list.
        assert_eq!(capped("  select(1)", LITE), "select(1)\nLIMIT 10000");
    }

    #[test]
    fn test_unlimited_mode_not_capped() {
        let (res, truncated) = prepare_capped_query("SELECT * FROM users;", Some(0), MY);
        assert_eq!(res, "SELECT * FROM users;");
        assert!(!truncated);
    }

    #[test]
    fn test_trailing_comments_dropped() {
        assert_eq!(capped("SELECT * FROM users -- comment", MY), "SELECT * FROM users\nLIMIT 10000");
        assert_eq!(capped("SELECT * FROM users; -- comment", MY), "SELECT * FROM users\nLIMIT 10000");
        assert_eq!(capped("SELECT * FROM users /* c */ ;", PG), "SELECT * FROM users\nLIMIT 10000");
        assert_eq!(capped("SELECT * FROM users # comment", MY), "SELECT * FROM users\nLIMIT 10000");
        assert_eq!(
            capped("-- header\n/* note */ SELECT 1", PG),
            "-- header\n/* note */ SELECT 1\nLIMIT 10000"
        );
    }

    #[test]
    fn test_existing_limit_or_offset_not_capped() {
        untouched("SELECT * FROM users LIMIT 10;", MY);
        untouched("SELECT * FROM users\nlimit 10", MY);
        untouched("SELECT * FROM users OFFSET 5;", PG);
        untouched("SELECT * FROM users FETCH FIRST 10 ROWS ONLY;", PG);
        untouched("SELECT * FROM users LIMIT 10 OFFSET 20", LITE);
    }

    #[test]
    fn test_offset_and_fetch_are_identifiers_in_mysql_and_sqlite() {
        capped("SELECT t.offset, t.fetch FROM t", MY);
        capped("SELECT offset FROM t", LITE);
        untouched("SELECT t.offset FROM t", PG);
    }

    #[test]
    fn test_limit_only_in_subquery_still_capped() {
        assert_eq!(
            capped("SELECT * FROM (SELECT * FROM users LIMIT 5) u", MY),
            "SELECT * FROM (SELECT * FROM users LIMIT 5) u\nLIMIT 10000"
        );
        capped("SELECT *, (SELECT id FROM t ORDER BY id LIMIT 1) AS first_id FROM users", PG);
    }

    #[test]
    fn test_locking_clauses_not_capped() {
        untouched("SELECT * FROM users FOR UPDATE;", MY);
        untouched("SELECT * FROM users FOR SHARE;", PG);
        untouched("SELECT * FROM users FOR NO KEY UPDATE", PG);
        untouched("SELECT * FROM users FOR KEY SHARE", PG);
        untouched("SELECT * FROM users FOR UPDATE SKIP LOCKED", MY);
        untouched("SELECT * FROM users LOCK IN SHARE MODE;", MY);
    }

    #[test]
    fn test_into_targets_not_capped() {
        untouched("SELECT * INTO backup_users FROM users", PG);
        untouched("SELECT id INTO @last_id FROM users ORDER BY id DESC", MY);
        untouched("SELECT * FROM users INTO OUTFILE '/tmp/u.csv'", MY);
        untouched("SELECT * FROM users INTO DUMPFILE '/tmp/u.bin'", MY);
    }

    #[test]
    fn test_literal_with_limit_keyword() {
        // 'limit exceeded' inside literal shouldn't count as LIMIT clause
        assert_eq!(
            capped("SELECT * FROM users WHERE status = 'limit exceeded';", MY),
            "SELECT * FROM users WHERE status = 'limit exceeded'\nLIMIT 10000"
        );
        capped("SELECT `limit` FROM t", MY);
        capped("SELECT \"limit\" FROM t", PG);
        capped("SELECT [limit] FROM t", LITE);
        capped("SELECT $$ LIMIT 5 $$ AS s", PG);
        capped("SELECT $q$ it's LIMIT 5 $q$ AS s", PG);
    }

    #[test]
    fn test_mysql_backslash_escapes() {
        // `\'` doesn't close the literal, `\\` before the quote does.
        untouched(r"SELECT 'it\'s' AS s FROM t LIMIT 5", MY);
        untouched(r"SELECT * FROM t WHERE path = 'C:\\' LIMIT 5", MY);
        capped(r"SELECT 'C:\\' AS p, 'x LIMIT 1' AS q FROM t", MY);
    }

    #[test]
    fn test_postgres_strings_have_no_backslash_escapes() {
        // Standard strings: `\` is literal, so `'C:\'` is complete.
        untouched(r"SELECT 'C:\' AS p FROM t LIMIT 5", PG);
        // E-strings do escape.
        untouched(r"SELECT E'it\'s' AS s FROM t LIMIT 5", PG);
        untouched(r"SELECT 'it''s' AS s FROM t LIMIT 5", PG);
    }

    #[test]
    fn test_postgres_hash_operators_are_not_comments() {
        untouched("SELECT data #>> '{a,b}' FROM t LIMIT 5", PG);
        untouched("SELECT data #> '{a}', 5 # 3 FROM t LIMIT 5", PG);
        assert_eq!(
            capped("SELECT data #>> '{a}' FROM t", PG),
            "SELECT data #>> '{a}' FROM t\nLIMIT 10000"
        );
    }

    #[test]
    fn test_line_comment_ends_at_bare_cr_in_postgres() {
        // Postgres ends `--` comments at `\r` as well as `\n`: the WHERE and
        // LIMIT after it are real code.
        untouched("SELECT * FROM users -- note\rLIMIT 5", PG);
        assert_eq!(
            capped("SELECT * FROM users -- note\rWHERE id = 1", PG),
            "SELECT * FROM users -- note\rWHERE id = 1\nLIMIT 10000"
        );
        // MySQL and SQLite only end them at `\n`.
        assert_eq!(capped("SELECT * FROM users -- note\rLIMIT 5", MY), "SELECT * FROM users\nLIMIT 10000");
    }

    #[test]
    fn test_whitespace_matches_editor_lexer() {
        // Vertical tab / form feed are whitespace; non-ASCII spaces are not.
        assert_eq!(capped("\x0B\x0CSELECT 1;\x0B", MY), "SELECT 1\nLIMIT 10000");
        untouched("\u{0085}SELECT * FROM t", MY);
        untouched("\u{00A0}SELECT * FROM t", PG);
    }

    #[test]
    fn test_postgres_nested_comments() {
        untouched("SELECT 1 /* outer /* inner */ still comment */ FROM t LIMIT 5", PG);
    }

    #[test]
    fn test_dollar_in_identifiers() {
        // MySQL allows `$` in identifiers; Postgres too (not as first char).
        untouched("SELECT a$b$c FROM t LIMIT 5", MY);
        untouched("SELECT a$b$c FROM t LIMIT 5", PG);
        // `$1` is a parameter, not a dollar-quote tag.
        untouched("SELECT * FROM t WHERE id = $1 LIMIT 5", PG);
    }

    #[test]
    fn test_mysql_double_dash_needs_space() {
        // `5--3` is arithmetic in MySQL, not a comment.
        untouched("SELECT 5--3 FROM t LIMIT 5", MY);
    }

    #[test]
    fn test_mysql_executable_comments_are_code() {
        untouched("SELECT * FROM t /*!50000 LIMIT 5 */", MY);
        capped("SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t", MY);
        // The closing `*/` must survive the cut.
        assert_eq!(capped("/*!50000 SELECT 1 */", MY), "/*!50000 SELECT 1 */\nLIMIT 10000");
        assert_eq!(capped("/*!50000 SELECT 1 */ ;", MY), "/*!50000 SELECT 1 */\nLIMIT 10000");
        assert_eq!(
            capped("SELECT * FROM t /*!50000 WHERE id > 1 */ -- c", MY),
            "SELECT * FROM t /*!50000 WHERE id > 1 */\nLIMIT 10000"
        );
    }

    #[test]
    fn test_multibyte_text_keeps_offsets() {
        assert_eq!(
            capped("SELECT 'héllo 🌍' AS s, naïve FROM t -- ünïcode", PG),
            "SELECT 'héllo 🌍' AS s, naïve FROM t\nLIMIT 10000"
        );
    }

    #[test]
    fn test_with_cte() {
        assert_eq!(
            capped("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;", PG),
            "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte\nLIMIT 10000"
        );
        untouched("WITH cte AS (SELECT 1 AS id) INSERT INTO target SELECT * FROM cte;", PG);
        untouched("WITH cte AS (SELECT 1 AS id) UPDATE t SET x = 1", MY);
        untouched("WITH cte AS (SELECT 1 AS id) DELETE FROM t", MY);

        // CTE names containing keywords must not be mistaken for the main verb.
        capped(
            "WITH last_update AS (SELECT 1 AS id), select_x AS (SELECT 2) SELECT * FROM last_update",
            PG,
        );
        capped("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r", PG);
        untouched("WITH cte AS (SELECT * FROM t LIMIT 3) SELECT * FROM cte LIMIT 2", MY);
    }

    #[test]
    fn test_table_values_and_parenthesized_queries_capped() {
        assert_eq!(capped("TABLE users", PG), "TABLE users\nLIMIT 10000");
        assert_eq!(capped("VALUES (1), (2);", PG), "VALUES (1), (2)\nLIMIT 10000");
        capped("VALUES ROW(1, 2), ROW(3, 4)", MY);
        assert_eq!(
            capped("(SELECT 1) UNION (SELECT 2)", MY),
            "(SELECT 1) UNION (SELECT 2)\nLIMIT 10000"
        );
        capped("((SELECT id FROM t LIMIT 5))", PG);
        untouched("(SELECT 1) UNION (SELECT 2) LIMIT 1", MY);
        untouched("TABLE users LIMIT 5", PG);
        // SQLite rejects LIMIT after a bare VALUES and has no parenthesized queries.
        untouched("VALUES (1), (2)", LITE);
        untouched("(SELECT 1)", LITE);
    }

    #[test]
    fn test_non_select_statements_untouched() {
        untouched("INSERT INTO t SELECT * FROM u", MY);
        untouched("(1)", PG);
        untouched("SELECT 1; SELECT 2", MY);
        untouched("CALL p()", MY);
        untouched("", MY);
        untouched("   -- only a comment", PG);
    }

    #[test]
    fn test_union_capped_as_a_whole() {
        assert_eq!(
            capped("SELECT 1 UNION ALL SELECT 2", LITE),
            "SELECT 1 UNION ALL SELECT 2\nLIMIT 10000"
        );
    }
}
