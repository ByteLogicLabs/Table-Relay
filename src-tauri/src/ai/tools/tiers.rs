//! Statement classification into coarse operation tiers, used to drive
//! per-tier auto-approval and approval-card badging.
//!
//! The rule that matters: a statement is only `Read` when we positively know
//! it reads. Anything unrecognised, opaque (procedures, `DO` blocks, scripts)
//! or able to change privileges or server state lands in `Destructive`, which
//! is never auto-approved. The previous classifier looked at the raw text's
//! first word, so a leading comment, a newline after `DROP`, `EXPLAIN ANALYZE
//! DELETE`, `GRANT`, `SET GLOBAL`, and every Mongo / Redis command all came
//! out as `Read` — runnable without a prompt once reads were auto-approved.

use adapter_api::SqlDialect;
use serde::Serialize;

/// Coarse operation class for a single SQL/command statement. Drives
/// per-tier auto-approval: the user can let the model run reads silently
/// while still being prompted before writes or schema changes. `Destructive`
/// is the irreversible subset (no-WHERE DELETE/UPDATE, DROP, TRUNCATE) and
/// is NEVER auto-approvable — it always requires an explicit prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryTier {
    Read,        // SELECT / SHOW / EXPLAIN / WITH-cte SELECT, Mongo find/aggregate, Redis GET
    Write,       // INSERT / UPDATE (with WHERE), Mongo insert/update, Redis SET
    Create,      // CREATE TABLE/INDEX/VIEW/DATABASE, Mongo createCollection/createIndex
    Delete,      // DELETE (with WHERE), Mongo deleteOne/deleteMany(filter), Redis DEL
    Destructive, // no-WHERE DELETE/UPDATE, DROP, TRUNCATE, privileges, opaque code
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

/// What language a `call_query` command is written in.
#[derive(Debug, Clone, Copy)]
pub enum CommandLanguage {
    Sql(SqlDialect),
    Mongo,
    Redis,
    /// A store we have no classifier for — nothing is ever treated as a read.
    Unknown,
}

/// Highest (most dangerous) tier across every statement in a batch, so a
/// sneaky `SELECT 1; DROP TABLE x` can't ride in under the Read permission.
pub fn classify_batch(command: &str, lang: CommandLanguage) -> QueryTier {
    match lang {
        CommandLanguage::Sql(dialect) => adapter_api::split_sql_statements(command, dialect)
            .iter()
            .map(|s| classify_sql(s, dialect))
            .max()
            .unwrap_or(QueryTier::Read),
        CommandLanguage::Mongo => classify_mongo(command),
        CommandLanguage::Redis => command
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .map(classify_redis)
            .max()
            .unwrap_or(QueryTier::Read),
        CommandLanguage::Unknown => QueryTier::Destructive,
    }
}

/// Classify one SQL statement.
pub fn classify_sql(sql: &str, dialect: SqlDialect) -> QueryTier {
    let words = adapter_api::code_words(sql, dialect);
    if words.is_empty() {
        return QueryTier::Read; // only comments / whitespace
    }
    // The first word is the verb even inside parens: `(SELECT …) UNION (…)`.
    classify_words(&words)
}

fn classify_words(words: &[(String, u32)]) -> QueryTier {
    use QueryTier::*;
    let Some((verb, depth)) = words.first() else { return Read };
    let depth = *depth;
    let rest = &words[1..];
    // Words of this statement's own clauses (not inside subqueries).
    let at_level = |w: &str| rest.iter().any(|(x, d)| *d == depth && x == w);
    let anywhere = |w: &str| rest.iter().any(|(x, _)| x == w);
    let next = rest.first().map(|(w, _)| w.as_str()).unwrap_or("");

    match verb.as_str() {
        "SELECT" | "TABLE" | "VALUES" => {
            if at_level("INTO") {
                // MySQL `INTO OUTFILE` writes a server file; Postgres
                // `SELECT … INTO t` creates a table.
                Create
            } else if at_level("FOR") && (at_level("UPDATE") || at_level("SHARE")) || at_level("LOCK") {
                Write
            } else {
                Read
            }
        }
        "WITH" => {
            // A data-modifying CTE (`WITH d AS (DELETE …) SELECT …`) runs
            // whatever the main verb is — treat any write inside as serious.
            if ["DELETE", "UPDATE", "INSERT", "MERGE"].iter().any(|v| words.iter().any(|(w, d)| *d > depth && w == v)) {
                return Destructive;
            }
            match rest.iter().position(|(w, d)| *d == depth && matches!(w.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "VALUES" | "TABLE")) {
                Some(i) => classify_words(&rest[i..]),
                None => Destructive,
            }
        }
        "SHOW" | "DESCRIBE" | "DESC" | "USE" | "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "END" => Read,
        "PRAGMA" => {
            if pragma_assigns(words) { Write } else { Read }
        }
        "EXPLAIN" => {
            // Plain EXPLAIN only plans. EXPLAIN ANALYZE (Postgres; also MySQL
            // for SELECT) actually executes the statement it explains.
            if anywhere("ANALYZE") || anywhere("ANALYSE") {
                match rest.iter().position(|(w, d)| *d == depth && is_statement_verb(w)) {
                    Some(i) => classify_words(&rest[i..]),
                    None => Read,
                }
            } else {
                Read
            }
        }
        "INSERT" | "REPLACE" | "UPSERT" => Write,
        "MERGE" => {
            if anywhere("DELETE") { Delete } else { Write }
        }
        "UPDATE" => {
            if at_level("WHERE") { Write } else { Destructive }
        }
        "DELETE" => {
            if at_level("WHERE") { Delete } else { Destructive }
        }
        "CREATE" => {
            if matches!(next, "USER" | "ROLE") { Destructive } else { Create }
        }
        "ALTER" => {
            if at_level("DROP") || at_level("RENAME") || matches!(next, "USER" | "ROLE") {
                Destructive
            } else {
                Create
            }
        }
        "SET" => {
            if matches!(next, "GLOBAL" | "PERSIST" | "PERSIST_ONLY" | "PASSWORD") { Destructive } else { Write }
        }
        "VACUUM" | "ANALYZE" | "OPTIMIZE" | "REINDEX" | "CLUSTER" | "LOCK" | "UNLOCK" | "LOAD" | "COPY" | "COMMENT" | "CHECKSUM" | "CHECK" | "REPAIR" => Write,
        // DROP, TRUNCATE, RENAME, GRANT, REVOKE, KILL, CALL, DO, EXEC, EXECUTE,
        // FLUSH, RESET, PURGE, SHUTDOWN, INSTALL … and anything we don't know.
        _ => Destructive,
    }
}

fn is_statement_verb(w: &str) -> bool {
    matches!(w, "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "VALUES" | "TABLE" | "CREATE" | "REPLACE")
}

/// Whether a SQLite `PRAGMA` sets a value (`PRAGMA foreign_keys = OFF`) rather
/// than reads one (`PRAGMA foreign_keys`, `PRAGMA table_info(t)`). `=` isn't a
/// word, so an assignment shows up as a depth-0 word after the pragma name.
fn pragma_assigns(words: &[(String, u32)]) -> bool {
    let top: Vec<&str> = words.iter().filter(|(_, d)| *d == 0).map(|(w, _)| w.as_str()).collect();
    // ["PRAGMA", name, value?] or ["PRAGMA", schema, name, value?]
    let qualified = matches!(top.get(1), Some(&"MAIN") | Some(&"TEMP"));
    top.len() > if qualified { 3 } else { 2 }
}

// ---- MongoDB ------------------------------------------------------------

/// Classify a Mongo shell command by the methods it calls.
fn classify_mongo(command: &str) -> QueryTier {
    use QueryTier::*;
    let code = mask_js_strings(command);
    let mut tier: Option<QueryTier> = None;
    let mut bump = |t: QueryTier| tier = Some(tier.map_or(t, |cur| cur.max(t)));
    let bytes = code.as_bytes();
    let mut i = 0;
    while let Some(rel) = code[i..].find('.') {
        let start = i + rel + 1;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
            end += 1;
        }
        i = end.max(start);
        if end == start || bytes.get(end) != Some(&b'(') {
            continue;
        }
        let method = &code[start..end];
        let empty_filter = first_argument_is_empty(&code[end + 1..]);
        match method {
            "find" | "findOne" | "count" | "countDocuments" | "estimatedDocumentCount" | "distinct"
            | "getIndexes" | "listIndexes" | "stats" | "explain" | "getCollectionNames"
            | "listCollections" | "getCollectionInfos" => bump(Read),
            "aggregate" => bump(if code.contains("$out") || code.contains("$merge") { Write } else { Read }),
            "insertOne" | "insertMany" | "insert" | "replaceOne" | "save" | "findOneAndReplace" => bump(Write),
            "updateOne" | "findOneAndUpdate" | "update" => bump(Write),
            "updateMany" => bump(if empty_filter { Destructive } else { Write }),
            "deleteOne" | "findOneAndDelete" => bump(Delete),
            "deleteMany" | "remove" => bump(if empty_filter { Destructive } else { Delete }),
            "createCollection" | "createIndex" | "createIndexes" | "createView" => bump(Create),
            "drop" | "dropDatabase" | "dropIndex" | "dropIndexes" | "renameCollection" | "bulkWrite"
            | "runCommand" | "adminCommand" | "eval" | "createUser" | "dropUser" | "dropAllUsers"
            | "grantRolesToUser" | "revokeRolesFromUser" | "updateUser" => bump(Destructive),
            // Accessors and cursor helpers (getCollection, sort, limit, …)
            // don't change the classification.
            _ => {}
        }
    }
    // Nothing recognisable → never a silent read.
    tier.unwrap_or(Destructive)
}

/// True when a call's first argument is missing or `{}` — an unfiltered
/// `deleteMany()` / `updateMany({}, …)` touches every document.
fn first_argument_is_empty(after_paren: &str) -> bool {
    let arg = after_paren.trim_start();
    if arg.starts_with(')') {
        return true;
    }
    if let Some(inner) = arg.strip_prefix('{') {
        let inner = inner.trim_start();
        return inner.starts_with('}');
    }
    false
}

/// Blank out JS string literals so text inside them (`".drop("`) isn't read as
/// a method call. Same length as the input.
fn mask_js_strings(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in s.chars() {
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                    out.push(c);
                    continue;
                }
                for _ in 0..c.len_utf8() {
                    out.push(' ');
                }
            }
            None => {
                if matches!(c, '"' | '\'' | '`') {
                    quote = Some(c);
                }
                out.push(c);
            }
        }
    }
    out
}

// ---- Redis --------------------------------------------------------------

/// Classify one Redis command line by its command name.
fn classify_redis(line: &str) -> QueryTier {
    use QueryTier::*;
    let mut parts = line.split_whitespace();
    let cmd = parts.next().unwrap_or("").to_ascii_uppercase();
    let sub = parts.next().unwrap_or("").to_ascii_uppercase();
    match cmd.as_str() {
        "GET" | "MGET" | "STRLEN" | "GETRANGE" | "EXISTS" | "TYPE" | "TTL" | "PTTL" | "KEYS" | "SCAN"
        | "HGET" | "HMGET" | "HGETALL" | "HKEYS" | "HVALS" | "HLEN" | "HEXISTS" | "HSCAN" | "HSTRLEN"
        | "LRANGE" | "LLEN" | "LINDEX" | "LPOS" | "SMEMBERS" | "SISMEMBER" | "SMISMEMBER" | "SCARD"
        | "SSCAN" | "SRANDMEMBER" | "SINTER" | "SUNION" | "SDIFF" | "ZRANGE" | "ZREVRANGE"
        | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX" | "ZSCORE" | "ZMSCORE" | "ZCARD"
        | "ZCOUNT" | "ZRANK" | "ZREVRANK" | "ZSCAN" | "XRANGE" | "XREVRANGE" | "XLEN" | "XINFO"
        | "XREAD" | "GEOPOS" | "GEODIST" | "GEOHASH" | "GEOSEARCH" | "BITCOUNT" | "BITPOS" | "GETBIT"
        | "PFCOUNT" | "INFO" | "PING" | "ECHO" | "DBSIZE" | "TIME" | "LASTSAVE" | "SELECT"
        | "RANDOMKEY" | "DUMP" | "OBJECT" | "MEMORY" | "PUBSUB" | "JSON.GET" | "JSON.MGET"
        | "JSON.TYPE" | "FT.SEARCH" | "FT.INFO" | "FT._LIST" => Read,
        "CONFIG" => if sub == "GET" { Read } else { Destructive },
        "CLIENT" => if matches!(sub.as_str(), "LIST" | "INFO" | "GETNAME" | "ID") { Read } else { Destructive },
        "SLOWLOG" | "LATENCY" => if matches!(sub.as_str(), "GET" | "LEN" | "LATEST" | "HISTORY") { Read } else { Write },
        "SET" | "SETEX" | "PSETEX" | "SETNX" | "MSET" | "MSETNX" | "GETSET" | "APPEND" | "SETRANGE"
        | "INCR" | "INCRBY" | "INCRBYFLOAT" | "DECR" | "DECRBY" | "HSET" | "HMSET" | "HSETNX"
        | "HINCRBY" | "HINCRBYFLOAT" | "LPUSH" | "RPUSH" | "LPUSHX" | "RPUSHX" | "LSET" | "LINSERT"
        | "LMOVE" | "RPOPLPUSH" | "SADD" | "SMOVE" | "SINTERSTORE" | "SUNIONSTORE" | "SDIFFSTORE"
        | "ZADD" | "ZINCRBY" | "ZUNIONSTORE" | "ZINTERSTORE" | "XADD" | "XGROUP" | "XACK" | "EXPIRE"
        | "PEXPIRE" | "EXPIREAT" | "PEXPIREAT" | "PERSIST" | "PUBLISH" | "SPUBLISH" | "GEOADD"
        | "PFADD" | "PFMERGE" | "SETBIT" | "BITOP" | "COPY" | "RESTORE" | "JSON.SET" | "TOUCH" => Write,
        "DEL" | "UNLINK" | "HDEL" | "LREM" | "LPOP" | "RPOP" | "LTRIM" | "SREM" | "SPOP" | "ZREM"
        | "ZPOPMIN" | "ZPOPMAX" | "ZREMRANGEBYSCORE" | "ZREMRANGEBYRANK" | "ZREMRANGEBYLEX" | "XDEL"
        | "XTRIM" | "GETDEL" | "JSON.DEL" => Delete,
        // FLUSHALL, FLUSHDB, SHUTDOWN, DEBUG, SCRIPT, FUNCTION, EVAL*, FCALL,
        // SWAPDB, MOVE, MIGRATE, RENAME*, ACL, REPLICAOF, CLUSTER, … and
        // anything unknown.
        _ => Destructive,
    }
}

#[cfg(test)]
mod tier_tests {
    use super::*;

    const MY: CommandLanguage = CommandLanguage::Sql(SqlDialect::Mysql);
    const PG: CommandLanguage = CommandLanguage::Sql(SqlDialect::Postgres);
    const LITE: CommandLanguage = CommandLanguage::Sql(SqlDialect::Sqlite);

    #[test]
    fn classifies_core_verbs() {
        assert_eq!(classify_batch("SELECT * FROM users", MY), QueryTier::Read);
        assert_eq!(classify_batch("  show tables", MY), QueryTier::Read);
        assert_eq!(classify_batch("INSERT INTO t VALUES (1)", MY), QueryTier::Write);
        assert_eq!(classify_batch("UPDATE t SET a=1 WHERE id=2", MY), QueryTier::Write);
        assert_eq!(classify_batch("DELETE FROM t WHERE id=2", MY), QueryTier::Delete);
        assert_eq!(classify_batch("CREATE TABLE t (id int)", MY), QueryTier::Create);
        assert_eq!(classify_batch("CREATE INDEX i ON t(a)", PG), QueryTier::Create);
    }

    #[test]
    fn no_where_mutations_are_destructive() {
        assert_eq!(classify_batch("DELETE FROM t", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("UPDATE t SET a=1", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("DROP TABLE t", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("TRUNCATE t", PG), QueryTier::Destructive);
        assert_eq!(classify_batch("ALTER TABLE t DROP COLUMN a", MY), QueryTier::Destructive);
    }

    #[test]
    fn subquery_where_does_not_save_a_bare_update() {
        assert_eq!(classify_batch("UPDATE t SET a=(SELECT x FROM y WHERE y.id=1)", MY), QueryTier::Destructive);
    }

    #[test]
    fn where_inside_literals_or_comments_does_not_count() {
        assert_eq!(classify_batch("UPDATE users SET note = 'where'", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("UPDATE users SET a = 1 -- WHERE id = 1", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("DELETE FROM users /* WHERE id = 1 */", PG), QueryTier::Destructive);
    }

    #[test]
    fn comments_and_whitespace_cannot_disguise_the_verb() {
        assert_eq!(classify_batch("-- clean up\nDELETE FROM users", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("/* x */ DROP TABLE users", PG), QueryTier::Destructive);
        assert_eq!(classify_batch("DROP\nTABLE users", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("DROP\tTABLE users", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("/*!50000 DROP TABLE users */", MY), QueryTier::Destructive);
    }

    #[test]
    fn statements_that_execute_hidden_work() {
        assert_eq!(classify_batch("EXPLAIN ANALYZE DELETE FROM users", PG), QueryTier::Destructive);
        assert_eq!(classify_batch("EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET a = 1 WHERE id = 1", PG), QueryTier::Write);
        assert_eq!(classify_batch("EXPLAIN ANALYZE SELECT * FROM users", MY), QueryTier::Read);
        assert_eq!(classify_batch("EXPLAIN DELETE FROM users", MY), QueryTier::Read);
        assert_eq!(classify_batch("DO $$ BEGIN DELETE FROM users; END $$", PG), QueryTier::Destructive);
        assert_eq!(classify_batch("CALL purge_all()", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", PG), QueryTier::Destructive);
        assert_eq!(classify_batch("SELECT * INTO backup FROM users", PG), QueryTier::Create);
        assert_eq!(classify_batch("SELECT * FROM users INTO OUTFILE '/tmp/u.csv'", MY), QueryTier::Create);
    }

    #[test]
    fn privileges_and_server_state_are_destructive() {
        for sql in [
            "GRANT ALL PRIVILEGES ON *.* TO 'x'@'%'",
            "REVOKE SELECT ON users FROM app",
            "RENAME TABLE users TO users_old",
            "SET GLOBAL read_only = 0",
            "KILL 123",
            "CREATE USER 'x'@'%' IDENTIFIED BY 'p'",
            "ALTER USER 'x'@'%' IDENTIFIED BY 'p'",
            "FLUSH PRIVILEGES",
            "SHUTDOWN",
        ] {
            assert_eq!(classify_batch(sql, MY), QueryTier::Destructive, "{sql}");
        }
        assert_eq!(classify_batch("SET NAMES utf8mb4", MY), QueryTier::Write);
        assert_eq!(classify_batch("VACUUM", LITE), QueryTier::Write);
        assert_eq!(classify_batch("LOAD DATA INFILE '/tmp/x' INTO TABLE users", MY), QueryTier::Write);
    }

    #[test]
    fn sqlite_pragmas() {
        assert_eq!(classify_batch("PRAGMA table_info('users')", LITE), QueryTier::Read);
        assert_eq!(classify_batch("PRAGMA foreign_keys", LITE), QueryTier::Read);
        assert_eq!(classify_batch("PRAGMA writable_schema = ON", LITE), QueryTier::Write);
        assert_eq!(classify_batch("PRAGMA foreign_keys = OFF", LITE), QueryTier::Write);
    }

    #[test]
    fn cte_fronted_statements_are_classified_by_real_verb() {
        assert_eq!(classify_batch("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT 1)", PG), QueryTier::Delete);
        assert_eq!(classify_batch("WITH x AS (SELECT 1) UPDATE users SET a = 1", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("WITH last_update AS (SELECT 1) SELECT * FROM last_update", PG), QueryTier::Read);
        assert_eq!(classify_batch("(SELECT 1) UNION (SELECT 2)", MY), QueryTier::Read);
    }

    #[test]
    fn batch_takes_strongest_tier_with_real_statement_splitting() {
        assert_eq!(classify_batch("SELECT 1; DROP TABLE x", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("SELECT 1; INSERT INTO t VALUES (1)", MY), QueryTier::Write);
        // Postgres: `\'` doesn't escape, so this is SELECT then DROP.
        assert_eq!(classify_batch("SELECT 'a\\'; DROP TABLE users", PG), QueryTier::Destructive);
        // MySQL: it does, so it is one harmless SELECT of a string.
        assert_eq!(classify_batch("SELECT 'a\\'; DROP TABLE users; --'", MY), QueryTier::Read);
        assert_eq!(classify_batch("SELECT 1;\nDELIMITER x\nDROP TABLE t x", MY), QueryTier::Destructive);
        assert_eq!(classify_batch("-- just a note", MY), QueryTier::Read);
    }

    #[test]
    fn mongo_commands() {
        let m = CommandLanguage::Mongo;
        assert_eq!(classify_batch("db.users.find({age: {$gt: 30}}).limit(10)", m), QueryTier::Read);
        assert_eq!(classify_batch("db.users.aggregate([{$group: {_id: '$x'}}])", m), QueryTier::Read);
        assert_eq!(classify_batch("db.users.aggregate([{$match: {}}, {$out: 'copy'}])", m), QueryTier::Write);
        assert_eq!(classify_batch("db.users.insertOne({a: 1})", m), QueryTier::Write);
        assert_eq!(classify_batch("db.users.updateMany({a: 1}, {$set: {b: 2}})", m), QueryTier::Write);
        assert_eq!(classify_batch("db.users.updateMany({}, {$set: {b: 2}})", m), QueryTier::Destructive);
        assert_eq!(classify_batch("db.users.deleteMany({a: 1})", m), QueryTier::Delete);
        assert_eq!(classify_batch("db.users.deleteMany({})", m), QueryTier::Destructive);
        assert_eq!(classify_batch("db.users.deleteMany()", m), QueryTier::Destructive);
        assert_eq!(classify_batch("db.users.drop()", m), QueryTier::Destructive);
        assert_eq!(classify_batch("db.dropDatabase()", m), QueryTier::Destructive);
        assert_eq!(classify_batch("db.users.find({note: 'x.drop()'})", m), QueryTier::Read);
        assert_eq!(classify_batch("db.users.createIndex({a: 1})", m), QueryTier::Create);
        assert_eq!(classify_batch("something odd", m), QueryTier::Destructive);
    }

    #[test]
    fn redis_commands() {
        let r = CommandLanguage::Redis;
        assert_eq!(classify_batch("GET user:1", r), QueryTier::Read);
        assert_eq!(classify_batch("hgetall user:1", r), QueryTier::Read);
        assert_eq!(classify_batch("SET a 1", r), QueryTier::Write);
        assert_eq!(classify_batch("DEL a", r), QueryTier::Delete);
        assert_eq!(classify_batch("FLUSHALL", r), QueryTier::Destructive);
        assert_eq!(classify_batch("CONFIG GET maxmemory", r), QueryTier::Read);
        assert_eq!(classify_batch("CONFIG SET maxmemory 1", r), QueryTier::Destructive);
        assert_eq!(classify_batch("EVAL \"return 1\" 0", r), QueryTier::Destructive);
        assert_eq!(classify_batch("GET a\nFLUSHDB", r), QueryTier::Destructive);
    }

    #[test]
    fn unknown_store_is_never_read() {
        assert_eq!(classify_batch("SELECT 1", CommandLanguage::Unknown), QueryTier::Destructive);
    }
}
