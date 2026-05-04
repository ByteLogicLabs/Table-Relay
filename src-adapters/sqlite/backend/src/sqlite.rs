//! SQLite driver backed by sqlx.
//!
//! The "connection" here is a local file (or `:memory:`); a single sqlx
//! pool serves every query. Introspection lives on `sqlite_schema` and
//! the `PRAGMA` family — there is no `information_schema`.

use std::path::Path;
use std::time::Instant;

use adapter_api::log_line;
use adapter_api::{
    AdapterError, ColumnInfo, ColumnMeta, ForeignKey, IndexInfo, QueryResult, SchemaInfo,
    ServerInfo, StatementResult, TableInfo, TableKind, TableStructure, ViewInfo,
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::{Value as JsonValue, json};
use sqlx::sqlite::{
    SqliteColumn, SqliteConnectOptions, SqlitePoolOptions, SqliteRow,
};
use sqlx::{Column, Executor, Pool, Row, Sqlite, TypeInfo};
use std::str::FromStr;

/// The single schema every SQLite database exposes. ATTACH DATABASE support
/// isn't wired in yet — if we add it later, this constant stays as the
/// default and the adapter appends the attached names.
pub(crate) const MAIN_SCHEMA: &str = "main";

pub struct SqliteDriver {
    pub(crate) pool: Pool<Sqlite>,
    #[allow(dead_code)]
    pub(crate) path: String,
}

/// Connection inputs — just the file path. We accept `:memory:` verbatim so
/// the driver can serve a throwaway test DB without a filesystem roundtrip.
pub struct SqliteConfig {
    pub path: String,
}

impl SqliteDriver {
    pub async fn connect(cfg: SqliteConfig) -> Result<Self, AdapterError> {
        let t_total = Instant::now();
        log_line!("sqlite_connect", "→ path={}", cfg.path);

        // sqlx's SqliteConnectOptions accepts either a path or `:memory:`.
        // `from_str` handles both via the `sqlite://` URL shape and the
        // filename shortcut.
        let opts = SqliteConnectOptions::from_str(&cfg.path)
            .map_err(|e| AdapterError::Connection(format!("invalid sqlite path: {e}")))?
            // Create the file if missing — matches MySQL's "you pointed at
            // an empty database and we opened it" behaviour, and lets users
            // spin up a new database without shelling out first.
            .create_if_missing(true)
            // Enforce FK constraints — off by default for backwards-compat in
            // sqlite itself, but every sane modern workflow wants them on.
            .foreign_keys(true)
            // WAL journal mode: multiple readers can proceed while a single
            // writer commits. For read-heavy browse workloads this removes
            // the `SQLITE_BUSY` stalls that rollback-journal mode gets on
            // bigger databases, and it avoids rewriting the whole journal
            // on every commit.
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            // NORMAL sync is the recommended WAL pairing — durable across
            // app crashes, only loses data on OS-level power loss (same
            // trade most desktop SQLite apps make).
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

        // Do NOT set `min_connections` — it makes the pool block on the
        // first cold connection serially. Lazy creation (on first query)
        // lets `connect_with` return as soon as the first handshake
        // completes, which is all we need for `ping` below.
        let t_pool = Instant::now();
        let pool = match SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(std::time::Duration::from_secs(30))
            .connect_with(opts)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                log_line!(
                    "sqlite_connect",
                    "  pool connect failed after {:.1}ms: {}",
                    t_pool.elapsed().as_secs_f64() * 1000.0,
                    e,
                );
                return Err(e.into());
            }
        };
        log_line!(
            "sqlite_connect",
            "  pool ready ({:.1}ms, total {:.1}ms)",
            t_pool.elapsed().as_secs_f64() * 1000.0,
            t_total.elapsed().as_secs_f64() * 1000.0,
        );
        Ok(Self {
            pool,
            path: cfg.path,
        })
    }
}

impl SqliteDriver {
    pub async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        let version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&self.pool)
            .await?;
        let (version_major, version_minor) = parse_semver(&version);
        log_line!(
            "sqlite_ping",
            "version={} parsed=({:?}.{:?})",
            version,
            version_major,
            version_minor,
        );
        Ok(ServerInfo {
            adapter_id: "sqlite".into(),
            version,
            version_major,
            version_minor,
            flavor: Some("SQLite".into()),
            default_schema: Some(MAIN_SCHEMA.into()),
        })
    }

    pub async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        let t_total = Instant::now();

        // `sqlite_schema` lists every user object in `main`. Exclude the
        // auto-generated `sqlite_*` tables so the sidebar isn't cluttered.
        let rows = sqlx::query_as::<_, (String, String)>(
            r#"SELECT name, type
               FROM sqlite_schema
               WHERE type IN ('table', 'view')
                 AND name NOT LIKE 'sqlite_%'
               ORDER BY name"#,
        )
        .fetch_all(&self.pool)
        .await?;

        let tables: Vec<TableInfo> = rows
            .into_iter()
            .map(|(name, kind)| TableInfo {
                name,
                kind: if kind == "view" {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                row_count: None,
            })
            .collect();

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        log_line!(
            "list_schemas",
            "← 1 schema, {} tables ({:.1}ms)",
            tables.len(),
            total_ms,
        );

        Ok(vec![SchemaInfo {
            name: MAIN_SCHEMA.into(),
            tables,
        }])
    }

    pub async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, AdapterError> {
        // SQLite has exactly one schema in this cut. Accept "main" / "" /
        // anything else identifier-shaped and treat it as main.
        ensure_main_schema(schema)?;

        let t_total = Instant::now();

        let kind_row: Option<(String,)> = sqlx::query_as(
            "SELECT type FROM sqlite_schema WHERE name = ? AND type IN ('table','view')",
        )
        .bind(table)
        .fetch_optional(&self.pool)
        .await?;
        let kind_str = match kind_row {
            Some((t,)) => t,
            None => {
                return Err(AdapterError::NotFound(format!(
                    "{schema}.{table} not found"
                )));
            }
        };

        // `PRAGMA table_info(<table>)` returns: cid, name, type, notnull,
        // dflt_value, pk. The pk column is the 1-based ordinal within the
        // primary key (or 0 if not part of the PK).
        let col_rows: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as(&format!("PRAGMA table_info({})", quote_ident(table)))
                .fetch_all(&self.pool)
                .await?;

        if col_rows.is_empty() {
            return Err(AdapterError::NotFound(format!(
                "{schema}.{table} not found"
            )));
        }

        // Primary key — ordered by the pk column's numeric value.
        let mut pk_pairs: Vec<(i64, String)> = col_rows
            .iter()
            .filter(|c| c.5 > 0)
            .map(|c| (c.5, c.1.clone()))
            .collect();
        pk_pairs.sort_by_key(|(ord, _)| *ord);
        let primary_key: Vec<String> = pk_pairs.into_iter().map(|(_, n)| n).collect();

        // Indexes — `PRAGMA index_list` plus one `PRAGMA index_info` per
        // index. Keep the SQL-level parallelism simple; real-world tables
        // rarely have enough indexes to justify tokio::try_join noise.
        let index_list: Vec<(i64, String, i64, String, i64)> =
            sqlx::query_as(&format!("PRAGMA index_list({})", quote_ident(table)))
                .fetch_all(&self.pool)
                .await?;

        let mut indexes: Vec<IndexInfo> = Vec::with_capacity(index_list.len());
        let mut indexed_cols: std::collections::BTreeSet<String> = Default::default();
        let mut unique_single: std::collections::BTreeSet<String> = Default::default();
        for (_seq, name, unique_flag, _origin, _partial) in &index_list {
            let info: Vec<(i64, i64, String)> =
                sqlx::query_as(&format!("PRAGMA index_info({})", quote_ident(name)))
                    .fetch_all(&self.pool)
                    .await?;
            let columns: Vec<String> = info.into_iter().map(|(_, _, col)| col).collect();
            for c in &columns {
                indexed_cols.insert(c.clone());
            }
            let unique = *unique_flag == 1;
            if unique && columns.len() == 1 {
                unique_single.insert(columns[0].clone());
            }
            indexes.push(IndexInfo {
                name: name.clone(),
                columns,
                unique,
            });
        }

        // Foreign keys — `PRAGMA foreign_key_list` returns per-column
        // entries with an `id` that groups composite FKs.
        let fk_rows: Vec<(i64, i64, String, String, String, String, String, String)> =
            sqlx::query_as(&format!(
                "PRAGMA foreign_key_list({})",
                quote_ident(table)
            ))
            .fetch_all(&self.pool)
            .await?;

        #[derive(Default)]
        struct FkAcc {
            from_cols: Vec<String>,
            to_table: String,
            to_cols: Vec<String>,
        }
        let mut fk_map: std::collections::BTreeMap<i64, FkAcc> = Default::default();
        let mut fk_cols_set: std::collections::BTreeSet<String> = Default::default();
        for (id, _seq, to_tbl, from_col, to_col, _on_update, _on_delete, _match) in fk_rows {
            fk_cols_set.insert(from_col.clone());
            let entry = fk_map.entry(id).or_default();
            entry.from_cols.push(from_col);
            entry.to_table = to_tbl;
            entry.to_cols.push(to_col);
        }
        let foreign_keys: Vec<ForeignKey> = fk_map
            .into_iter()
            .map(|(id, acc)| ForeignKey {
                // SQLite foreign keys don't carry user-defined names — the
                // PRAGMA only returns a numeric id. Stitching the id into
                // the name keeps it unique + diffable across describe calls.
                name: format!("fk_{id}"),
                from_schema: MAIN_SCHEMA.into(),
                from_table: table.into(),
                from_columns: acc.from_cols,
                to_schema: MAIN_SCHEMA.into(),
                to_table: acc.to_table,
                to_columns: acc.to_cols,
            })
            .collect();

        // Row count — optional, can be expensive on large tables. Treat
        // errors (e.g. a corrupt view's backing query) as "don't know".
        let row_count: Option<u64> =
            sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {}", quote_ident(table)))
                .fetch_one(&self.pool)
                .await
                .ok()
                .map(|n| n.max(0) as u64);

        let columns: Vec<ColumnInfo> = col_rows
            .into_iter()
            .map(|(_cid, name, data_type, notnull, default, pk_ord)| ColumnInfo {
                is_primary: pk_ord > 0,
                is_unique: unique_single.contains(&name),
                is_foreign: fk_cols_set.contains(&name),
                is_indexed: indexed_cols.contains(&name),
                nullable: notnull == 0,
                default,
                length: None,
                data_type,
                extra: String::new(),
                character_set: None,
                collation: None,
                name,
            })
            .collect();

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        log_line!(
            "describe_table",
            "{}.{}: total={:.1}ms (cols={}, indexes={}, fks={})",
            schema,
            table,
            total_ms,
            columns.len(),
            indexes.len(),
            foreign_keys.len(),
        );

        Ok(TableStructure {
            schema: MAIN_SCHEMA.into(),
            name: table.into(),
            kind: if kind_str == "view" {
                TableKind::View
            } else {
                TableKind::Table
            },
            columns,
            indexes,
            primary_key,
            foreign_keys,
            row_count,
        })
    }

    pub async fn describe_schema(
        &self,
        schema: &str,
    ) -> Result<Vec<TableStructure>, AdapterError> {
        ensure_main_schema(schema)?;
        // Fan-out `describe_table` per object. SQLite pragmas are
        // per-table so there's no single information_schema-style
        // round-trip to replace this.
        let schemas = self.list_schemas().await?;
        let Some(info) = schemas.into_iter().next() else {
            return Ok(Vec::new());
        };
        let mut out = Vec::with_capacity(info.tables.len());
        for t in info.tables {
            if let Ok(structure) = self.describe_table(MAIN_SCHEMA, &t.name).await {
                out.push(structure);
            }
        }
        Ok(out)
    }

    pub async fn list_relations(
        &self,
        schema: &str,
    ) -> Result<Vec<ForeignKey>, AdapterError> {
        ensure_main_schema(schema)?;
        // Aggregate foreign keys from every table in the schema. One
        // `PRAGMA foreign_key_list` per table; the total is bounded by
        // the number of user tables (small in practice for SQLite files).
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut out: Vec<ForeignKey> = Vec::new();
        for (table_name,) in tables {
            let rows: Vec<(i64, i64, String, String, String, String, String, String)> =
                sqlx::query_as(&format!(
                    "PRAGMA foreign_key_list({})",
                    quote_ident(&table_name)
                ))
                .fetch_all(&self.pool)
                .await?;

            #[derive(Default)]
            struct Acc {
                from_cols: Vec<String>,
                to_table: String,
                to_cols: Vec<String>,
            }
            let mut grouped: std::collections::BTreeMap<i64, Acc> = Default::default();
            for (id, _seq, to_tbl, from_col, to_col, _on_u, _on_d, _match) in rows {
                let entry = grouped.entry(id).or_default();
                entry.from_cols.push(from_col);
                entry.to_table = to_tbl;
                entry.to_cols.push(to_col);
            }
            for (id, acc) in grouped {
                out.push(ForeignKey {
                    name: format!("{table_name}_fk_{id}"),
                    from_schema: MAIN_SCHEMA.into(),
                    from_table: table_name.clone(),
                    from_columns: acc.from_cols,
                    to_schema: MAIN_SCHEMA.into(),
                    to_table: acc.to_table,
                    to_columns: acc.to_cols,
                });
            }
        }
        Ok(out)
    }

    pub async fn list_views(&self, schema: &str) -> Result<Vec<ViewInfo>, AdapterError> {
        ensure_main_schema(schema)?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_schema WHERE type = 'view' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        // SQLite views are never updatable via INSERT/UPDATE/DELETE unless
        // the user has defined INSTEAD OF triggers. We don't inspect those
        // here — report `false` so the grid doesn't offer row editing on a
        // view that'll reject every write.
        Ok(rows
            .into_iter()
            .map(|(name,)| ViewInfo {
                name,
                is_updatable: false,
            })
            .collect())
    }

    pub async fn run_query(
        &self,
        statement: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError> {
        self.run_query_with_sink(statement, row_limit, None).await
    }

    pub async fn run_query_stream(
        &self,
        statement: &str,
        row_limit: Option<u32>,
        sink: tokio::sync::mpsc::UnboundedSender<StatementResult>,
    ) -> Result<QueryResult, AdapterError> {
        self.run_query_with_sink(statement, row_limit, Some(sink)).await
    }

    async fn run_query_with_sink(
        &self,
        statement: &str,
        row_limit: Option<u32>,
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
                    let r = StatementResult {
                        sql: trimmed.to_string(),
                        duration_ms,
                        columns: Vec::new(),
                        rows: Vec::new(),
                        rows_affected: None,
                        error: Some(e.to_string()),
                    };
                    if let Some(sink) = &sink {
                        let _ = sink.send(r.clone());
                    }
                    results.push(r);
                }
            }
        }

        Ok(QueryResult {
            statements: results,
        })
    }

    /// Issue a row-scoped UPDATE. Returns the number of affected rows.
    pub async fn update_rows(
        &self,
        schema: &str,
        table: &str,
        primary_key: &[adapter_api::PrimaryKeyValue],
        changes: &std::collections::BTreeMap<String, JsonValue>,
    ) -> Result<u64, AdapterError> {
        ensure_main_schema(schema)?;

        if changes.is_empty() {
            return Ok(0);
        }
        if primary_key.is_empty() {
            return Err(AdapterError::Unsupported(
                "row editing requires a primary key on the table".into(),
            ));
        }

        let mut sql = String::from("UPDATE ");
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

    pub async fn shutdown(&self) {
        self.pool.close().await;
    }
}

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

fn ensure_main_schema(schema: &str) -> Result<(), AdapterError> {
    // Allow "", "main", or any case variant. Everything else is a hard
    // NotFound — if a caller asked for ATTACH-style "otherdb", we'd need
    // to implement ATTACH first.
    if schema.is_empty() || schema.eq_ignore_ascii_case(MAIN_SCHEMA) {
        Ok(())
    } else {
        Err(AdapterError::NotFound(format!(
            "SQLite adapter only exposes the `main` schema; got `{schema}`"
        )))
    }
}

pub(crate) fn quote_ident(ident: &str) -> String {
    // SQLite supports double-quoted identifiers per SQL standard. Escape
    // embedded double quotes by doubling them up.
    let escaped = ident.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn is_query(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    head.starts_with("SELECT")
        || head.starts_with("WITH")
        || head.starts_with("PRAGMA")
        || head.starts_with("EXPLAIN")
}

/// Does the SQL already contain a top-level `LIMIT` clause? Same
/// quote/backtick-aware scan as the MySQL adapter.
fn has_limit_clause(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut prev: u8 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\'' if !in_double && prev != b'\\' => in_single = !in_single,
            b'"' if !in_single && prev != b'\\' => in_double = !in_double,
            b'L' | b'l' if !in_single && !in_double => {
                let boundary_before =
                    i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r');
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

/// Simple statement splitter. SQLite doesn't have MySQL's `DELIMITER` so
/// this stays simpler than the MySQL version.
fn split_statements(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_block_comment = false;
    let mut prev = '\0';
    let mut chars = input.chars().peekable();

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
            '\'' if !in_double && prev != '\\' => in_single = !in_single,
            '"' if !in_single && prev != '\\' => in_double = !in_double,
            '-' if !in_single && !in_double && chars.peek() == Some(&'-') => {
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
            '/' if !in_single && !in_double && chars.peek() == Some(&'*') => {
                buf.push(ch);
                buf.push('*');
                chars.next();
                in_block_comment = true;
                prev = '*';
                continue;
            }
            ';' if !in_single && !in_double => {
                if !buf.trim().is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
                prev = ch;
                continue;
            }
            _ => {}
        }
        buf.push(ch);
        prev = ch;
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

async fn execute_query(
    conn: &mut sqlx::SqliteConnection,
    sql: &str,
    row_limit: Option<u32>,
) -> Result<StatementResult, AdapterError> {
    let effective = if let Some(limit) = row_limit {
        if has_limit_clause(sql) {
            sql.to_string()
        } else {
            format!("{sql} LIMIT {limit}")
        }
    } else {
        sql.to_string()
    };

    let t_fetch = Instant::now();
    let rows: Vec<SqliteRow> = sqlx::query(&effective).fetch_all(&mut *conn).await?;
    let fetch_ms = t_fetch.elapsed().as_secs_f64() * 1000.0;

    let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c: &SqliteColumn| ColumnMeta {
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

    let type_names: Vec<String> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c| c.type_info().name().to_string())
            .collect()
    } else {
        columns.iter().map(|c| c.type_hint.clone()).collect()
    };

    let json_rows: Vec<Vec<JsonValue>> = rows
        .iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    column_to_json(row, i, type_names.get(i).map(|s| s.as_str()).unwrap_or(""))
                })
                .collect()
        })
        .collect();

    log_line!(
        "run_query",
        "  fetch={:.1}ms rows={} cols={}",
        fetch_ms,
        rows.len(),
        columns.len(),
    );

    Ok(StatementResult {
        sql: effective,
        duration_ms: 0.0,
        columns,
        rows: json_rows,
        rows_affected: None,
        error: None,
    })
}

async fn execute_statement(
    conn: &mut sqlx::SqliteConnection,
    sql: &str,
) -> Result<StatementResult, AdapterError> {
    let res = sqlx::query(sql).execute(&mut *conn).await?;
    Ok(StatementResult {
        sql: sql.to_string(),
        duration_ms: 0.0,
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: Some(res.rows_affected()),
        error: None,
    })
}

/// Convert a single SQLite column to JSON. SQLite uses affinity rather than
/// strict types, so the declared type is a hint — we try affinity first,
/// then fall back to string/blob.
pub(crate) fn column_to_json(row: &SqliteRow, idx: usize, type_name: &str) -> JsonValue {
    let t = type_name.to_ascii_uppercase();

    // Affinity rules per SQLite docs: anything mentioning INT → INTEGER,
    // REAL/FLOA/DOUB → REAL, anything with CHAR/CLOB/TEXT → TEXT, BLOB → BLOB,
    // everything else → NUMERIC.
    let is_int = t.contains("INT");
    let is_real = t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB");
    let is_text = t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT");
    let is_blob = t.contains("BLOB") || t.is_empty();
    let is_bool = t == "BOOLEAN" || t == "BOOL";
    let is_date = t == "DATE";
    let is_datetime = t == "DATETIME" || t == "TIMESTAMP";
    let is_time = t == "TIME";
    let is_json = t == "JSON";

    if is_bool {
        if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if is_json {
        if let Ok(v) = row.try_get::<Option<JsonValue>, _>(idx) {
            return v.unwrap_or(JsonValue::Null);
        }
    }
    if is_datetime {
        if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_rfc3339()))
                .unwrap_or(JsonValue::Null);
        }
        if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if is_date {
        if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if is_time {
        if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if is_int {
        if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if is_real {
        if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if is_text {
        if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            return v.map(JsonValue::String).unwrap_or(JsonValue::Null);
        }
    }
    if is_blob {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
            return v
                .map(|bytes| match std::str::from_utf8(&bytes) {
                    Ok(s) => JsonValue::String(s.to_string()),
                    Err(_) => json!({ "__binary__": true, "bytes": bytes.len() }),
                })
                .unwrap_or(JsonValue::Null);
        }
    }

    // Fallback chain: try the flexible types in order. SQLite is
    // dynamically typed so the affinity above is only a hint.
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
        return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
        return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
        return v.map(JsonValue::String).unwrap_or(JsonValue::Null);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) {
        return v
            .map(|bytes| match std::str::from_utf8(&bytes) {
                Ok(s) => JsonValue::String(s.to_string()),
                Err(_) => json!({ "__binary__": true, "bytes": bytes.len() }),
            })
            .unwrap_or(JsonValue::Null);
    }
    JsonValue::Null
}

pub(crate) fn bind_json<'q>(
    q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &'q JsonValue,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
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

/// Accept `Path` references too so the factory can construct a config
/// from either a raw string or a path buffer without stringifying twice.
#[allow(dead_code)]
pub(crate) fn path_as_string<P: AsRef<Path>>(p: P) -> String {
    p.as_ref().to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_main_accepts_variants() {
        assert!(ensure_main_schema("").is_ok());
        assert!(ensure_main_schema("main").is_ok());
        assert!(ensure_main_schema("MAIN").is_ok());
        assert!(ensure_main_schema("other").is_err());
    }

    #[test]
    fn quote_ident_escapes_double_quotes() {
        assert_eq!(quote_ident("table"), "\"table\"");
        assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
    }

    #[test]
    fn parse_semver_handles_sqlite_shape() {
        let (maj, min) = parse_semver("3.45.2");
        assert_eq!(maj, Some(3));
        assert_eq!(min, Some(45));
    }

    #[test]
    fn has_limit_clause_detects_and_ignores() {
        assert!(has_limit_clause("SELECT * FROM t LIMIT 10"));
        assert!(!has_limit_clause("SELECT 'LIMIT 10' AS x"));
        assert!(!has_limit_clause("SELECT \"LIMIT\" FROM t"));
    }
}
