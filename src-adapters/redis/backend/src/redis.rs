//! Redis driver backed by `redis-rs`.
//!
//! One `MultiplexedConnection` per adapter — redis-rs multiplexes
//! commands over a single TCP connection, which is the right model for
//! a desktop client where we issue serial commands from a tiny number
//! of threads.

use std::time::Instant;

use adapter_api::log_line;
use adapter_api::{
    AdapterError, ColumnInfo, ColumnMeta, QueryResult, SchemaInfo, ServerInfo, StatementResult,
    TableInfo, TableKind, TableStructure,
};
use redis::aio::MultiplexedConnection;
use redis::{Cmd, RedisError, Value};
use serde_json::{Value as JsonValue, json};

/// Virtual tables the adapter exposes inside each database. Keys get
/// bucketed by their RESP type so the UI can show one section per kind
/// and ask for typed rows via `browse`.
pub(crate) const VIRTUAL_TABLES: &[&str] =
    &["strings", "hashes", "lists", "sets", "zsets", "streams"];

/// Number of DBs to probe on `list_schemas`. Vanilla Redis ships with
/// 16 (`databases 16` in redis.conf); custom builds may have more, but
/// 16 is the ceiling every deployment has agreed on since 2.x.
const MAX_DB: u32 = 16;

/// Default page size for SCAN-based browsing when the caller didn't
/// pin one. SCAN's COUNT is a hint, not a bound — we ask for this many
/// and trim/extend as needed.
pub(crate) const DEFAULT_SCAN_COUNT: u32 = 200;

pub struct RedisDriver {
    pub(crate) conn: tokio::sync::Mutex<MultiplexedConnection>,
    /// Default DB index picked at connect time. Stored so `ping()` can
    /// surface it as the "default schema" the UI uses for the initial
    /// rail tile.
    pub(crate) default_db: u32,
    /// Kept so `subscribe` can open a dedicated connection for pub/sub.
    /// The multiplexed command connection can't be put into subscriber
    /// mode (PSUBSCRIBE blocks all other commands until UNSUBSCRIBE).
    pub(crate) client: redis::Client,
}

pub struct RedisConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    /// Optional starting DB. We honour it but `list_schemas` will pick
    /// the real set of populated DBs regardless.
    pub database: Option<u32>,
}

impl RedisDriver {
    pub async fn connect(cfg: RedisConfig) -> Result<Self, AdapterError> {
        log_line!(
            "redis_connect",
            "→ host={} port={} user={:?} db={:?}",
            cfg.host,
            cfg.port,
            cfg.user,
            cfg.database,
        );

        // Build a redis-rs `ConnectionInfo` by hand — the crate's
        // URL-based constructor does percent-decoding that breaks on
        // passwords with reserved chars.
        let addr = redis::ConnectionAddr::Tcp(cfg.host.clone(), cfg.port);
        let info = redis::RedisConnectionInfo {
            db: cfg.database.unwrap_or(0) as i64,
            username: cfg.user.clone().filter(|u| !u.is_empty()),
            password: cfg.password.clone().filter(|p| !p.is_empty()),
            protocol: redis::ProtocolVersion::RESP3,
        };
        let conn_info = redis::ConnectionInfo { addr, redis: info };
        let client = redis::Client::open(conn_info).map_err(map_err)?;

        let t_pool = Instant::now();
        let conn = client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(map_err)?;
        log_line!(
            "redis_connect",
            "  connected ({:.1}ms)",
            t_pool.elapsed().as_secs_f64() * 1000.0
        );

        Ok(Self {
            conn: tokio::sync::Mutex::new(conn),
            default_db: cfg.database.unwrap_or(0),
            client,
        })
    }
}

/// Map a `redis::RedisError` into our neutral `AdapterError`. Auth
/// failures get their own kind so the UI can steer users to the right
/// remediation.
pub(crate) fn map_err(e: RedisError) -> AdapterError {
    let msg = e.to_string();
    match e.kind() {
        redis::ErrorKind::AuthenticationFailed => AdapterError::Authentication(msg),
        redis::ErrorKind::ClusterConnectionNotFound
        | redis::ErrorKind::IoError
        | redis::ErrorKind::ClusterDown => AdapterError::Connection(msg),
        _ => AdapterError::Other(msg),
    }
}

impl RedisDriver {
    pub async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        let mut conn = self.conn.lock().await;
        // `INFO server` has the redis_version field we want; fall back
        // to an unknown marker if the server is weird enough to strip
        // it (redislike proxies like Twemproxy do this).
        let info: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut *conn)
            .await
            .map_err(map_err)?;

        let version = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_version:"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".into());
        let (version_major, version_minor) = parse_semver(&version);
        let flavor = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_mode:"))
            .map(|s| s.trim().to_string());

        log_line!(
            "redis_ping",
            "version={} parsed=({:?}.{:?}) mode={:?}",
            version,
            version_major,
            version_minor,
            flavor,
        );

        Ok(ServerInfo {
            adapter_id: "redis".into(),
            version,
            version_major,
            version_minor,
            flavor: flavor.or_else(|| Some("Redis".into())),
            default_schema: Some(format!("db{}", self.default_db)),
        })
    }

    pub async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        let t_total = Instant::now();
        let mut out: Vec<SchemaInfo> = Vec::new();
        let mut conn = self.conn.lock().await;

        // One DBSIZE per index. These are cheap (O(1)) so the loop is
        // fast even against a server with 16 DBs.
        for db in 0..MAX_DB {
            redis::cmd("SELECT")
                .arg(db)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(map_err)?;
            let size: u64 = redis::cmd("DBSIZE")
                .query_async(&mut *conn)
                .await
                .map_err(map_err)?;
            if size == 0 {
                continue;
            }
            // One SCAN pass tallies each key's TYPE so the sidebar only
            // shows virtual tables that actually have keys. Also gives
            // us an exact `rowCount` per table "for free" vs. issuing a
            // separate SCAN per type later.
            let counts = tally_types_in_db(&mut conn).await?;
            let tables: Vec<TableInfo> = VIRTUAL_TABLES
                .iter()
                .filter_map(|name| {
                    let redis_type = virtual_table_to_redis_type(name);
                    let n = counts.get(redis_type).copied().unwrap_or(0);
                    if n == 0 {
                        return None;
                    }
                    Some(TableInfo {
                        name: (*name).to_string(),
                        kind: TableKind::Collection,
                        row_count: Some(n),
                    })
                })
                .collect();
            if tables.is_empty() {
                continue;
            }
            out.push(SchemaInfo {
                name: format!("db{db}"),
                tables,
            });
        }

        // Restore the driver's default DB so subsequent commands aren't
        // accidentally scoped to the last one we probed above.
        redis::cmd("SELECT")
            .arg(self.default_db)
            .query_async::<()>(&mut *conn)
            .await
            .map_err(map_err)?;

        log_line!(
            "redis_list_schemas",
            "← {} populated DBs ({:.1}ms)",
            out.len(),
            t_total.elapsed().as_secs_f64() * 1000.0,
        );
        Ok(out)
    }

    pub async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, AdapterError> {
        let db = parse_db_name(schema)?;
        ensure_virtual_table(table)?;

        // Redis has no schema to describe — we synthesise one so the
        // data grid gets column metadata. Columns depend on the key
        // type ("lists" have `index`, "zsets" have `score`, …); see
        // `synthetic_columns_for`.
        let columns = synthetic_columns_for(table);

        // Count of keys of this type in the DB. Unlike DBSIZE this is
        // O(N), so we SCAN and count — bounded by TTL-expiring keys
        // landing / dropping mid-scan, but it's close enough for a
        // sidebar badge.
        let row_count = {
            let mut conn = self.conn.lock().await;
            redis::cmd("SELECT")
                .arg(db)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(map_err)?;
            let n = count_keys_of_type(&mut conn, table).await?;
            // Restore default DB.
            redis::cmd("SELECT")
                .arg(self.default_db)
                .query_async::<()>(&mut *conn)
                .await
                .map_err(map_err)?;
            n
        };

        Ok(TableStructure {
            schema: schema.to_string(),
            name: table.to_string(),
            kind: TableKind::Collection,
            columns,
            indexes: Vec::new(),
            primary_key: vec!["key".to_string()],
            foreign_keys: Vec::new(),
            row_count: Some(row_count),
        })
    }

    pub async fn describe_schema(
        &self,
        schema: &str,
    ) -> Result<Vec<TableStructure>, AdapterError> {
        let _ = parse_db_name(schema)?;
        let mut out = Vec::with_capacity(VIRTUAL_TABLES.len());
        for name in VIRTUAL_TABLES {
            if let Ok(s) = self.describe_table(schema, name).await {
                out.push(s);
            }
        }
        Ok(out)
    }

    /// Close the multiplexed connection. `Drop` handles this cleanly on
    /// its own; we provide an explicit call so the registry lifecycle
    /// matches the other adapters' shapes.
    pub async fn shutdown(&self) {
        // No-op: dropping the `MultiplexedConnection` tears down the
        // underlying TCP connection. Kept for symmetry with other
        // adapters' explicit `shutdown()` call.
    }
}

/// Parse the `version` field returned by `INFO server`. Handles the
/// standard `<major>.<minor>.<patch>` shape plus anything a fork might
/// prefix (we take whatever digits lead the string).
fn parse_semver(raw: &str) -> (Option<u32>, Option<u32>) {
    let prefix: String = raw
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = prefix.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok());
    (major, minor)
}

/// Convert `"db0"` / `"db15"` / `"main"` → numeric DB index.
/// `main` aliases to db0 because Redis defaults to 0 when unspecified
/// and users expect "the default DB" as a navigable target.
pub(crate) fn parse_db_name(schema: &str) -> Result<u32, AdapterError> {
    if schema.eq_ignore_ascii_case("main") || schema.is_empty() {
        return Ok(0);
    }
    schema
        .strip_prefix("db")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n < MAX_DB)
        .ok_or_else(|| {
            AdapterError::NotFound(format!("unknown Redis DB `{schema}` (expected db0..db15)"))
        })
}

/// Sanity-check the `table` name against the manifest's declared
/// virtual tables. Anything else is a hard NotFound — we don't silently
/// coerce, because a typo here would otherwise show an empty grid with
/// no error.
pub(crate) fn ensure_virtual_table(name: &str) -> Result<(), AdapterError> {
    if VIRTUAL_TABLES.iter().any(|t| *t == name) {
        Ok(())
    } else {
        Err(AdapterError::NotFound(format!(
            "unknown Redis virtual table `{name}` (expected one of {:?})",
            VIRTUAL_TABLES
        )))
    }
}

/// Synthetic columns the data grid renders for each virtual table. The
/// value encoding varies by type — hashes need `field` to disambiguate,
/// lists need `index`, zsets need `score` — so each table gets its own
/// layout. TTL is always last so ephemeral-key visibility is consistent.
pub(crate) fn synthetic_columns_for(table: &str) -> Vec<ColumnInfo> {
    let col = |name: &str, ty: &str, pk: bool| ColumnInfo {
        name: name.to_string(),
        data_type: ty.to_string(),
        nullable: !pk,
        default: None,
        length: None,
        is_primary: pk,
        is_unique: pk,
        is_foreign: false,
        is_indexed: false,
        extra: String::new(),
        character_set: None,
        collation: None,
    };
    match table {
        "strings" => vec![col("key", "text", true), col("value", "text", false), col("ttl", "int", false)],
        "hashes" => vec![
            col("key", "text", true),
            col("field", "text", true),
            col("value", "text", false),
            col("ttl", "int", false),
        ],
        "lists" => vec![
            col("key", "text", true),
            col("index", "int", true),
            col("value", "text", false),
            col("ttl", "int", false),
        ],
        "sets" => vec![col("key", "text", true), col("member", "text", true), col("ttl", "int", false)],
        "zsets" => vec![
            col("key", "text", true),
            col("member", "text", true),
            col("score", "real", false),
            col("ttl", "int", false),
        ],
        "streams" => vec![
            col("key", "text", true),
            col("id", "text", true),
            col("entry", "json", false),
            col("ttl", "int", false),
        ],
        _ => Vec::new(),
    }
}

/// Count the keys of a given virtual-table type in the currently-selected
/// DB. Runs a bounded SCAN loop — O(N) but streaming, so memory stays flat
/// even on servers with millions of keys.
async fn count_keys_of_type(
    conn: &mut MultiplexedConnection,
    table: &str,
) -> Result<u64, AdapterError> {
    let target_type = virtual_table_to_redis_type(table);
    let mut cursor: u64 = 0;
    let mut total: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(DEFAULT_SCAN_COUNT)
            .query_async(&mut *conn)
            .await
            .map_err(map_err)?;
        cursor = next;
        for k in &keys {
            let t: String = redis::cmd("TYPE")
                .arg(k)
                .query_async(&mut *conn)
                .await
                .map_err(map_err)?;
            if t == target_type {
                total += 1;
            }
        }
        if cursor == 0 {
            break;
        }
    }
    Ok(total)
}

/// Scan the currently-selected DB once and return a tally of keys per
/// Redis TYPE (`"string" -> N`, `"hash" -> N`, ...). One SCAN + one
/// TYPE per key; cheaper than running `count_keys_of_type` six times.
async fn tally_types_in_db(
    conn: &mut MultiplexedConnection,
) -> Result<std::collections::HashMap<&'static str, u64>, AdapterError> {
    let mut out: std::collections::HashMap<&'static str, u64> =
        std::collections::HashMap::new();
    let mut cursor: u64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(DEFAULT_SCAN_COUNT)
            .query_async(&mut *conn)
            .await
            .map_err(map_err)?;
        cursor = next;
        for k in &keys {
            let t: String = redis::cmd("TYPE")
                .arg(k)
                .query_async(&mut *conn)
                .await
                .map_err(map_err)?;
            let bucket: &'static str = match t.as_str() {
                "string" => "string",
                "hash" => "hash",
                "list" => "list",
                "set" => "set",
                "zset" => "zset",
                "stream" => "stream",
                _ => continue,
            };
            *out.entry(bucket).or_insert(0) += 1;
        }
        if cursor == 0 {
            break;
        }
    }
    Ok(out)
}

/// Virtual-table name → Redis `TYPE` string.
pub(crate) fn virtual_table_to_redis_type(table: &str) -> &'static str {
    match table {
        "strings" => "string",
        "hashes" => "hash",
        "lists" => "list",
        "sets" => "set",
        "zsets" => "zset",
        "streams" => "stream",
        _ => "none",
    }
}

/// Convert a redis-rs `Value` into a JSON value the grid can render.
/// Nested arrays / maps come back as their native JSON analogues;
/// binary strings that aren't valid UTF-8 surface as the standard
/// `{"__binary__": true, "bytes": N}` sentinel used elsewhere in the
/// codebase.
pub(crate) fn value_to_json(v: &Value) -> JsonValue {
    match v {
        Value::Nil => JsonValue::Null,
        Value::Int(i) => JsonValue::from(*i),
        Value::BulkString(bytes) => bytes_to_json(bytes),
        Value::SimpleString(s) => JsonValue::String(s.clone()),
        Value::Okay => JsonValue::String("OK".into()),
        Value::Array(arr) => JsonValue::Array(arr.iter().map(value_to_json).collect()),
        Value::Map(pairs) => {
            let mut obj = serde_json::Map::new();
            for (k, vv) in pairs {
                let key = match value_to_json(k) {
                    JsonValue::String(s) => s,
                    other => other.to_string(),
                };
                obj.insert(key, value_to_json(vv));
            }
            JsonValue::Object(obj)
        }
        Value::Set(members) => JsonValue::Array(members.iter().map(value_to_json).collect()),
        Value::Double(f) => serde_json::Number::from_f64(*f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Boolean(b) => JsonValue::Bool(*b),
        Value::VerbatimString { text, format: _ } => JsonValue::String(text.clone()),
        Value::BigNumber(n) => JsonValue::String(n.to_string()),
        Value::Push { kind, data } => json!({
            "__push__": format!("{:?}", kind),
            "data": data.iter().map(value_to_json).collect::<Vec<_>>()
        }),
        Value::ServerError(e) => {
            JsonValue::String(format!("ERR: {}", e.details().unwrap_or("")))
        }
        Value::Attribute { data, attributes: _ } => value_to_json(data),
    }
}

fn bytes_to_json(bytes: &[u8]) -> JsonValue {
    match std::str::from_utf8(bytes) {
        Ok(s) => JsonValue::String(s.to_string()),
        Err(_) => json!({ "__binary__": true, "bytes": bytes.len() }),
    }
}

/// Execute a RESP command already parsed into `argv` form. Used by
/// `execute_raw` for the query-editor path.
pub(crate) async fn exec_raw_argv(
    conn: &mut MultiplexedConnection,
    argv: &[String],
) -> Result<(Vec<ColumnMeta>, Vec<Vec<JsonValue>>, Option<u64>), AdapterError> {
    if argv.is_empty() {
        return Err(AdapterError::Syntax {
            message: "empty command".into(),
            line: None,
            column: None,
        });
    }
    let mut cmd = Cmd::new();
    for arg in argv {
        cmd.arg(arg.as_str());
    }
    let value: Value = cmd.query_async(&mut *conn).await.map_err(map_err)?;

    // Reply shape varies wildly between commands (scalar, array, map,
    // nested). Flatten into a single-column / single-row grid by
    // default; arrays get expanded into rows; maps become two-column
    // rows. The result is "always renderable" even if it's not
    // especially pretty — cross-command polish comes later.
    let (columns, rows, rows_affected) = match &value {
        Value::Int(n) => (
            vec![ColumnMeta { name: "value".into(), type_hint: "integer".into() }],
            vec![vec![JsonValue::from(*n)]],
            Some(1u64),
        ),
        Value::Array(items) => {
            let json_rows: Vec<Vec<JsonValue>> = items
                .iter()
                .map(|it| vec![value_to_json(it)])
                .collect();
            let rows_affected = Some(json_rows.len() as u64);
            (vec![ColumnMeta { name: "value".into(), type_hint: "any".into() }], json_rows, rows_affected)
        }
        Value::Map(pairs) => {
            let cols = vec![
                ColumnMeta { name: "field".into(), type_hint: "text".into() },
                ColumnMeta { name: "value".into(), type_hint: "any".into() },
            ];
            let rows: Vec<Vec<JsonValue>> = pairs
                .iter()
                .map(|(k, v)| vec![value_to_json(k), value_to_json(v)])
                .collect();
            let rows_affected = Some(rows.len() as u64);
            (cols, rows, rows_affected)
        }
        _ => (
            vec![ColumnMeta { name: "value".into(), type_hint: "any".into() }],
            vec![vec![value_to_json(&value)]],
            Some(1u64),
        ),
    };
    Ok((columns, rows, rows_affected))
}

#[allow(dead_code)]
fn placeholder_statement(sql: String) -> StatementResult {
    StatementResult {
        sql,
        duration_ms: 0.0,
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: None,
        error: None,
    }
}

/// Batch wrapper around `exec_raw_argv`. `QueryResult::statements`
/// mirrors the format SQL adapters return, so the query-editor UI needs
/// no Redis-specific branching.
pub(crate) async fn run_redis_commands(
    conn: &mut MultiplexedConnection,
    input: &str,
) -> Result<QueryResult, AdapterError> {
    let commands = split_redis_commands(input);
    let mut statements = Vec::with_capacity(commands.len());
    for argv in commands {
        if argv.is_empty() {
            continue;
        }
        let display = argv.join(" ");
        let started = Instant::now();
        match exec_raw_argv(conn, &argv).await {
            Ok((columns, rows, rows_affected)) => {
                statements.push(StatementResult {
                    sql: display,
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    columns,
                    rows,
                    rows_affected,
                    error: None,
                });
            }
            Err(e) => {
                statements.push(StatementResult {
                    sql: display,
                    duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                    columns: Vec::new(),
                    rows: Vec::new(),
                    rows_affected: None,
                    error: Some(e.to_string()),
                });
            }
        }
    }
    Ok(QueryResult { statements })
}

/// Shell-ish command splitter: one command per line, fields separated
/// by whitespace, double-quoted strings preserved with `\"` escaping.
/// Redis commands don't take sub-queries, so we don't need a real lexer.
fn split_redis_commands(input: &str) -> Vec<Vec<String>> {
    input
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            Some(split_argv(trimmed))
        })
        .filter(|v: &Vec<String>| !v.is_empty())
        .collect()
}

fn split_argv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if in_quotes => {
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            '"' => {
                in_quotes = !in_quotes;
            }
            ' ' | '\t' if !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_db_name_accepts_main_and_numeric() {
        assert_eq!(parse_db_name("main").unwrap(), 0);
        assert_eq!(parse_db_name("").unwrap(), 0);
        assert_eq!(parse_db_name("db0").unwrap(), 0);
        assert_eq!(parse_db_name("db7").unwrap(), 7);
        assert!(parse_db_name("db16").is_err());
        assert!(parse_db_name("whatever").is_err());
    }

    #[test]
    fn ensure_virtual_table_accepts_known() {
        assert!(ensure_virtual_table("hashes").is_ok());
        assert!(ensure_virtual_table("widgets").is_err());
    }

    #[test]
    fn argv_handles_quotes_and_escapes() {
        assert_eq!(split_argv("GET foo"), vec!["GET", "foo"]);
        assert_eq!(
            split_argv(r#"SET k "a b c""#),
            vec!["SET", "k", "a b c"],
        );
        assert_eq!(
            split_argv(r#"SET k "with \"quote\"""#),
            vec!["SET", "k", r#"with "quote""#],
        );
    }

    #[test]
    fn split_commands_skips_comments_and_blanks() {
        let cmds = split_redis_commands("# hello\n\nGET foo\nSET bar 1\n");
        assert_eq!(cmds, vec![vec!["GET", "foo"], vec!["SET", "bar", "1"]]);
    }
}
