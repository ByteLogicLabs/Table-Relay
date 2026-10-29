//! SQL statement classification into coarse operation tiers, used to drive
//! per-tier auto-approval and approval-card badging.

use serde::Serialize;

/// Coarse operation class for a single SQL/command statement. Drives
/// per-tier auto-approval: the user can let the model run reads silently
/// while still being prompted before writes or schema changes. `Destructive`
/// is the irreversible subset (no-WHERE DELETE/UPDATE, DROP, TRUNCATE) and
/// is NEVER auto-approvable — it always requires an explicit prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryTier {
    Read,        // SELECT / SHOW / EXPLAIN / WITH-cte SELECT, Mongo find/aggregate, Redis GET
    Write,       // INSERT / UPDATE (with WHERE), Mongo insert/update, Redis SET
    Create,      // CREATE TABLE/INDEX/VIEW/DATABASE, Mongo createCollection/createIndex
    Delete,      // DELETE (with WHERE), Mongo deleteOne/deleteMany(filter), Redis DEL
    Destructive, // no-WHERE DELETE/UPDATE, DROP, TRUNCATE, Mongo drop/dropDatabase
}

impl QueryTier {
    /// Short human label for the approval card badge.
    pub fn label(self) -> &'static str {
        match self {
            QueryTier::Read => "READ",
            QueryTier::Write => "WRITE",
            QueryTier::Create => "CREATE",
            QueryTier::Delete => "DELETE",
            QueryTier::Destructive => "DESTRUCTIVE",
        }
    }
}

/// Does this statement contain a top-level WHERE clause? Crude but adequate:
/// we only need it to distinguish "DELETE FROM t" from "DELETE FROM t WHERE …".
/// A WHERE that only appears inside a parenthesised subquery still counts as
/// "no top-level WHERE" so we err toward treating it as destructive.
fn has_top_level_where(upper: &str) -> bool {
    let bytes = upper.as_bytes();
    let mut depth: i32 = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth = (depth - 1).max(0),
            b'W' if depth == 0 => {
                // word-boundary match for "WHERE"
                if upper[i..].starts_with("WHERE") {
                    let before = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
                    let after = i + 5 >= bytes.len() || !bytes[i + 5].is_ascii_alphanumeric();
                    if before && after {
                        return true;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Strip a leading `WITH <cte> AS (...)` prefix so the real verb (which may be
/// `DELETE`/`UPDATE`/`INSERT` after a CTE) is what we classify.
fn strip_leading_cte(upper: &str) -> &str {
    let trimmed = upper.trim_start();
    if !trimmed.starts_with("WITH") {
        return trimmed;
    }
    // Walk past balanced parens of the CTE list; the statement verb follows
    // the last `)` before a top-level keyword. Cheap heuristic: find the first
    // top-level DML/DDL keyword after depth returns to 0.
    let bytes = trimmed.as_bytes();
    let mut depth: i32 = 0;
    let mut i = 4; // past "WITH"
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth = (depth - 1).max(0),
            _ if depth == 0 => {
                for kw in ["SELECT", "INSERT", "UPDATE", "DELETE"] {
                    if trimmed[i..].starts_with(kw) {
                        return &trimmed[i..];
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    trimmed
}

/// Classify a single SQL statement. Used for SQL-dialect adapters; Mongo/Redis
/// pass through `classify_native` instead.
pub fn classify_sql(sql: &str) -> QueryTier {
    let upper_full = sql.trim().to_ascii_uppercase();
    let upper = strip_leading_cte(&upper_full);

    let starts = |kw: &str| upper.starts_with(kw);

    // Irreversible structural changes first.
    if starts("DROP ") || starts("TRUNCATE") {
        return QueryTier::Destructive;
    }
    if starts("ALTER") {
        // ALTER ... DROP <col/constraint> is destructive; other ALTERs are DDL.
        return if upper.contains(" DROP ") { QueryTier::Destructive } else { QueryTier::Create };
    }
    if starts("CREATE") {
        return QueryTier::Create;
    }
    if starts("DELETE") {
        return if has_top_level_where(upper) { QueryTier::Delete } else { QueryTier::Destructive };
    }
    if starts("UPDATE") {
        return if has_top_level_where(upper) { QueryTier::Write } else { QueryTier::Destructive };
    }
    if starts("INSERT") || starts("REPLACE") || starts("UPSERT") || starts("MERGE") {
        return QueryTier::Write;
    }
    // SELECT / SHOW / EXPLAIN / DESCRIBE / WITH-select / PRAGMA / etc.
    QueryTier::Read
}

/// Highest (most dangerous) tier across all `;`-separated statements in a
/// batch. Ordering: Destructive > Delete > Create > Write > Read. A batch is
/// gated at its strongest tier so a sneaky `SELECT 1; DROP TABLE x` can't ride
/// in under the Read permission.
pub fn classify_batch(sql: &str) -> QueryTier {
    fn rank(t: QueryTier) -> u8 {
        match t {
            QueryTier::Read => 0,
            QueryTier::Write => 1,
            QueryTier::Create => 2,
            QueryTier::Delete => 3,
            QueryTier::Destructive => 4,
        }
    }
    split_statements_lenient(sql)
        .into_iter()
        .map(|s| classify_sql(&s))
        .max_by_key(|t| rank(*t))
        .unwrap_or(QueryTier::Read)
}

/// Split on `;` while respecting single/double quotes and backtick identifiers.
/// Good enough for tier classification (we don't need perfect statement
/// boundaries, only to not mistake a `;` inside a string literal for a split).
fn split_statements_lenient(sql: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let (mut sq, mut dq, mut bq) = (false, false, false);
    let mut prev = '\0';
    for ch in sql.chars() {
        match ch {
            '\'' if !dq && !bq && prev != '\\' => { sq = !sq; cur.push(ch); }
            '"' if !sq && !bq && prev != '\\' => { dq = !dq; cur.push(ch); }
            '`' if !sq && !dq => { bq = !bq; cur.push(ch); }
            ';' if !sq && !dq && !bq => {
                if !cur.trim().is_empty() { parts.push(cur.trim().to_string()); }
                cur.clear();
            }
            _ => cur.push(ch),
        }
        prev = ch;
    }
    if !cur.trim().is_empty() { parts.push(cur.trim().to_string()); }
    if parts.is_empty() { parts.push(sql.trim().to_string()); }
    parts
}

#[cfg(test)]
mod tier_tests {
    use super::*;

    #[test]
    fn classifies_core_verbs() {
        assert_eq!(classify_sql("SELECT * FROM users"), QueryTier::Read);
        assert_eq!(classify_sql("  show tables"), QueryTier::Read);
        assert_eq!(classify_sql("INSERT INTO t VALUES (1)"), QueryTier::Write);
        assert_eq!(classify_sql("UPDATE t SET a=1 WHERE id=2"), QueryTier::Write);
        assert_eq!(classify_sql("DELETE FROM t WHERE id=2"), QueryTier::Delete);
        assert_eq!(classify_sql("CREATE TABLE t (id int)"), QueryTier::Create);
        assert_eq!(classify_sql("CREATE INDEX i ON t(a)"), QueryTier::Create);
    }

    #[test]
    fn no_where_mutations_are_destructive() {
        assert_eq!(classify_sql("DELETE FROM t"), QueryTier::Destructive);
        assert_eq!(classify_sql("UPDATE t SET a=1"), QueryTier::Destructive);
        assert_eq!(classify_sql("DROP TABLE t"), QueryTier::Destructive);
        assert_eq!(classify_sql("TRUNCATE t"), QueryTier::Destructive);
        assert_eq!(classify_sql("ALTER TABLE t DROP COLUMN a"), QueryTier::Destructive);
    }

    #[test]
    fn subquery_where_does_not_save_a_bare_update() {
        // The only WHERE is inside the subquery → still destructive.
        assert_eq!(
            classify_sql("UPDATE t SET a=(SELECT x FROM y WHERE y.id=1)"),
            QueryTier::Destructive
        );
    }

    #[test]
    fn cte_fronted_delete_is_classified_by_real_verb() {
        assert_eq!(
            classify_sql("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT 1)"),
            QueryTier::Delete
        );
    }

    #[test]
    fn batch_takes_strongest_tier() {
        assert_eq!(classify_batch("SELECT 1; DROP TABLE x"), QueryTier::Destructive);
        assert_eq!(classify_batch("SELECT 1; INSERT INTO t VALUES (1)"), QueryTier::Write);
    }
}
