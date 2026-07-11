//! MySQL driver backed by sqlx.
//!
//! Builds a connection pool from a `ConnectionProfileInput`-ish struct (we only
//! need the public fields + resolved plaintext password which the command layer
//! fetches from the vault). Queries stream row-by-row so we don't load entire
//! result sets before responding.

use std::time::Instant;

use adapter_api::{
    AdapterError, ColumnInfo, ColumnMeta, ForeignKey, IndexInfo, KillResult, ProcessInfo,
    ProcessKind, QueryResult, RoutineDefinition, RoutineInfo, RoutineParam, SaveTriggerRequest,
    SchemaInfo, ServerDetail, ServerInfo, StatementResult, TableInfo, TableKind, TableStructure,
    TriggerDefinition, TriggerInfo, ViewInfo,
};
use adapter_api::log_line;
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::mysql::{MySqlColumn, MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, Executor, MySql, Pool, Row, TypeInfo};

pub struct MysqlDriver {
    pub(crate) pool: Pool<MySql>,
    #[allow(dead_code)]
    pub(crate) default_db: Option<String>,
}

/// Everything the driver needs to open a connection. Produced by the command
/// layer after it has decrypted the password from the vault.
pub struct MysqlConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: Option<String>,
}

impl MysqlDriver {
    pub async fn connect(cfg: MysqlConfig) -> Result<Self, AdapterError> {
        log_line!(
            "mysql_connect",
            "→ host={} port={} user={} default_db={:?} ssl_mode={:?}",
            cfg.host,
            cfg.port,
            cfg.user,
            cfg.database,
            cfg.ssl_mode,
        );
        let mut opts = MySqlConnectOptions::new()
            .host(&cfg.host)
            .port(cfg.port)
            .username(&cfg.user);
        if let Some(p) = cfg.password.as_deref() {
            opts = opts.password(p);
        }
        if let Some(db) = cfg.database.as_deref() {
            opts = opts.database(db);
        }
        opts = opts.ssl_mode(map_ssl_mode(cfg.ssl_mode.as_deref()));

        let pool = MySqlPoolOptions::new()
            // 16 connections lets diagram/schema loads fan out without every
            // other UI query (sidebar refresh, autocomplete) waiting behind
            // the describe fleet. Paired with the generous acquire window
            // below so bursts of parallel describeTable calls queue up
            // instead of surfacing as "Timeout" errors.
            .max_connections(16)
            // No eager warmup. `min_connections(N)` with `connect_with` does
            // NOT return until N full handshakes complete — on a remote/slow
            // host that blocks the very first `list_schemas` behind the pool
            // filling up (observed: an 18s `list_schemas` for 2 schemas / 29
            // tables, purely pool-acquire wait). With `connect_lazy_with` the
            // pool is created instantly and the first query opens exactly one
            // connection on demand; the pool grows to max only under real
            // concurrency. This is the dominant connect-latency win — see the
            // reconnect-latency audit.
            .min_connections(0)
            // Bound a single dial so a blackholed/half-open host fails fast
            // (~10s) instead of the user staring at a spinner for up to the
            // full acquire window. Acquire stays generous so legitimate bursts
            // of parallel describeTable calls queue rather than erroring.
            .acquire_timeout(std::time::Duration::from_secs(30))
            // Proactive connection health. THE fix for the "one query in a
            // burst hangs ~19s" symptom: after a connection sits idle, the
            // server's `wait_timeout` (or a NAT/laptop-sleep drop) kills the
            // socket, but a dead connection lingers in the pool. The next
            // burst of parallel browses then has ONE unlucky query draw that
            // dead connection and block on the OS socket timeout while its
            // siblings (which drew healthy connections) finish in ms.
            //   - test_before_acquire: ping/validate a connection before
            //     lending it; a dead one is transparently discarded + a fresh
            //     one opened. Costs a sub-ms round-trip per acquire, buys us
            //     never handing out a corpse.
            //   - idle_timeout: close connections idle > 4 min so they're gone
            //     before a typical MySQL `wait_timeout` (often 5–8 min) kills
            //     them server-side.
            //   - max_lifetime: hard cap on age as a backstop against
            //     long-lived half-broken sockets.
            .test_before_acquire(true)
            .idle_timeout(std::time::Duration::from_secs(240))
            .max_lifetime(std::time::Duration::from_secs(1800))
            // Force the session character set to utf8mb4 on every new
            // connection. Without this, some servers (OVH-managed MySQL,
            // ProxySQL-fronted clusters, anything with
            // skip-character-set-client-handshake) return information_schema
            // columns as VARBINARY — sqlx then refuses to decode them into
            // String and the whole schema listing breaks.
            .after_connect(|conn, _meta| Box::pin(async move {
                use sqlx::Executor;
                conn.execute("SET NAMES utf8mb4").await?;
                Ok(())
            }))
            // Lazy: returns a pool handle immediately without opening any
            // connection. `db_connect` then calls `ping()`, which opens the
            // first real connection — that's where any genuine auth/network
            // failure surfaces, fast, instead of during a later query.
            .connect_lazy_with(opts);
        log_line!("mysql_connect", "  pool ready (lazy)");
        Ok(Self { pool, default_db: cfg.database })
    }
}

/// Split `SELECT VERSION()` output into `(major, minor, flavor)`.
///
/// MySQL returns strings like `8.0.35`, `5.7.44-log`, `10.6.12-MariaDB`,
/// `8.0.34-26-cluster`. MariaDB reports itself with a version that looks like
/// MySQL but with `-MariaDB` in the suffix — we flag it explicitly so the UI
/// can show the right badge without regex-ing later.
fn parse_mysql_version(raw: &str) -> (Option<u32>, Option<u32>, Option<String>) {
    let prefix: String = raw
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = prefix.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok());
    let suffix = raw.to_ascii_lowercase();
    let flavor = if suffix.contains("mariadb") {
        Some("MariaDB".to_string())
    } else if suffix.contains("percona") {
        Some("Percona".to_string())
    } else {
        Some("MySQL".to_string())
    };
    (major, minor, flavor)
}

/// Format a byte count as a human-readable size (e.g. `1.5 GB`).
fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut size = n as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{size:.1} {}", UNITS[unit])
}

/// Format a duration in seconds as `Xd Yh Zm` (or smaller units when short).
fn human_duration(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let mins = (secs % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h {mins}m")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else if mins > 0 {
        format!("{mins}m {}s", secs % 60)
    } else {
        format!("{secs}s")
    }
}

fn map_ssl_mode(s: Option<&str>) -> MySqlSslMode {
    match s.unwrap_or("Disable") {
        "Require" | "REQUIRED" => MySqlSslMode::Required,
        "Verify-CA" | "VERIFY_CA" => MySqlSslMode::VerifyCa,
        "Verify-Full" | "VERIFY_IDENTITY" => MySqlSslMode::VerifyIdentity,
        "Preferred" | "PREFERRED" => MySqlSslMode::Preferred,
        _ => MySqlSslMode::Disabled,
    }
}

impl MysqlDriver {
    pub async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await?;
        let (version_major, version_minor, flavor) = parse_mysql_version(&version);
        log_line!(
            "mysql_ping",
            "version={} parsed=({:?}.{:?}) flavor={:?}",
            version,
            version_major,
            version_minor,
            flavor,
        );
        Ok(ServerInfo {
            adapter_id: "mysql".into(),
            version,
            version_major,
            version_minor,
            flavor,
            default_schema: self.default_db.clone(),
        })
    }

    /// Live server + database stats for the connection "Information" dialog.
    /// Best-effort: any individual probe that fails is simply omitted rather
    /// than failing the whole call, so a restricted user still gets what they
    /// can see.
    pub async fn server_details(
        &self,
        schema: Option<&str>,
    ) -> Result<Vec<ServerDetail>, AdapterError> {
        let mut out: Vec<ServerDetail> = Vec::new();
        let push = |out: &mut Vec<ServerDetail>, label: &str, value: String| {
            if !value.is_empty() {
                out.push(ServerDetail { label: label.into(), value });
            }
        };

        if let Ok(v) = sqlx::query_scalar::<_, String>("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await
        {
            push(&mut out, "Server version", v);
        }
        if let Ok((cs, coll)) = sqlx::query_as::<_, (String, String)>(
            "SELECT @@character_set_server, @@collation_server",
        )
        .fetch_one(&self.pool)
        .await
        {
            push(&mut out, "Default charset", cs);
            push(&mut out, "Default collation", coll);
        }
        // Server-wide knobs users often want to confirm.
        if let Ok(tz) = sqlx::query_scalar::<_, String>("SELECT @@system_time_zone")
            .fetch_one(&self.pool)
            .await
        {
            push(&mut out, "Time zone", tz);
        }
        if let Ok(max) = sqlx::query_scalar::<_, i64>("SELECT @@max_connections")
            .fetch_one(&self.pool)
            .await
        {
            push(&mut out, "Max connections", max.to_string());
        }

        // Database-scoped stats for the focused schema.
        if let Some(db) = schema.filter(|s| !s.is_empty()) {
            if let Ok((cs, coll)) = sqlx::query_as::<_, (String, String)>(
                "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
                 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
            )
            .bind(db)
            .fetch_one(&self.pool)
            .await
            {
                push(&mut out, "Database charset", cs);
                push(&mut out, "Database collation", coll);
            }
            // Size + object counts from information_schema.TABLES.
            if let Ok((tables, data, index, rows)) = sqlx::query_as::<
                _,
                (i64, Option<BigDecimal>, Option<BigDecimal>, Option<BigDecimal>),
            >(
                "SELECT COUNT(*), \
                        SUM(DATA_LENGTH), SUM(INDEX_LENGTH), SUM(TABLE_ROWS) \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            )
            .bind(db)
            .fetch_one(&self.pool)
            .await
            {
                let to_u64 = |b: Option<BigDecimal>| -> u64 {
                    b.and_then(|d| d.to_string().split('.').next().and_then(|s| s.parse().ok()))
                        .unwrap_or(0)
                };
                let data_b = to_u64(data);
                let index_b = to_u64(index);
                push(&mut out, "Tables", tables.to_string());
                push(&mut out, "Data size", human_bytes(data_b));
                push(&mut out, "Index size", human_bytes(index_b));
                push(&mut out, "Total size", human_bytes(data_b + index_b));
                let est_rows = to_u64(rows);
                if est_rows > 0 {
                    push(&mut out, "Rows (estimated)", est_rows.to_string());
                }
            }
        }

        // Uptime + live thread count from global status.
        if let Ok((_n, uptime)) =
            sqlx::query_as::<_, (String, String)>("SHOW GLOBAL STATUS LIKE 'Uptime'")
                .fetch_one(&self.pool)
                .await
        {
            if let Ok(secs) = uptime.parse::<u64>() {
                push(&mut out, "Uptime", human_duration(secs));
            }
        }
        if let Ok((_n, threads)) =
            sqlx::query_as::<_, (String, String)>("SHOW GLOBAL STATUS LIKE 'Threads_connected'")
                .fetch_one(&self.pool)
                .await
        {
            push(&mut out, "Active connections", threads);
        }

        Ok(out)
    }

    pub async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        // Enumerate every user schema from SCHEMATA so empty databases still
        // show up in the picker. Previously we listed schemas via TABLES,
        // which silently dropped any database with zero tables/views — the
        // "No databases on this server" symptom.
        //
        // Some managed MySQL servers (OVH, ProxySQL, anything with
        // `collation_server = binary`) send information_schema columns as
        // VARBINARY regardless of session SET NAMES. Wrapping every text
        // column in CAST(... AS CHAR CHARACTER SET utf8mb4) forces the wire
        // type to VARCHAR so sqlx decodes cleanly — belt-and-braces on top
        // of the connect-time `SET NAMES utf8mb4` hook.
        //
        // Running the two queries concurrently bounds us by the single slowest
        // round-trip instead of stacking them (~2× speed-up over SSH).
        let t_total = std::time::Instant::now();

        let schemata_fut = sqlx::query_as::<_, (String,)>(
            r#"SELECT CAST(SCHEMA_NAME AS CHAR CHARACTER SET utf8mb4) AS SCHEMA_NAME
               FROM information_schema.SCHEMATA
               WHERE SCHEMA_NAME NOT IN ('mysql','performance_schema','information_schema','sys')
               ORDER BY SCHEMA_NAME"#,
        )
        .fetch_all(&self.pool);

        let tables_fut = sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT CAST(TABLE_SCHEMA AS CHAR CHARACTER SET utf8mb4),
                      CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(TABLE_TYPE AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.TABLES
               WHERE TABLE_SCHEMA NOT IN ('mysql','performance_schema','information_schema','sys')
               ORDER BY TABLE_SCHEMA, TABLE_NAME"#,
        )
        .fetch_all(&self.pool);

        let (schema_rows, table_rows) = tokio::try_join!(schemata_fut, tables_fut)?;

        let mut acc: std::collections::BTreeMap<String, Vec<TableInfo>> = Default::default();
        for (schema,) in schema_rows {
            acc.entry(schema).or_default();
        }
        for (schema, table, kind) in table_rows {
            acc.entry(schema).or_default().push(TableInfo {
                name: table,
                kind: if kind == "VIEW" { TableKind::View } else { TableKind::Table },
                row_count: None,
            });
        }
        let result: Vec<SchemaInfo> = acc
            .into_iter()
            .map(|(name, tables)| SchemaInfo { name, tables })
            .collect();
        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        let table_total: usize = result.iter().map(|s| s.tables.len()).sum();
        log_line!(
            "list_schemas",
            "← {} schemas, {} tables total ({:.1}ms)",
            result.len(),
            table_total,
            total_ms,
        );
        Ok(result)
    }

    pub async fn describe_table(&self, schema: &str, table: &str) -> Result<TableStructure, AdapterError> {
        let t_total = Instant::now();

        let cols_fut = async {
            let t = Instant::now();
            let r = sqlx::query_as::<_, (
                String,
                String,
                String,
                Option<String>,
                Option<i64>,
                String,
                Option<String>,
                Option<String>,
            )>(
                r#"SELECT CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_TYPE AS CHAR CHARACTER SET utf8mb4),
                          CAST(IS_NULLABLE AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_DEFAULT AS CHAR CHARACTER SET utf8mb4),
                          CAST(CHARACTER_MAXIMUM_LENGTH AS SIGNED) AS CHARACTER_MAXIMUM_LENGTH,
                          CAST(EXTRA AS CHAR CHARACTER SET utf8mb4),
                          CAST(CHARACTER_SET_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLLATION_NAME AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                   ORDER BY ORDINAL_POSITION"#,
            )
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await?;
            Ok::<_, sqlx::Error>((r, t.elapsed().as_secs_f64() * 1000.0))
        };

        let kind_fut = async {
            let t = Instant::now();
            let r: (String, Option<i64>) = sqlx::query_as(
                "SELECT CAST(TABLE_TYPE AS CHAR CHARACTER SET utf8mb4), CAST(TABLE_ROWS AS SIGNED) AS TABLE_ROWS \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            )
            .bind(schema)
            .bind(table)
            .fetch_one(&self.pool)
            .await?;
            Ok::<_, sqlx::Error>((r, t.elapsed().as_secs_f64() * 1000.0))
        };

        let idx_fut = async {
            let t = Instant::now();
            let r = sqlx::query_as::<_, (String, String, i64, i64, String)>(
                r#"SELECT CAST(INDEX_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(SEQ_IN_INDEX AS SIGNED),
                          CAST(NON_UNIQUE AS SIGNED),
                          CAST(INDEX_TYPE AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                   ORDER BY INDEX_NAME, SEQ_IN_INDEX"#,
            )
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await?;
            Ok::<_, sqlx::Error>((r, t.elapsed().as_secs_f64() * 1000.0))
        };

        let fk_fut = async {
            let t = Instant::now();
            let r = sqlx::query_as::<_, (
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<String>,
                Option<String>,
            )>(
                // Join REFERENTIAL_CONSTRAINTS for the ON UPDATE / ON DELETE
                // rules (KEY_COLUMN_USAGE doesn't carry them), so the schema
                // editor shows the real actions instead of always NO ACTION.
                r#"SELECT CAST(kcu.CONSTRAINT_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(kcu.COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(kcu.REFERENCED_TABLE_SCHEMA AS CHAR CHARACTER SET utf8mb4),
                          CAST(kcu.REFERENCED_TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(kcu.REFERENCED_COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(kcu.POSITION_IN_UNIQUE_CONSTRAINT AS SIGNED),
                          CAST(rc.UPDATE_RULE AS CHAR CHARACTER SET utf8mb4),
                          CAST(rc.DELETE_RULE AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.KEY_COLUMN_USAGE kcu
                   LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                          ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
                         AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                         AND rc.TABLE_NAME = kcu.TABLE_NAME
                   WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
                   ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"#,
            )
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await;
            (r, t.elapsed().as_secs_f64() * 1000.0)
        };

        let ((col_rows, cols_ms), ((kind_str, row_count), kind_ms), (idx_rows, idx_ms), (fk_rows_res, fk_ms)) =
            tokio::try_join!(cols_fut, kind_fut, idx_fut, async { Ok::<_, sqlx::Error>(fk_fut.await) })?;

        if col_rows.is_empty() {
            return Err(AdapterError::NotFound(format!("{schema}.{table} not found")));
        }

        let mut indexes_map: std::collections::BTreeMap<String, (Vec<String>, bool, String)> = Default::default();
        for (name, col, _seq, non_unique, index_type) in idx_rows {
            let entry = indexes_map
                .entry(name)
                .or_insert_with(|| (Vec::new(), non_unique == 0, index_type.clone()));
            entry.0.push(col);
            entry.1 = entry.1 && non_unique == 0;
        }

        let mut primary_key: Vec<String> = Vec::new();
        let mut indexed_cols: std::collections::BTreeSet<String> = Default::default();
        let mut unique_single: std::collections::BTreeSet<String> = Default::default();
        for (name, (cols, unique, _index_type)) in &indexes_map {
            for c in cols {
                indexed_cols.insert(c.clone());
            }
            if name == "PRIMARY" {
                primary_key = cols.clone();
            } else if *unique && cols.len() == 1 {
                unique_single.insert(cols[0].clone());
            }
        }

        let fk_rows: Vec<(String, String, String, String, String, Option<i64>, Option<String>, Option<String>)> = match fk_rows_res {
            Ok(rows) => rows
                .into_iter()
                .filter_map(|(name, col, ref_s, ref_t, ref_c, pos, upd, del)| {
                    match (ref_s, ref_t, ref_c) {
                        (Some(rs), Some(rt), Some(rc)) => Some((name, col, rs, rt, rc, pos, upd, del)),
                        _ => None,
                    }
                })
                .collect(),
            Err(e) => {
                log_line!("describe_table", "FK query failed: {}", e);
                Vec::new()
            }
        };

        #[derive(Default)]
        struct FkAcc {
            from_cols: Vec<String>,
            to_schema: String,
            to_table: String,
            to_cols: Vec<String>,
            on_update: Option<String>,
            on_delete: Option<String>,
        }
        let mut fk_map: std::collections::BTreeMap<String, FkAcc> = Default::default();
        let mut fk_cols_set: std::collections::BTreeSet<String> = Default::default();
        for (name, col, ref_schema, ref_table, ref_col, _pos, on_update, on_delete) in fk_rows {
            fk_cols_set.insert(col.clone());
            let entry = fk_map.entry(name).or_default();
            entry.from_cols.push(col);
            entry.to_schema = ref_schema;
            entry.to_table = ref_table;
            entry.to_cols.push(ref_col);
            // MySQL reports rules as canonical SQL already (CASCADE / SET NULL
            // / NO ACTION / RESTRICT / SET DEFAULT). Keep the first non-null.
            if entry.on_update.is_none() { entry.on_update = on_update; }
            if entry.on_delete.is_none() { entry.on_delete = on_delete; }
        }

        let columns = col_rows
            .into_iter()
            .map(|(name, data_type, is_nullable, default, length, extra, character_set, collation)| ColumnInfo {
                is_primary: primary_key.contains(&name),
                is_unique: unique_single.contains(&name),
                is_foreign: fk_cols_set.contains(&name),
                is_indexed: indexed_cols.contains(&name),
                nullable: is_nullable.eq_ignore_ascii_case("YES"),
                default,
                length,
                data_type,
                extra,
                character_set,
                collation,
                name,
            })
            .collect();

        let indexes = indexes_map
            .into_iter()
            .map(|(name, (columns, unique, index_type))| IndexInfo {
                is_primary: name.eq_ignore_ascii_case("PRIMARY"),
                name,
                columns,
                unique,
                algorithm: Some(index_type),
            })
            .collect();

        let foreign_keys = fk_map
            .into_iter()
            .map(|(name, acc)| ForeignKey {
                name,
                from_schema: schema.to_string(),
                from_table: table.to_string(),
                from_columns: acc.from_cols,
                to_schema: acc.to_schema,
                to_table: acc.to_table,
                to_columns: acc.to_cols,
                on_update: acc.on_update,
                on_delete: acc.on_delete,
            })
            .collect();

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        log_line!(
            "describe_table",
            "{}.{}: total={:.1}ms (cols={:.1}, kind/rows={:.1}, idx={:.1}, fk={:.1})",
            schema,
            table,
            total_ms,
            cols_ms,
            kind_ms,
            idx_ms,
            fk_ms,
        );

        Ok(TableStructure {
            schema: schema.to_string(),
            name: table.to_string(),
            kind: if kind_str == "VIEW" { TableKind::View } else { TableKind::Table },
            columns,
            indexes,
            primary_key,
            foreign_keys,
            row_count: row_count.map(|n| n.max(0) as u64),
        })
    }

    pub async fn describe_schema(&self, schema: &str) -> Result<Vec<TableStructure>, AdapterError> {
        let t_total = Instant::now();

        let tables_fut = async {
            sqlx::query_as::<_, (String, String, Option<i64>)>(
                r#"SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(TABLE_TYPE AS CHAR CHARACTER SET utf8mb4),
                          CAST(TABLE_ROWS AS SIGNED) AS TABLE_ROWS
                   FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA = ?
                   ORDER BY TABLE_NAME"#,
            )
            .bind(schema)
            .fetch_all(&self.pool)
            .await
        };

        let cols_fut = async {
            sqlx::query_as::<_, (
                String,
                String,
                String,
                String,
                Option<String>,
                Option<i64>,
                String,
                Option<String>,
                Option<String>,
            )>(
                r#"SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_TYPE AS CHAR CHARACTER SET utf8mb4),
                          CAST(IS_NULLABLE AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_DEFAULT AS CHAR CHARACTER SET utf8mb4),
                          CAST(CHARACTER_MAXIMUM_LENGTH AS SIGNED) AS CHARACTER_MAXIMUM_LENGTH,
                          CAST(EXTRA AS CHAR CHARACTER SET utf8mb4),
                          CAST(CHARACTER_SET_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLLATION_NAME AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = ?
                   ORDER BY TABLE_NAME, ORDINAL_POSITION"#,
            )
            .bind(schema)
            .fetch_all(&self.pool)
            .await
        };

        let idx_fut = async {
            sqlx::query_as::<_, (String, String, String, i64, i64, String)>(
                r#"SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(INDEX_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(SEQ_IN_INDEX AS SIGNED),
                          CAST(NON_UNIQUE AS SIGNED),
                          CAST(INDEX_TYPE AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.STATISTICS
                   WHERE TABLE_SCHEMA = ?
                   ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"#,
            )
            .bind(schema)
            .fetch_all(&self.pool)
            .await
        };

        let fk_fut = async {
            sqlx::query_as::<_, (
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
            )>(
                r#"SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(CONSTRAINT_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(REFERENCED_TABLE_SCHEMA AS CHAR CHARACTER SET utf8mb4),
                          CAST(REFERENCED_TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                          CAST(REFERENCED_COLUMN_NAME AS CHAR CHARACTER SET utf8mb4)
                   FROM information_schema.KEY_COLUMN_USAGE
                   WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                   ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION"#,
            )
            .bind(schema)
            .fetch_all(&self.pool)
            .await
        };

        let (tables, cols, idx, fk) = tokio::try_join!(tables_fut, cols_fut, idx_fut, fk_fut)?;

        let mut cols_by_table: std::collections::BTreeMap<
            String,
            Vec<(String, String, String, Option<String>, Option<i64>, String, Option<String>, Option<String>)>,
        > = Default::default();
        for (tbl, name, data_type, is_nullable, default, length, extra, charset, collation) in cols {
            cols_by_table
                .entry(tbl)
                .or_default()
                .push((name, data_type, is_nullable, default, length, extra, charset, collation));
        }

        let mut idx_by_table: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, (Vec<String>, bool, String)>,
        > = Default::default();
        for (tbl, idx_name, col_name, _seq, non_unique, index_type) in idx {
            let per_table = idx_by_table.entry(tbl).or_default();
            let entry = per_table
                .entry(idx_name)
                .or_insert_with(|| (Vec::new(), non_unique == 0, index_type.clone()));
            entry.0.push(col_name);
            entry.1 = entry.1 && non_unique == 0;
        }

        #[derive(Default)]
        struct FkAcc {
            from_cols: Vec<String>,
            to_schema: String,
            to_table: String,
            to_cols: Vec<String>,
        }
        let mut fk_by_table: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, FkAcc>,
        > = Default::default();
        for (tbl, constraint_name, col, ref_schema, ref_table, ref_col) in fk {
            if let (Some(rs), Some(rt), Some(rc)) = (ref_schema, ref_table, ref_col) {
                let per_table = fk_by_table.entry(tbl).or_default();
                let entry = per_table.entry(constraint_name).or_default();
                entry.from_cols.push(col);
                entry.to_schema = rs;
                entry.to_table = rt;
                entry.to_cols.push(rc);
            }
        }

        let mut out: Vec<TableStructure> = Vec::with_capacity(tables.len());
        for (table, kind_str, row_count) in tables {
            let col_rows = cols_by_table.remove(&table).unwrap_or_default();
            if col_rows.is_empty() {
                continue;
            }

            let indexes_map = idx_by_table.remove(&table).unwrap_or_default();
            let mut primary_key: Vec<String> = Vec::new();
            let mut indexed_cols: std::collections::BTreeSet<String> = Default::default();
            let mut unique_single: std::collections::BTreeSet<String> = Default::default();
            for (name, (cols, unique, _index_type)) in &indexes_map {
                for c in cols { indexed_cols.insert(c.clone()); }
                if name == "PRIMARY" {
                    primary_key = cols.clone();
                } else if *unique && cols.len() == 1 {
                    unique_single.insert(cols[0].clone());
                }
            }

            let fk_map = fk_by_table.remove(&table).unwrap_or_default();
            let mut fk_cols_set: std::collections::BTreeSet<String> = Default::default();
            for (_, acc) in &fk_map {
                for c in &acc.from_cols { fk_cols_set.insert(c.clone()); }
            }

            let columns = col_rows
                .into_iter()
                .map(|(name, data_type, is_nullable, default, length, extra, character_set, collation)| ColumnInfo {
                    is_primary: primary_key.contains(&name),
                    is_unique: unique_single.contains(&name),
                    is_foreign: fk_cols_set.contains(&name),
                    is_indexed: indexed_cols.contains(&name),
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    default,
                    length,
                    data_type,
                    extra,
                    character_set,
                    collation,
                    name,
                })
                .collect();

            let indexes = indexes_map
                .into_iter()
                .map(|(name, (columns, unique, index_type))| IndexInfo {
                    is_primary: name.eq_ignore_ascii_case("PRIMARY"),
                    name,
                    columns,
                    unique,
                    algorithm: Some(index_type),
                })
                .collect();

            let foreign_keys = fk_map
                .into_iter()
                .map(|(name, acc)| ForeignKey {
                    name,
                    from_schema: schema.to_string(),
                    from_table: table.clone(),
                    from_columns: acc.from_cols,
                    to_schema: acc.to_schema,
                    to_table: acc.to_table,
                    to_columns: acc.to_cols,
                    // Bulk schema scan doesn't fetch referential rules; the
                    // per-table editor uses describe_table which does.
                    on_update: None,
                    on_delete: None,
                })
                .collect();

            out.push(TableStructure {
                schema: schema.to_string(),
                name: table,
                kind: if kind_str == "VIEW" { TableKind::View } else { TableKind::Table },
                columns,
                indexes,
                primary_key,
                foreign_keys,
                row_count: row_count.map(|n| n.max(0) as u64),
            });
        }

        log_line!(
            "describe_schema",
            "{}: {} tables in {:.1}ms",
            schema,
            out.len(),
            t_total.elapsed().as_secs_f64() * 1000.0,
        );
        Ok(out)
    }

    pub async fn list_relations(&self, schema: &str) -> Result<Vec<ForeignKey>, AdapterError> {
        let rows = sqlx::query_as::<_, (String, String, String, String, String, String, i64)>(
            r#"SELECT CAST(TABLE_SCHEMA AS CHAR CHARACTER SET utf8mb4),
                      CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(REFERENCED_TABLE_SCHEMA AS CHAR CHARACTER SET utf8mb4),
                      CAST(REFERENCED_TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(REFERENCED_COLUMN_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(ORDINAL_POSITION AS SIGNED)
               FROM information_schema.KEY_COLUMN_USAGE
               WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
               ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;

        let mut grouped: std::collections::BTreeMap<String, ForeignKey> = Default::default();
        for (from_schema, from_table, from_col, to_schema, to_table, to_col, _pos) in rows {
            let key = format!("{from_schema}.{from_table}->{to_schema}.{to_table}");
            let entry = grouped.entry(key.clone()).or_insert_with(|| ForeignKey {
                name: key.clone(),
                from_schema: from_schema.clone(),
                from_table: from_table.clone(),
                from_columns: Vec::new(),
                to_schema: to_schema.clone(),
                to_table: to_table.clone(),
                to_columns: Vec::new(),
                // Relations view doesn't need referential actions.
                on_update: None,
                on_delete: None,
            });
            entry.from_columns.push(from_col);
            entry.to_columns.push(to_col);
        }
        Ok(grouped.into_values().collect())
    }

    pub async fn run_query(
        &self,
        statement: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        self.run_query_scoped(statement, row_limit, None).await
    }

    pub async fn run_query_scoped(
        &self,
        statement: &str,
        row_limit: Option<u32>,
        scope_db: Option<&str>,
    ) -> Result<QueryResult, AdapterError> {
        self.run_query_scoped_with_sink(statement, row_limit, scope_db, None).await
    }

    pub async fn run_query_scoped_stream(
        &self,
        statement: &str,
        row_limit: Option<u32>,
        scope_db: Option<&str>,
        sink: tokio::sync::mpsc::UnboundedSender<StatementResult>,
    ) -> Result<QueryResult, AdapterError> {
        self.run_query_scoped_with_sink(statement, row_limit, scope_db, Some(sink)).await
    }

    async fn run_query_scoped_with_sink(
        &self,
        statement: &str,
        row_limit: Option<u32>,
        scope_db: Option<&str>,
        sink: Option<tokio::sync::mpsc::UnboundedSender<StatementResult>>,
    ) -> Result<QueryResult, AdapterError> {
        let statements = split_statements(statement);
        let mut results = Vec::with_capacity(statements.len());

        let t_acquire = Instant::now();
        let mut conn = self.pool.acquire().await?;
        let acquire_ms = t_acquire.elapsed().as_secs_f64() * 1000.0;
        log_line!(
            "run_query",
            "batch of {} statements (pool.acquire={:.1}ms, pool.size={})",
            statements.len(),
            acquire_ms,
            self.pool.size(),
        );

        // Ensure the connection is using the right database. The pool may
        // have been created without a default database (profile has none),
        // but the user selected one via the sidebar picker later.
        if let Some(db) = scope_db.or(self.default_db.as_deref()) {
            use sqlx::Executor;
            let _ = conn.execute(format!("USE `{db}`").as_str()).await;
        }

        for sql in statements {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                continue;
            }
            log_line!("run_query", "→ {}", trimmed);
            let started = Instant::now();
            let stmt_result = if is_query(trimmed) {
                execute_query(&mut conn, trimmed, row_limit).await
            } else {
                execute_statement(&mut conn, trimmed).await
            };
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

            match &stmt_result {
                Ok(_) => log_line!("run_query", "  ok ({:.1}ms)", duration_ms),
                Err(e) => log_line!("run_query", "  ERR ({:.1}ms): {}", duration_ms, e),
            }

            match stmt_result {
                Ok(mut r) => {
                    r.sql = trimmed.to_string();
                    r.duration_ms = duration_ms;
                    if let Some(sink) = &sink {
                        let _ = sink.send(r.clone());
                    }
                    results.push(r);
                }
                Err(e) => {
                    let mut msg = e.to_string();
                    if msg.contains("Cannot add foreign key constraint")
                        || msg.contains("foreign key constraint fails")
                    {
                        if let Some(detail) = fetch_latest_innodb_fk_error(&mut conn).await {
                            log_line!("run_query", "  fk-detail: {}", detail);
                            msg = format!("{msg}\n\nLATEST FOREIGN KEY ERROR:\n{detail}");
                        }
                    }
                    let r = StatementResult {
                        sql: trimmed.to_string(),
                        duration_ms,
                        columns: Vec::new(),
                        rows: Vec::new(),
                        rows_affected: None,
                        error: Some(msg),
                        truncated: false,
                    };
                    if let Some(sink) = &sink {
                        let _ = sink.send(r.clone());
                    }
                    results.push(r);
                }
            }
        }

        Ok(QueryResult { statements: results })
    }

    /// Issue a row-scoped UPDATE. Returns the number of affected rows.
    /// Called by the adapter's `mutate` path.
    pub async fn update_rows(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[adapter_api::PrimaryKeyValue],
        changes: &std::collections::BTreeMap<String, JsonValue>,
    ) -> Result<u64, AdapterError> {
        if changes.is_empty() {
            return Ok(0);
        }
        if primary_key.is_empty() {
            return Err(AdapterError::Unsupported(
                "row editing requires a primary key on the table".into(),
            ));
        }

        let mut sql = String::from("UPDATE ");
        sql.push_str(&quote_ident(schema));
        sql.push('.');
        sql.push_str(&quote_ident(table));
        sql.push_str(" SET ");
        for (i, col) in changes.keys().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&quote_ident(col));
            sql.push_str(" = ?");
        }
        sql.push_str(" WHERE ");
        for (i, pk) in primary_key.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&quote_ident(&pk.column));
            sql.push_str(" = ?");
        }

        let mut q = sqlx::query(&sql);
        for v in changes.values() {
            q = bind_json(q, v);
        }
        for pk in primary_key {
            q = bind_json(q, &pk.value);
        }
        let res = q.execute(&self.pool).await?;
        Ok(res.rows_affected())
    }

    pub async fn list_views(&self, schema: &str) -> Result<Vec<ViewInfo>, AdapterError> {
        let rows = sqlx::query_as::<_, (String, String)>(
            r#"SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(IS_UPDATABLE AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.VIEWS
               WHERE TABLE_SCHEMA = ?
               ORDER BY TABLE_NAME"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, updatable)| ViewInfo {
                name,
                is_updatable: updatable.eq_ignore_ascii_case("YES"),
            })
            .collect())
    }

    /// `CREATE OR REPLACE VIEW` DDL for one view, for SQL export. Built from
    /// `information_schema.VIEWS.VIEW_DEFINITION` rather than `SHOW CREATE VIEW`
    /// so the output carries no `DEFINER=` clause — that user rarely exists on
    /// the destination server and would make the import fail.
    pub async fn view_definition(&self, schema: &str, name: &str) -> Result<String, AdapterError> {
        let def: String = sqlx::query_scalar(
            r#"SELECT CAST(VIEW_DEFINITION AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.VIEWS
               WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?"#,
        )
        .bind(schema)
        .bind(name)
        .fetch_one(&self.pool)
        .await?;
        let qn = format!("`{}`", name.replace('`', "``"));
        Ok(format!("CREATE OR REPLACE VIEW {qn} AS {def};"))
    }

    pub async fn list_routines(&self, schema: &str) -> Result<Vec<RoutineInfo>, AdapterError> {
        let routine_rows = sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"SELECT CAST(ROUTINE_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(ROUTINE_TYPE AS CHAR CHARACTER SET utf8mb4),
                      CAST(DTD_IDENTIFIER AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.ROUTINES
               WHERE ROUTINE_SCHEMA = ?
               ORDER BY ROUTINE_NAME"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;

        let param_rows = sqlx::query_as::<_, (String, Option<String>, Option<String>, String, Option<i64>)>(
            r#"SELECT CAST(SPECIFIC_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(PARAMETER_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(PARAMETER_MODE AS CHAR CHARACTER SET utf8mb4),
                      CAST(DTD_IDENTIFIER AS CHAR CHARACTER SET utf8mb4),
                      CAST(ORDINAL_POSITION AS SIGNED)
               FROM information_schema.PARAMETERS
               WHERE SPECIFIC_SCHEMA = ?
               ORDER BY SPECIFIC_NAME, ORDINAL_POSITION"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;

        let mut params_by_routine: std::collections::HashMap<String, Vec<RoutineParam>> =
            Default::default();
        for (specific, pname, mode, dtd, pos) in param_rows {
            if pos.unwrap_or(1) == 0 {
                continue;
            }
            params_by_routine
                .entry(specific)
                .or_default()
                .push(RoutineParam {
                    name: pname.unwrap_or_default(),
                    data_type: dtd,
                    mode,
                });
        }

        Ok(routine_rows
            .into_iter()
            .map(|(name, kind, returns)| {
                let parameters = params_by_routine.remove(&name).unwrap_or_default();
                RoutineInfo {
                    name,
                    kind: kind.to_ascii_lowercase(),
                    returns,
                    parameters,
                }
            })
            .collect())
    }

    pub async fn describe_routine(
        &self,
        schema: &str,
        name: &str,
        kind: &str,
    ) -> Result<RoutineDefinition, AdapterError> {
        let kind_upper = kind.to_ascii_uppercase();
        if kind_upper != "FUNCTION" && kind_upper != "PROCEDURE" {
            return Err(AdapterError::Unsupported(format!(
                "describe_routine: unknown kind `{kind}`"
            )));
        }

        let meta: (Option<String>, Option<String>, String, String, String, String, String) = sqlx::query_as(
            r#"SELECT CAST(ROUTINE_DEFINITION AS CHAR CHARACTER SET utf8mb4),
                      CAST(DTD_IDENTIFIER AS CHAR CHARACTER SET utf8mb4),
                      CAST(IS_DETERMINISTIC AS CHAR CHARACTER SET utf8mb4),
                      CAST(SQL_DATA_ACCESS AS CHAR CHARACTER SET utf8mb4),
                      CAST(SECURITY_TYPE AS CHAR CHARACTER SET utf8mb4),
                      CAST(DEFINER AS CHAR CHARACTER SET utf8mb4),
                      CAST(ROUTINE_TYPE AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.ROUTINES
               WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?"#,
        )
        .bind(schema)
        .bind(name)
        .bind(&kind_upper)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => AdapterError::NotFound(format!("{schema}.{name} ({kind})")),
            other => other.into(),
        })?;
        let (body_opt, returns, is_det, data_access, security, definer, _kind_out) = meta;

        let param_rows = sqlx::query_as::<_, (Option<String>, Option<String>, String, Option<i64>)>(
            r#"SELECT CAST(PARAMETER_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(PARAMETER_MODE AS CHAR CHARACTER SET utf8mb4),
                      CAST(DTD_IDENTIFIER AS CHAR CHARACTER SET utf8mb4),
                      CAST(ORDINAL_POSITION AS SIGNED)
               FROM information_schema.PARAMETERS
               WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ?
               ORDER BY ORDINAL_POSITION"#,
        )
        .bind(schema)
        .bind(name)
        .fetch_all(&self.pool)
        .await?;

        let parameters: Vec<RoutineParam> = param_rows
            .into_iter()
            .filter_map(|(pname, mode, dtd, pos)| {
                if pos.unwrap_or(1) == 0 {
                    None
                } else {
                    Some(RoutineParam {
                        name: pname.unwrap_or_default(),
                        data_type: dtd,
                        mode,
                    })
                }
            })
            .collect();

        let create_q = format!(
            "SHOW CREATE {kind_upper} `{}`.`{}`",
            schema.replace('`', "``"),
            name.replace('`', "``"),
        );
        use sqlx::Row;
        let create_row = sqlx::query(&create_q).fetch_one(&self.pool).await?;
        let create_sql: String = create_row.try_get::<String, _>(2).unwrap_or_default();

        Ok(RoutineDefinition {
            schema: schema.to_string(),
            name: name.to_string(),
            kind: kind_upper.to_ascii_lowercase(),
            returns: if kind_upper == "FUNCTION" { returns } else { None },
            parameters,
            body: body_opt.unwrap_or_default(),
            is_deterministic: is_det.eq_ignore_ascii_case("YES"),
            data_access,
            security_type: security,
            definer,
            create_sql,
        })
    }

    pub async fn list_triggers(&self, schema: &str) -> Result<Vec<TriggerInfo>, AdapterError> {
        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            r#"SELECT CAST(TRIGGER_NAME AS CHAR CHARACTER SET utf8mb4),
                      CAST(EVENT_OBJECT_TABLE AS CHAR CHARACTER SET utf8mb4),
                      CAST(ACTION_TIMING AS CHAR CHARACTER SET utf8mb4),
                      CAST(EVENT_MANIPULATION AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.TRIGGERS
               WHERE TRIGGER_SCHEMA = ?
               ORDER BY TRIGGER_NAME"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, table, timing, event)| TriggerInfo {
                name,
                table,
                timing,
                event,
            })
            .collect())
    }

    pub async fn describe_trigger(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<TriggerDefinition, AdapterError> {
        let meta: (String, String, String, String) = sqlx::query_as(
            r#"SELECT CAST(EVENT_OBJECT_TABLE AS CHAR CHARACTER SET utf8mb4),
                      CAST(ACTION_TIMING AS CHAR CHARACTER SET utf8mb4),
                      CAST(EVENT_MANIPULATION AS CHAR CHARACTER SET utf8mb4),
                      CAST(ACTION_STATEMENT AS CHAR CHARACTER SET utf8mb4)
               FROM information_schema.TRIGGERS
               WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?"#,
        )
        .bind(schema)
        .bind(name)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => AdapterError::NotFound(format!("{schema}.{name} (trigger)")),
            other => other.into(),
        })?;
        let (table, timing, event, body) = meta;

        // Reconstruct a runnable CREATE TRIGGER (information_schema doesn't store
        // the full original text). `ACTION_STATEMENT` is the body after
        // `FOR EACH ROW`, which is exactly what we need.
        let create_sql = format!(
            "CREATE TRIGGER {}\n{} {} ON {}\nFOR EACH ROW\n{}",
            quote_ident(name),
            timing,
            event,
            quote_ident(&table),
            body,
        );

        Ok(TriggerDefinition {
            schema: schema.to_string(),
            name: name.to_string(),
            table,
            timing,
            event,
            body,
            create_sql,
        })
    }

    pub async fn save_trigger(&self, req: SaveTriggerRequest) -> Result<(), AdapterError> {
        // MySQL has no CREATE OR REPLACE TRIGGER — drop the old one first when
        // editing, then create. Run on a single connection so the drop+create
        // see a consistent catalog.
        let mut conn = self.pool.acquire().await?;

        // Pooled connections have no default database, so an unqualified table
        // in `CREATE TRIGGER … ON tbl` (and a bare trigger name in DROP) fails
        // with "No database selected". Select the trigger's schema first so the
        // statements resolve against it. The trigger and its table always live
        // in the same database in MySQL.
        if !req.schema.trim().is_empty() {
            let use_sql = format!("USE {}", quote_ident(req.schema.trim()));
            conn.execute(use_sql.as_str()).await?;
        }

        // Drop the previous definition when editing (rename or in-place edit).
        if let Some(orig) = req.original_name.as_deref() {
            if !orig.is_empty() {
                let drop_sql = format!("DROP TRIGGER IF EXISTS {}", quote_ident(orig));
                conn.execute(drop_sql.as_str()).await?;
            }
        } else {
            // New trigger sharing a name with an existing one would error; make
            // creation idempotent from the editor's perspective.
            let drop_sql = format!("DROP TRIGGER IF EXISTS {}", quote_ident(&req.name));
            conn.execute(drop_sql.as_str()).await?;
        }

        let create_sql = build_trigger_create_sql(&req)?;
        conn.execute(create_sql.as_str()).await?;
        Ok(())
    }

    pub async fn drop_trigger(
        &self,
        schema: &str,
        name: &str,
        _table: &str,
    ) -> Result<(), AdapterError> {
        // `DROP TRIGGER schema.name` — qualify with the schema so it works on a
        // pooled connection with no default database selected.
        let qualified = if schema.trim().is_empty() {
            quote_ident(name)
        } else {
            format!("{}.{}", quote_ident(schema.trim()), quote_ident(name))
        };
        let sql = format!("DROP TRIGGER IF EXISTS {qualified}");
        sqlx::query(&sql).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn create_database(
        &self,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<(), AdapterError> {
        if !is_safe_ident(name) {
            return Err(AdapterError::Unsupported(
                "database name contains unsupported characters".into(),
            ));
        }
        let mut sql = format!("CREATE DATABASE {}", quote_ident(name));
        if let Some(cs) = charset {
            if !is_safe_ident(cs) {
                return Err(AdapterError::Unsupported("charset contains unsupported characters".into()));
            }
            sql.push_str(&format!(" CHARACTER SET {cs}"));
        }
        if let Some(co) = collation {
            if !is_safe_ident(co) {
                return Err(AdapterError::Unsupported("collation contains unsupported characters".into()));
            }
            sql.push_str(&format!(" COLLATE {co}"));
        }
        sqlx::query(&sql).execute(&self.pool).await?;
        Ok(())
    }

    /// Encodings the live server understands for new databases.
    /// `SHOW CHARACTER SET` returns one row per supported charset;
    /// we project just the name. The list is alphabetised so the
    /// dialog renders a stable order across reconnects.
    pub async fn list_charsets(&self) -> Result<Vec<String>, AdapterError> {
        let mut rows: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SHOW CHARACTER SET",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        rows.sort_unstable();
        Ok(rows)
    }

    /// Collations available for `charset`. We use `information_schema`
    /// (rather than `SHOW COLLATION LIKE …`) so the result is
    /// strict-name match, not pattern. The default collation is
    /// returned first, with the rest alphabetised — preserving the
    /// "default is the safe pick" affordance in the UI without
    /// hardcoding a name.
    pub async fn list_collations(&self, charset: &str) -> Result<Vec<String>, AdapterError> {
        if !is_safe_ident(charset) {
            return Err(AdapterError::Unsupported(
                "charset contains unsupported characters".into(),
            ));
        }
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT COLLATION_NAME, IS_DEFAULT \
             FROM information_schema.COLLATIONS \
             WHERE CHARACTER_SET_NAME = ?",
        )
        .bind(charset)
        .fetch_all(&self.pool)
        .await?;
        let mut defaults: Vec<String> = Vec::new();
        let mut others: Vec<String> = Vec::new();
        for (name, is_default) in rows {
            if is_default == "Yes" { defaults.push(name); } else { others.push(name); }
        }
        defaults.sort_unstable();
        others.sort_unstable();
        defaults.extend(others);
        Ok(defaults)
    }

    /// Every collation on the server, alphabetised. Used by the schema
    /// editor's per-column collation dropdown, which isn't scoped to a
    /// single charset.
    pub async fn list_all_collations(&self) -> Result<Vec<String>, AdapterError> {
        let mut rows: Vec<String> = sqlx::query_as::<_, (String,)>(
            "SELECT COLLATION_NAME FROM information_schema.COLLATIONS",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(n,)| n)
        .collect();
        rows.sort_unstable();
        Ok(rows)
    }

    pub async fn shutdown(&self) {
        self.pool.close().await;
    }
}

fn is_safe_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(crate) fn quote_ident(ident: &str) -> String {
    let escaped = ident.replace('`', "``");
    format!("`{escaped}`")
}

/// Assemble a MySQL `CREATE TRIGGER` statement from a structured save request.
/// When the editor supplies a raw `create_sql`, that wins (free-form DDL mode);
/// otherwise we build it from the timing/event/table/body fields.
fn build_trigger_create_sql(req: &SaveTriggerRequest) -> Result<String, AdapterError> {
    if let Some(raw) = req.create_sql.as_deref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    if req.name.trim().is_empty() {
        return Err(AdapterError::Unsupported("trigger name is required".into()));
    }
    if req.table.trim().is_empty() {
        return Err(AdapterError::Unsupported("trigger table is required".into()));
    }
    let timing = req.timing.trim().to_ascii_uppercase();
    let event = req.event.trim().to_ascii_uppercase();
    // MySQL only allows BEFORE/AFTER and a single INSERT/UPDATE/DELETE event.
    if !matches!(timing.as_str(), "BEFORE" | "AFTER") {
        return Err(AdapterError::Unsupported(format!(
            "MySQL trigger timing must be BEFORE or AFTER (got `{}`)",
            req.timing
        )));
    }
    if !matches!(event.as_str(), "INSERT" | "UPDATE" | "DELETE") {
        return Err(AdapterError::Unsupported(format!(
            "MySQL trigger event must be INSERT, UPDATE or DELETE (got `{}`)",
            req.event
        )));
    }
    let mut body = req.body.trim().to_string();
    if body.is_empty() {
        return Err(AdapterError::Unsupported("trigger body is required".into()));
    }
    // Allow the user to omit the trailing semicolon on a single-statement body;
    // MySQL needs the action statement terminated. Wrapping BEGIN…END bodies
    // already carry their own terminators.
    let upper = body.to_ascii_uppercase();
    if !upper.starts_with("BEGIN") && !body.ends_with(';') {
        body.push(';');
    }
    Ok(format!(
        "CREATE TRIGGER {}\n{} {} ON {}\nFOR EACH ROW\n{}",
        quote_ident(req.name.trim()),
        timing,
        event,
        quote_ident(req.table.trim()),
        body,
    ))
}

fn is_routine_ddl(upper: &str) -> bool {
    let verb_then = |verb: &str| -> Option<&str> {
        upper.strip_prefix(verb).map(|rest| rest.trim_start())
    };
    let rest = verb_then("CREATE ")
        .or_else(|| verb_then("DROP "))
        .or_else(|| verb_then("ALTER "));
    let Some(mut rest) = rest else { return false };
    loop {
        if let Some(r) = rest.strip_prefix("IF NOT EXISTS ") { rest = r.trim_start(); continue; }
        if let Some(r) = rest.strip_prefix("IF EXISTS ") { rest = r.trim_start(); continue; }
        if let Some(r) = rest.strip_prefix("OR REPLACE ") { rest = r.trim_start(); continue; }
        if rest.starts_with("DEFINER") {
            if let Some(idx) = rest.find(char::is_whitespace) {
                rest = rest[idx..].trim_start();
                continue;
            }
            break;
        }
        break;
    }
    rest.starts_with("PROCEDURE ")
        || rest.starts_with("FUNCTION ")
        || rest.starts_with("TRIGGER ")
        || rest.starts_with("EVENT ")
}

fn is_query(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    head.starts_with("SELECT")
        || head.starts_with("SHOW")
        || head.starts_with("DESCRIBE")
        || head.starts_with("EXPLAIN")
        || head.starts_with("WITH")
}

/// Does the SQL already contain a top-level `LIMIT` clause? Ignores LIMIT
/// tokens that appear inside quotes/backticks so we don't misfire on a
/// column or literal named `LIMIT`.
fn has_limit_clause(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_back = false;
    let mut prev: u8 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' if !in_double && !in_back && prev != b'\\' => in_single = !in_single,
            b'"' if !in_single && !in_back && prev != b'\\' => in_double = !in_double,
            b'`' if !in_single && !in_double => in_back = !in_back,
            b'L' | b'l' if !in_single && !in_double && !in_back => {
                let boundary_before = i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r');
                let end = i + 5;
                if boundary_before && end < bytes.len() {
                    let chunk = &bytes[i + 1..end + 1];
                    let matches_limit = chunk.eq_ignore_ascii_case(b"IMIT ")
                        || chunk.eq_ignore_ascii_case(b"IMIT\t")
                        || chunk.eq_ignore_ascii_case(b"IMIT\n");
                    if matches_limit {
                        return true;
                    }
                }
            }
            _ => {}
        }
        prev = b;
        i += 1;
    }
    false
}


pub(crate) fn split_statements(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_back = false;
    let mut in_block_comment = false;
    let mut prev = '\0';
    let mut delim: String = ";".into();

    for raw_line in input.split_inclusive('\n') {
        if !in_single && !in_double && !in_back && !in_block_comment && buf.trim().is_empty() {
            let trimmed = raw_line.trim_start();
            if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("DELIMITER") {
                let rest = trimmed[9..].trim();
                let token = rest.trim_end_matches(';').trim();
                if !token.is_empty() {
                    delim = token.to_string();
                }
                continue;
            }
        }

        let mut chars = raw_line.chars().peekable();
        while let Some(ch) = chars.next() {
            if in_block_comment {
                buf.push(ch);
                if ch == '*' && chars.peek() == Some(&'/') {
                    buf.push('/');
                    chars.next();
                    in_block_comment = false;
                }
                prev = ch;
                continue;
            }
            match ch {
                '\'' if !in_double && !in_back && prev != '\\' => in_single = !in_single,
                '"' if !in_single && !in_back && prev != '\\' => in_double = !in_double,
                '`' if !in_single && !in_double => in_back = !in_back,
                '-' if !in_single && !in_double && !in_back && chars.peek() == Some(&'-') => {
                    buf.push(ch);
                    for nc in chars.by_ref() {
                        buf.push(nc);
                        if nc == '\n' {
                            break;
                        }
                    }
                    prev = '\n';
                    continue;
                }
                '#' if !in_single && !in_double && !in_back => {
                    buf.push(ch);
                    for nc in chars.by_ref() {
                        buf.push(nc);
                        if nc == '\n' {
                            break;
                        }
                    }
                    prev = '\n';
                    continue;
                }
                '/' if !in_single && !in_double && !in_back && chars.peek() == Some(&'*') => {
                    buf.push(ch);
                    buf.push('*');
                    chars.next();
                    in_block_comment = true;
                    prev = '*';
                    continue;
                }
                _ => {}
            }

            if !in_single && !in_double && !in_back && starts_with_delim(ch, &mut chars, &delim) {
                if !buf.trim().is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
                prev = ch;
                continue;
            }

            buf.push(ch);
            prev = ch;
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

fn starts_with_delim(first: char, chars: &mut std::iter::Peekable<std::str::Chars<'_>>, delim: &str) -> bool {
    let mut iter = delim.chars();
    let Some(d0) = iter.next() else { return false };
    if first != d0 {
        return false;
    }
    let mut look = chars.clone();
    for expected in iter {
        match look.next() {
            Some(c) if c == expected => {}
            _ => return false,
        }
    }
    for _ in 1..delim.chars().count() {
        chars.next();
    }
    true
}

async fn fetch_latest_innodb_fk_error(conn: &mut sqlx::MySqlConnection) -> Option<String> {
    use sqlx::Row;
    let row = sqlx::query("SHOW ENGINE INNODB STATUS")
        .fetch_one(&mut *conn)
        .await
        .ok()?;
    let status: String = row.try_get("Status").ok()?;
    let start = status.find("LATEST FOREIGN KEY ERROR")?;
    let tail = &status[start..];
    let after_header = tail.find('\n').map(|n| &tail[n + 1..]).unwrap_or(tail);
    let end = after_header.find("\n------------------------")
        .unwrap_or(after_header.len().min(4000));
    Some(after_header[..end].trim().to_string())
}

async fn execute_query(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    row_limit: Option<u32>,
) -> Result<StatementResult, AdapterError> {
    // Bound the statement. A caller-supplied `row_limit` is used when present;
    // otherwise a hard safety ceiling is applied so an unbounded `SELECT *`
    // can't flood memory/the UI. A `LIMIT` the user already wrote is respected
    // as-is (no cap applied).
    let cap = if has_limit_clause(sql) {
        None
    } else {
        Some(row_limit.unwrap_or(adapter_api::MAX_RESULT_ROWS))
    };
    let effective = match cap {
        Some(limit) => format!("{sql} LIMIT {limit}"),
        None => sql.to_string(),
    };

    log_line!("run_query", "  sqlx←{}", effective.replace('\n', " ⏎ "));
    let t_fetch = Instant::now();
    let rows: Vec<MySqlRow> = sqlx::query(&effective).fetch_all(&mut *conn).await?;
    let fetch_ms = t_fetch.elapsed().as_secs_f64() * 1000.0;
    let truncated = matches!(cap, Some(limit) if rows.len() as u32 >= limit);

    let t_meta = Instant::now();
    let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c: &MySqlColumn| ColumnMeta {
                name: c.name().to_string(),
                type_hint: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        conn.describe(effective.as_str())
            .await
            .ok()
            .map(|d| {
                d.columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        type_hint: c.type_info().name().to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let meta_ms = t_meta.elapsed().as_secs_f64() * 1000.0;

    let type_names: Vec<String> = if let Some(first) = rows.first() {
        first.columns().iter().map(|c| c.type_info().name().to_string()).collect()
    } else {
        columns.iter().map(|c| c.type_hint.clone()).collect()
    };
    let t_decode = Instant::now();
    let json_rows: Vec<Vec<JsonValue>> = rows
        .iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(i, _)| column_to_json(row, i, type_names.get(i).map(|s| s.as_str()).unwrap_or("")))
                .collect()
        })
        .collect();
    let decode_ms = t_decode.elapsed().as_secs_f64() * 1000.0;

    let approx_bytes: usize = json_rows
        .iter()
        .map(|r| r.iter().map(approx_json_size).sum::<usize>())
        .sum();
    log_line!(
        "run_query",
        "  timings fetch={:.1}ms meta={:.1}ms decode={:.1}ms rows={} cols={} approx_bytes={}",
        fetch_ms,
        meta_ms,
        decode_ms,
        rows.len(),
        columns.len(),
        approx_bytes,
    );

    Ok(StatementResult {
        sql: effective,
        duration_ms: 0.0,
        columns,
        rows: json_rows,
        rows_affected: None,
        error: None,
        truncated,
    })
}

fn approx_json_size(v: &JsonValue) -> usize {
    match v {
        JsonValue::Null => 4,
        JsonValue::Bool(_) => 5,
        JsonValue::Number(n) => n.to_string().len(),
        JsonValue::String(s) => s.len() + 2,
        JsonValue::Array(a) => a.iter().map(approx_json_size).sum::<usize>() + 2,
        JsonValue::Object(o) => o.iter().map(|(k, v)| k.len() + 3 + approx_json_size(v)).sum::<usize>() + 2,
    }
}

async fn execute_statement(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
) -> Result<StatementResult, AdapterError> {
    let trimmed_upper = sql.trim_start().to_ascii_uppercase();
    let needs_text_protocol = trimmed_upper.starts_with("USE ")
        || trimmed_upper.starts_with("SET ")
        || trimmed_upper.starts_with("LOCK ")
        || trimmed_upper.starts_with("UNLOCK ")
        || trimmed_upper.starts_with("ALTER ")
        || trimmed_upper.starts_with("CREATE ")
        || trimmed_upper.starts_with("DROP ")
        || trimmed_upper.starts_with("RENAME ")
        || trimmed_upper.starts_with("TRUNCATE ")
        || is_routine_ddl(&trimmed_upper);

    if needs_text_protocol {
        use sqlx::Executor;
        log_line!("execute", "→ TEXT: {}", sql);
        conn.execute(sql).await?;
        log_line!("execute", "  TEXT ok");
        return Ok(StatementResult {
            sql: sql.to_string(),
            duration_ms: 0.0,
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some(0),
            error: None,
            truncated: false,
        });
    }

    log_line!("execute", "→ PREP: {}", sql);
    let res = sqlx::query(sql).execute(&mut *conn).await?;
    log_line!("execute", "  PREP ok, rows_affected={}", res.rows_affected());
    Ok(StatementResult {
        sql: sql.to_string(),
        duration_ms: 0.0,
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: Some(res.rows_affected()),
        error: None,
        truncated: false,
    })
}

/// Convert a single MySQL column to a JSON value the UI can render.
/// Dispatch on the MySQL type name first so integer columns don't get picked up
/// as bools (TINYINT(1) vs BIGINT is ambiguous in sqlx's fallback chain).
pub(crate) fn column_to_json(row: &MySqlRow, idx: usize, type_name: &str) -> JsonValue {
    let t = type_name.to_ascii_uppercase();
    let is_unsigned = t.contains("UNSIGNED");

    if t.starts_with("TINYINT") {
        if is_unsigned {
            if let Ok(v) = row.try_get::<Option<u8>, _>(idx) {
                return v.map(|n| JsonValue::from(n as u64)).unwrap_or(JsonValue::Null);
            }
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(idx) {
            return v.map(|n| JsonValue::from(n as i64)).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("SMALLINT") || t.starts_with("MEDIUMINT") || t == "INT" || t == "INTEGER" || t.starts_with("INT ") || t.starts_with("BIGINT") {
        if is_unsigned {
            if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
                return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
            }
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("FLOAT") || t.starts_with("DOUBLE") {
        if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("DECIMAL") || t.starts_with("NUMERIC") {
        if let Ok(v) = row.try_get::<Option<BigDecimal>, _>(idx) {
            return v.map(|d| JsonValue::String(d.to_string())).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("BOOL") || t == "BOOLEAN" || t == "BIT" {
        if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("TIMESTAMP") {
        if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(idx) {
            return v.map(|d| JsonValue::String(d.to_rfc3339())).unwrap_or(JsonValue::Null);
        }
    }
    if t.starts_with("DATETIME") {
        if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(idx) {
            return v.map(|d| JsonValue::String(d.to_string())).unwrap_or(JsonValue::Null);
        }
    }
    if t == "DATE" {
        if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(idx) {
            return v.map(|d| JsonValue::String(d.to_string())).unwrap_or(JsonValue::Null);
        }
    }
    if t == "TIME" {
        if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(idx) {
            return v.map(|d| JsonValue::String(d.to_string())).unwrap_or(JsonValue::Null);
        }
    }
    if t == "JSON" {
        if let Ok(v) = row.try_get::<Option<JsonValue>, _>(idx) {
            return v.unwrap_or(JsonValue::Null);
        }
    }

    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        // A "text" column can still hold binary (bytes shoved into text/varchar).
        // Show hex when it does, so the cell isn't blank/garbled.
        return v
            .map(|s| {
                if adapter_api::looks_binary(s.as_bytes()) {
                    JsonValue::String(adapter_api::bytes_to_hex_upper(s.as_bytes()))
                } else {
                    JsonValue::String(s)
                }
            })
            .unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return v
            .map(|bytes| {
                if adapter_api::looks_binary(&bytes) {
                    JsonValue::String(adapter_api::bytes_to_hex_upper(&bytes))
                } else {
                    JsonValue::String(String::from_utf8_lossy(&bytes).into_owned())
                }
            })
            .unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(idx) {
        return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
    }
    JsonValue::Null
}

pub(crate) fn bind_json<'q>(
    q: sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>,
    v: &'q JsonValue,
) -> sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments> {
    match v {
        JsonValue::Null => q.bind(Option::<String>::None),
        JsonValue::Bool(b) => q.bind(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else if let Some(f) = n.as_f64() {
                q.bind(f)
            } else {
                q.bind(n.to_string())
            }
        }
        JsonValue::String(s) => q.bind(s.clone()),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            q.bind(serde_json::to_string(v).unwrap_or_default())
        }
    }
}

// ---- Process list / kill ----

impl MysqlDriver {
    pub async fn process_list(&self) -> Result<Vec<ProcessInfo>, AdapterError> {
        let mut conn = self.pool.acquire().await?;
        let rows = sqlx::query("SHOW FULL PROCESSLIST")
            .fetch_all(&mut *conn)
            .await?;

        let mut processes = Vec::with_capacity(rows.len());
        for row in rows {
            let cols = row.columns();
            let mut id_str = String::new();
            let mut user = String::new();
            let mut host = String::new();
            let mut db: Option<String> = None;
            let mut command = String::new();
            let mut time: i64 = 0;
            let mut state: Option<String> = None;
            let mut info: Option<String> = None;

            for (i, col) in cols.iter().enumerate() {
                let name = col.name().to_ascii_lowercase();
                match name.as_str() {
                    "id" => {
                        if let Ok(v) = row.try_get::<i64, _>(i) {
                            id_str = v.to_string();
                        } else if let Ok(v) = row.try_get::<String, _>(i) {
                            id_str = v;
                        }
                    }
                    "user" => {
                        user = row.try_get::<String, _>(i).unwrap_or_default();
                    }
                    "host" => {
                        host = row.try_get::<String, _>(i).unwrap_or_default();
                    }
                    "db" => {
                        db = row.try_get::<String, _>(i).ok();
                    }
                    "command" => {
                        command = row.try_get::<String, _>(i).unwrap_or_default();
                    }
                    "time" => {
                        time = row.try_get::<i64, _>(i).unwrap_or(0);
                    }
                    "state" => {
                        state = row.try_get::<String, _>(i).ok();
                    }
                    "info" => {
                        info = row.try_get::<String, _>(i).ok();
                    }
                    _ => {}
                }
            }

            if id_str.is_empty() {
                continue;
            }

            let kind = match command.to_ascii_uppercase().as_str() {
                "QUERY" => ProcessKind::Query,
                "SLEEP" => ProcessKind::Sleep,
                _ => ProcessKind::Other(command.clone()),
            };

            processes.push(ProcessInfo {
                id: id_str,
                user: Some(user),
                host: Some(host),
                database: db,
                command: Some(command),
                time: Some(time.max(0) as u64),
                state,
                info,
                kind,
            });
        }

        Ok(processes)
    }

    pub async fn kill_process(&self, id: &str) -> Result<(), AdapterError> {
        let _id: u64 = id.parse().map_err(|_| {
            AdapterError::Other(format!("invalid process id: {id}"))
        })?;
        let mut conn = self.pool.acquire().await?;
        sqlx::query(&format!("KILL {_id}"))
            .execute(&mut *conn)
            .await?;
        Ok(())
    }

    pub async fn kill_processes(&self, ids: &[String]) -> Result<Vec<KillResult>, AdapterError> {
        let mut conn = self.pool.acquire().await?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let parsed: u64 = match id.parse() {
                Ok(n) => n,
                Err(_) => {
                    results.push(KillResult {
                        id: id.clone(),
                        success: false,
                        error: Some(format!("invalid process id: {id}")),
                    });
                    continue;
                }
            };
            match sqlx::query(&format!("KILL {parsed}"))
                .execute(&mut *conn)
                .await
            {
                Ok(_) => results.push(KillResult {
                    id: id.clone(),
                    success: true,
                    error: None,
                }),
                Err(e) => results.push(KillResult {
                    id: id.clone(),
                    success: false,
                    error: Some(e.to_string()),
                }),
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod limit_tests {
    use super::has_limit_clause;

    #[test]
    fn detects_inline_limit() {
        assert!(has_limit_clause("SELECT * FROM t LIMIT 10"));
    }

    #[test]
    fn detects_lowercase_limit() {
        assert!(has_limit_clause("SELECT * FROM t limit 10"));
    }

    #[test]
    fn detects_newline_before_limit() {
        assert!(has_limit_clause("SELECT * FROM t\nLIMIT 10"));
    }

    #[test]
    fn ignores_limit_inside_string() {
        assert!(!has_limit_clause("SELECT 'LIMIT 10' AS x"));
    }

    #[test]
    fn ignores_limit_inside_backtick() {
        assert!(!has_limit_clause("SELECT `LIMIT` FROM t"));
    }

    #[test]
    fn ignores_no_limit() {
        assert!(!has_limit_clause("SELECT status FROM t WHERE x = 'a'"));
    }

    #[test]
    fn ignores_collimit_lookalike() {
        assert!(!has_limit_clause("SELECT COLLIMIT FROM t"));
    }
}
