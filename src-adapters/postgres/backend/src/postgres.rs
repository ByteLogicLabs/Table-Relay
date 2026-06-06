//! PostgreSQL driver backed by sqlx.
//!
//! Mirrors the MySQL driver's shape: owns a `PgPool`, exposes inherent
//! methods for every `Adapter` trait call, and translates to PG-native
//! SQL (double-quoted identifiers, `$N` placeholders, pg_catalog
//! introspection, standard `LIMIT n OFFSET k`).
//!
//! "Schema" in this file means a PostgreSQL schema (namespace) like
//! `public`, not a database. One connection = one database; switching
//! databases means opening a new connection.

use std::time::Instant;

use adapter_api::log_line;
use adapter_api::{
    AdapterError, ColumnInfo, ColumnMeta, ForeignKey, IndexInfo, KillResult, ProcessInfo,
    ProcessKind, QueryResult, RoutineDefinition, RoutineInfo, RoutineParam, SaveTriggerRequest,
    SchemaInfo, ServerInfo, StatementResult, TableInfo, TableKind, TableStructure,
    TriggerDefinition, TriggerInfo, ViewInfo,
};
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::{Value as JsonValue, json};
use sqlx::postgres::{PgColumn, PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, Executor, Pool, Postgres, Row, TypeInfo};

pub struct PostgresDriver {
    pub(crate) pool: Pool<Postgres>,
    /// Database name we connected to. Surfaced as the `default_schema`
    /// hint in `ping()` so the UI can pre-select a rail tile, even though
    /// PG databases aren't schemas in the SQL sense.
    pub(crate) default_db: Option<String>,
    /// Retained connect params so we can open a *fresh* single connection
    /// for out-of-transaction DDL like `CREATE DATABASE`, which PG refuses
    /// to run inside the pooled transactional sessions.
    pub(crate) config: PostgresConfig,
}

#[derive(Clone)]
pub struct PostgresConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: Option<String>,
}

impl PostgresDriver {
    pub async fn connect(cfg: PostgresConfig) -> Result<Self, AdapterError> {
        log_line!(
            "pg_connect",
            "→ host={} port={} user={} default_db={:?} ssl_mode={:?}",
            cfg.host,
            cfg.port,
            cfg.user,
            cfg.database,
            cfg.ssl_mode,
        );
        let opts = build_connect_options(&cfg);

        // Same budget as MySQL — 16 max to let parallel describe fan out.
        // No eager warmup: `min_connections(N)` with `connect_with` blocks the
        // connect call until N handshakes finish, which stalls the first
        // `list_schemas` behind the pool filling on a remote/slow host.
        // `connect_lazy_with` returns instantly; `ping()` (called right after
        // connect) opens the first real connection, so genuine auth/network
        // failures still surface immediately. See the reconnect-latency audit.
        // Proactive connection health (see mysql.rs for the full rationale):
        // test_before_acquire discards a dead idle socket before lending it,
        // so a burst of parallel queries can't have one unlucky member block
        // ~19s on a connection the server killed via idle timeout while its
        // siblings finish in ms. idle_timeout/max_lifetime retire connections
        // before the server does.
        let pool = PgPoolOptions::new()
            .max_connections(16)
            .min_connections(0)
            .acquire_timeout(std::time::Duration::from_secs(30))
            .test_before_acquire(true)
            .idle_timeout(std::time::Duration::from_secs(240))
            .max_lifetime(std::time::Duration::from_secs(1800))
            .connect_lazy_with(opts);
        log_line!("pg_connect", "  pool ready (lazy)");
        Ok(Self {
            pool,
            default_db: cfg.database.clone(),
            config: cfg,
        })
    }

    pub async fn ping(&self) -> Result<ServerInfo, AdapterError> {
        // `version()` returns the full banner ("PostgreSQL 16.2 on x86_64
        // …") — `SHOW server_version` is shorter and parses cleanly into
        // major.minor. We use both so users see a familiar string *and*
        // the UI gets structured numbers for the version badge.
        let banner: String = sqlx::query_scalar("SELECT version()")
            .fetch_one(&self.pool)
            .await?;
        let short: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&self.pool)
            .await
            .unwrap_or_else(|_| banner.clone());

        let (version_major, version_minor, flavor) = parse_pg_version(&banner, &short);
        log_line!(
            "pg_ping",
            "banner={} short={} parsed=({:?}.{:?}) flavor={:?}",
            banner,
            short,
            version_major,
            version_minor,
            flavor,
        );
        Ok(ServerInfo {
            adapter_id: "postgres".into(),
            version: short,
            version_major,
            version_minor,
            flavor,
            default_schema: self.default_db.clone(),
        })
    }

    pub async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError> {
        let t_total = std::time::Instant::now();

        // User-visible schemas: exclude pg_catalog/information_schema/pg_toast
        // and anything starting with pg_ (temp, internal). `public` stays.
        let schemata_fut = sqlx::query_as::<_, (String,)>(
            r#"SELECT schema_name
               FROM information_schema.schemata
               WHERE schema_name NOT IN ('information_schema','pg_catalog','pg_toast')
                 AND schema_name NOT LIKE 'pg\_%' ESCAPE '\'
               ORDER BY schema_name"#,
        )
        .fetch_all(&self.pool);

        // Tables + views across every user schema. We include partitioned
        // tables (`p`) so they appear next to their partitions; foreign
        // tables (`f`) are included too since users can query them as if
        // they were regular tables.
        let tables_fut = sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT n.nspname AS schema_name,
                      c.relname AS table_name,
                      CASE c.relkind
                          WHEN 'r' THEN 'BASE TABLE'
                          WHEN 'p' THEN 'BASE TABLE'
                          WHEN 'f' THEN 'FOREIGN TABLE'
                          WHEN 'v' THEN 'VIEW'
                          WHEN 'm' THEN 'MATERIALIZED VIEW'
                          ELSE c.relkind::text
                      END AS table_type
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('r','p','f','v','m')
                 AND n.nspname NOT IN ('information_schema','pg_catalog','pg_toast')
                 AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
               ORDER BY n.nspname, c.relname"#,
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
                kind: if kind == "VIEW" || kind == "MATERIALIZED VIEW" {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                row_count: None,
            });
        }
        let result: Vec<SchemaInfo> = acc
            .into_iter()
            .map(|(name, tables)| SchemaInfo { name, tables })
            .collect();
        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        let table_total: usize = result.iter().map(|s| s.tables.len()).sum();
        let names: Vec<&str> = result.iter().map(|s| s.name.as_str()).collect();
        log_line!(
            "pg_list_schemas",
            "← {} schemas ({:?}), {} tables total ({:.1}ms)",
            result.len(),
            names,
            table_total,
            total_ms,
        );
        Ok(result)
    }

    /// Real PG databases from `pg_database`. Used by the "Open database"
    /// picker on Postgres; `list_schemas` continues to return SQL
    /// schemas (namespaces inside the current database) because that's
    /// what browse / describe / sidebar traversal operate on.
    pub async fn list_databases(&self) -> Result<Vec<String>, AdapterError> {
        let rows = sqlx::query_as::<_, (String,)>(
            r#"SELECT datname
               FROM pg_catalog.pg_database
               WHERE datallowconn
                 AND datname <> 'template0'
               ORDER BY datname"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    pub async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, AdapterError> {
        let t_total = Instant::now();

        // Columns from information_schema — portable and already typed
        // the way we want. `character_maximum_length` is NULL for
        // non-length types (int, date, …); we pass it through as-is.
        //
        // `is_identity` / `identity_generation` mark IDENTITY columns
        // (PG10+ standard-SQL form) — we render them as "IDENTITY
        // ALWAYS" / "IDENTITY BY DEFAULT" in the MySQL-style `extra`
        // slot so the structure editor shows the right badge. Legacy
        // `serial` / `bigserial` columns look like plain ints with a
        // `nextval(…)` default, which is already correctly surfaced.
        //
        // `is_generated` flags generated-always columns; when true we
        // fetch the expression from `generation_expression` to include
        // in `extra`.
        let cols_fut = sqlx::query_as::<_, (
            String,
            String,
            String,
            Option<String>,
            Option<i32>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )>(
            r#"SELECT column_name,
                      COALESCE(udt_name, data_type) AS data_type,
                      is_nullable,
                      column_default,
                      character_maximum_length,
                      is_identity,
                      identity_generation,
                      is_generated,
                      generation_expression
               FROM information_schema.columns
               WHERE table_schema = $1 AND table_name = $2
               ORDER BY ordinal_position"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool);

        // Table kind + approximate row count via pg_class.reltuples. Not
        // exact, but matches the sidebar badge's expectations (MySQL's
        // TABLE_ROWS is also an estimate for InnoDB).
        let kind_fut = sqlx::query_as::<_, (String, Option<f32>)>(
            r#"SELECT CASE c.relkind
                          WHEN 'r' THEN 'BASE TABLE'
                          WHEN 'p' THEN 'BASE TABLE'
                          WHEN 'f' THEN 'FOREIGN TABLE'
                          WHEN 'v' THEN 'VIEW'
                          WHEN 'm' THEN 'MATERIALIZED VIEW'
                          ELSE c.relkind::text
                      END AS kind,
                      c.reltuples
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relname = $2"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(&self.pool);

        // Indexes via pg_index + pg_class. indkey is an int2vector of
        // attribute numbers (1-based); we expand against pg_attribute to
        // get column names. `indisprimary` flags the PK index; `indisunique`
        // catches single-column uniques we surface as UK on the column.
        let idx_fut = sqlx::query_as::<_, (String, String, bool, bool)>(
            r#"SELECT ic.relname AS index_name,
                      a.attname  AS column_name,
                      ix.indisunique AS is_unique,
                      ix.indisprimary AS is_primary
               FROM pg_catalog.pg_index ix
               JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
               JOIN pg_catalog.pg_class tc ON tc.oid = ix.indrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
               JOIN pg_catalog.pg_attribute a
                    ON a.attrelid = tc.oid
                   AND a.attnum = ANY(ix.indkey)
               WHERE n.nspname = $1 AND tc.relname = $2
               ORDER BY ic.relname, array_position(ix.indkey, a.attnum)"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool);

        // Foreign keys via pg_constraint. `conkey` / `confkey` are int2[]
        // of the local / referenced column positions; we unnest both in
        // lockstep to get aligned (from_col, to_col) pairs.
        let fk_fut = sqlx::query_as::<_, (String, String, String, String, String)>(
            r#"WITH fk AS (
                   SELECT con.conname,
                          con.conrelid,
                          con.confrelid,
                          unnest(con.conkey)  AS local_attnum,
                          unnest(con.confkey) AS foreign_attnum
                   FROM pg_catalog.pg_constraint con
                   JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE con.contype = 'f'
                     AND n.nspname = $1
                     AND c.relname = $2
               )
               SELECT fk.conname                   AS name,
                      la.attname                   AS from_col,
                      fn.nspname                   AS ref_schema,
                      fc.relname                   AS ref_table,
                      fa.attname                   AS ref_col
               FROM fk
               JOIN pg_catalog.pg_attribute la
                    ON la.attrelid = fk.conrelid AND la.attnum = fk.local_attnum
               JOIN pg_catalog.pg_class fc ON fc.oid = fk.confrelid
               JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
               JOIN pg_catalog.pg_attribute fa
                    ON fa.attrelid = fk.confrelid AND fa.attnum = fk.foreign_attnum
               ORDER BY fk.conname"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool);

        let (col_rows, kind_row, idx_rows, fk_rows) =
            tokio::try_join!(cols_fut, kind_fut, idx_fut, fk_fut)?;

        if col_rows.is_empty() {
            return Err(AdapterError::NotFound(format!(
                "{schema}.{table} not found"
            )));
        }

        // Group index rows by index name so we can distinguish multi-
        // column indexes and the PK.
        let mut indexes_map: std::collections::BTreeMap<
            String,
            (Vec<String>, bool, bool),
        > = Default::default();
        for (idx_name, col, is_unique, is_primary) in idx_rows {
            let entry = indexes_map
                .entry(idx_name)
                .or_insert_with(|| (Vec::new(), is_unique, is_primary));
            entry.0.push(col);
            entry.1 = entry.1 && is_unique;
            entry.2 = entry.2 || is_primary;
        }

        let mut primary_key: Vec<String> = Vec::new();
        let mut indexed_cols: std::collections::BTreeSet<String> = Default::default();
        let mut unique_single: std::collections::BTreeSet<String> = Default::default();
        for (_, (cols, unique, is_primary)) in &indexes_map {
            for c in cols {
                indexed_cols.insert(c.clone());
            }
            if *is_primary {
                primary_key = cols.clone();
            } else if *unique && cols.len() == 1 {
                unique_single.insert(cols[0].clone());
            }
        }

        #[derive(Default)]
        struct FkAcc {
            from_cols: Vec<String>,
            to_schema: String,
            to_table: String,
            to_cols: Vec<String>,
        }
        let mut fk_map: std::collections::BTreeMap<String, FkAcc> = Default::default();
        let mut fk_cols_set: std::collections::BTreeSet<String> = Default::default();
        for (name, col, ref_schema, ref_table, ref_col) in fk_rows {
            fk_cols_set.insert(col.clone());
            let entry = fk_map.entry(name).or_default();
            entry.from_cols.push(col);
            entry.to_schema = ref_schema;
            entry.to_table = ref_table;
            entry.to_cols.push(ref_col);
        }

        let columns: Vec<ColumnInfo> = col_rows
            .into_iter()
            .map(
                |(
                    name,
                    data_type,
                    is_nullable,
                    default,
                    length,
                    is_identity,
                    identity_generation,
                    is_generated,
                    generation_expression,
                )| {
                    let mut extra_tags: Vec<String> = Vec::new();
                    if is_identity.as_deref().map(|s| s.eq_ignore_ascii_case("YES")).unwrap_or(false) {
                        // `identity_generation` is `"ALWAYS"` or `"BY DEFAULT"`.
                        // Render as `IDENTITY ALWAYS` / `IDENTITY BY DEFAULT`
                        // so the structure editor lights it up the same
                        // way as MySQL's `auto_increment` badge.
                        let kind = identity_generation
                            .as_deref()
                            .unwrap_or("BY DEFAULT")
                            .to_uppercase();
                        extra_tags.push(format!("IDENTITY {kind}"));
                    }
                    // `is_generated` is `"ALWAYS"` for generated columns,
                    // `"NEVER"` for plain ones. Treat anything non-NEVER
                    // as generated.
                    let generated_flag = is_generated
                        .as_deref()
                        .map(|s| !s.eq_ignore_ascii_case("NEVER"))
                        .unwrap_or(false);
                    if generated_flag {
                        let expr = generation_expression.as_deref().unwrap_or("");
                        if expr.is_empty() {
                            extra_tags.push("GENERATED ALWAYS".to_string());
                        } else {
                            extra_tags.push(format!("GENERATED ALWAYS AS ({expr})"));
                        }
                    }
                    ColumnInfo {
                        is_primary: primary_key.contains(&name),
                        is_unique: unique_single.contains(&name),
                        is_foreign: fk_cols_set.contains(&name),
                        is_indexed: indexed_cols.contains(&name),
                        nullable: is_nullable.eq_ignore_ascii_case("YES"),
                        default,
                        length: length.map(|n| n as i64),
                        data_type,
                        extra: extra_tags.join(", "),
                        character_set: None,
                        collation: None,
                        name,
                    }
                },
            )
            .collect();

        let indexes: Vec<IndexInfo> = indexes_map
            .into_iter()
            .map(|(name, (columns, unique, _is_primary))| IndexInfo {
                name,
                columns,
                unique,
            })
            .collect();

        let foreign_keys: Vec<ForeignKey> = fk_map
            .into_iter()
            .map(|(name, acc)| ForeignKey {
                name,
                from_schema: schema.to_string(),
                from_table: table.to_string(),
                from_columns: acc.from_cols,
                to_schema: acc.to_schema,
                to_table: acc.to_table,
                to_columns: acc.to_cols,
            })
            .collect();

        let (kind_str, row_count) = kind_row
            .map(|(k, r)| (k, r.map(|n| n.max(0.0) as u64)))
            .unwrap_or(("BASE TABLE".into(), None));

        let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
        log_line!(
            "pg_describe_table",
            "{}.{}: {:.1}ms (cols={}, idx={}, fk={})",
            schema,
            table,
            total_ms,
            columns.len(),
            indexes.len(),
            foreign_keys.len(),
        );

        Ok(TableStructure {
            schema: schema.to_string(),
            name: table.to_string(),
            kind: if kind_str == "VIEW" || kind_str == "MATERIALIZED VIEW" {
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

    pub async fn list_relations(
        &self,
        schema: &str,
    ) -> Result<Vec<ForeignKey>, AdapterError> {
        let rows = sqlx::query_as::<_, (String, String, String, String, String, String)>(
            r#"WITH fk AS (
                   SELECT con.conname,
                          n.nspname AS from_schema,
                          c.relname AS from_table,
                          con.conrelid,
                          con.confrelid,
                          unnest(con.conkey)  AS local_attnum,
                          unnest(con.confkey) AS foreign_attnum
                   FROM pg_catalog.pg_constraint con
                   JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE con.contype = 'f'
                     AND n.nspname = $1
               )
               SELECT fk.conname, fk.from_schema, fk.from_table,
                      la.attname  AS from_col,
                      fc.relname  AS to_table,
                      fa.attname  AS to_col
               FROM fk
               JOIN pg_catalog.pg_attribute la
                    ON la.attrelid = fk.conrelid AND la.attnum = fk.local_attnum
               JOIN pg_catalog.pg_class fc ON fc.oid = fk.confrelid
               JOIN pg_catalog.pg_attribute fa
                    ON fa.attrelid = fk.confrelid AND fa.attnum = fk.foreign_attnum
               ORDER BY fk.conname"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;

        #[derive(Default)]
        struct Acc {
            from_schema: String,
            from_table: String,
            from_cols: Vec<String>,
            to_table: String,
            to_cols: Vec<String>,
        }
        let mut map: std::collections::BTreeMap<String, Acc> = Default::default();
        for (name, from_schema, from_table, from_col, to_table, to_col) in rows {
            let e = map.entry(name).or_default();
            e.from_schema = from_schema;
            e.from_table = from_table;
            e.from_cols.push(from_col);
            e.to_table = to_table;
            e.to_cols.push(to_col);
        }
        Ok(map
            .into_iter()
            .map(|(name, a)| ForeignKey {
                name,
                from_schema: a.from_schema,
                from_table: a.from_table,
                from_columns: a.from_cols,
                to_schema: schema.to_string(),
                to_table: a.to_table,
                to_columns: a.to_cols,
            })
            .collect())
    }

    pub async fn describe_schema(
        &self,
        schema: &str,
    ) -> Result<Vec<TableStructure>, AdapterError> {
        // Simple loop over list_tables → describe_table. Matches the
        // trait's default, but we provide it explicitly so the adapter
        // forwarding in adapter.rs can stay uniform with MySQL's.
        let schemas = self.list_schemas().await?;
        let Some(info) = schemas.iter().find(|s| s.name == schema) else {
            return Err(AdapterError::NotFound(format!(
                "schema `{schema}` not found"
            )));
        };
        let mut out = Vec::with_capacity(info.tables.len());
        for t in &info.tables {
            if let Ok(structure) = self.describe_table(schema, &t.name).await {
                out.push(structure);
            }
        }
        Ok(out)
    }

    pub async fn list_views(
        &self,
        schema: &str,
    ) -> Result<Vec<ViewInfo>, AdapterError> {
        let rows = sqlx::query_as::<_, (String, String)>(
            r#"SELECT table_name, is_updatable
               FROM information_schema.views
               WHERE table_schema = $1
               ORDER BY table_name"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, is_updatable)| ViewInfo {
                name,
                is_updatable: is_updatable.eq_ignore_ascii_case("YES"),
            })
            .collect())
    }

    pub async fn list_routines(
        &self,
        schema: &str,
    ) -> Result<Vec<RoutineInfo>, AdapterError> {
        // Postgres distinguishes functions from procedures from PG11+;
        // `prokind` is 'f' for plain functions, 'p' for procedures, 'a'
        // for aggregates, 'w' for window. We surface f + p.
        let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
            r#"SELECT p.proname AS name,
                      CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                      pg_catalog.pg_get_function_result(p.oid) AS returns,
                      pg_catalog.pg_get_function_arguments(p.oid) AS arguments
               FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = $1
                 AND p.prokind IN ('f','p')
               ORDER BY p.proname"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(name, kind, returns, arguments)| RoutineInfo {
                name,
                kind,
                returns,
                parameters: parse_pg_arguments(arguments.as_deref().unwrap_or("")),
            })
            .collect())
    }

    pub async fn describe_routine(
        &self,
        schema: &str,
        name: &str,
        kind: &str,
    ) -> Result<RoutineDefinition, AdapterError> {
        // `pg_get_functiondef` returns a ready-to-run CREATE OR REPLACE
        // statement — ideal as the "body" the editor opens.
        let (returns, arguments, body): (
            Option<String>,
            Option<String>,
            String,
        ) = sqlx::query_as(
            r#"SELECT pg_catalog.pg_get_function_result(p.oid),
                      pg_catalog.pg_get_function_arguments(p.oid),
                      pg_catalog.pg_get_functiondef(p.oid)
               FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = $1 AND p.proname = $2
               LIMIT 1"#,
        )
        .bind(schema)
        .bind(name)
        .fetch_one(&self.pool)
        .await
        .map_err(|_| AdapterError::NotFound(format!("{schema}.{name} not found")))?;

        Ok(RoutineDefinition {
            schema: schema.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
            returns,
            parameters: parse_pg_arguments(arguments.as_deref().unwrap_or("")),
            body: body.clone(),
            // Postgres-specific metadata doesn't map 1:1 to MySQL's
            // (IS_DETERMINISTIC, DATA_ACCESS, SECURITY_TYPE, DEFINER).
            // Leave these as best-effort defaults — the full CREATE
            // statement is already in `body`, which is what the routine
            // editor displays.
            is_deterministic: false,
            data_access: String::new(),
            security_type: String::new(),
            definer: String::new(),
            create_sql: body,
        })
    }

    pub async fn list_triggers(
        &self,
        schema: &str,
    ) -> Result<Vec<TriggerInfo>, AdapterError> {
        // pg_trigger.tgtype is a bitmask: bit 1 = ROW, bit 2 = BEFORE,
        // bit 3 = INSERT, bit 4 = DELETE, bit 5 = UPDATE, bit 6 = INSTEAD.
        // Skip internal/constraint triggers (tgisinternal).
        let rows = sqlx::query_as::<_, (String, String, i16)>(
            r#"SELECT t.tgname AS name,
                      c.relname AS table_name,
                      t.tgtype AS tgtype
               FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1
                 AND NOT t.tgisinternal
               ORDER BY t.tgname"#,
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(name, table, tgtype)| {
                let (timing, event) = decode_pg_tgtype(tgtype);
                TriggerInfo {
                    name,
                    table,
                    timing,
                    event,
                }
            })
            .collect())
    }

    pub async fn describe_trigger(
        &self,
        schema: &str,
        name: &str,
    ) -> Result<TriggerDefinition, AdapterError> {
        // pg_get_triggerdef gives the full, runnable CREATE TRIGGER statement —
        // the canonical surface for the editor. We still return timing/event for
        // the structured header.
        let (table, tgtype, create_sql): (String, i16, String) = sqlx::query_as(
            r#"SELECT c.relname AS table_name,
                      t.tgtype AS tgtype,
                      pg_catalog.pg_get_triggerdef(t.oid, true) AS create_sql
               FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
               LIMIT 1"#,
        )
        .bind(schema)
        .bind(name)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => AdapterError::NotFound(format!("{schema}.{name} (trigger)")),
            other => other.into(),
        })?;
        let (timing, event) = decode_pg_tgtype(tgtype);

        Ok(TriggerDefinition {
            schema: schema.to_string(),
            name: name.to_string(),
            table,
            timing,
            event,
            // Postgres triggers call a separate function; the full CREATE
            // statement is the editable surface, so `body` mirrors it.
            body: create_sql.clone(),
            create_sql,
        })
    }

    pub async fn save_trigger(&self, req: SaveTriggerRequest) -> Result<(), AdapterError> {
        // Postgres triggers reference a function via EXECUTE FUNCTION, so the
        // editor edits the full CREATE TRIGGER text. Require `create_sql`.
        let create_sql = req
            .create_sql
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AdapterError::Unsupported(
                    "Postgres triggers require the full CREATE TRIGGER statement".into(),
                )
            })?;

        let mut conn = self.pool.acquire().await?;

        // Drop the previous definition when editing. PG's DROP TRIGGER needs the
        // table name, so use original (when set) or current name on the request's
        // table. PG14+ supports CREATE OR REPLACE TRIGGER, but drop-then-create
        // works on all supported versions.
        let drop_name = req.original_name.as_deref().filter(|s| !s.is_empty());
        if let Some(orig) = drop_name {
            if !req.table.trim().is_empty() {
                let drop_sql = format!(
                    "DROP TRIGGER IF EXISTS {} ON {}.{}",
                    quote_ident(orig),
                    quote_ident(req.schema.trim()),
                    quote_ident(req.table.trim()),
                );
                conn.execute(drop_sql.as_str()).await?;
            }
        }

        conn.execute(create_sql).await?;
        Ok(())
    }

    pub async fn drop_trigger(
        &self,
        schema: &str,
        name: &str,
        table: &str,
    ) -> Result<(), AdapterError> {
        if table.trim().is_empty() {
            return Err(AdapterError::Unsupported(
                "dropping a Postgres trigger requires its table".into(),
            ));
        }
        let sql = format!(
            "DROP TRIGGER IF EXISTS {} ON {}.{}",
            quote_ident(name),
            quote_ident(schema),
            quote_ident(table),
        );
        sqlx::query(&sql).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn create_schema(
        &self,
        name: &str,
        _charset: Option<&str>,
        _collation: Option<&str>,
    ) -> Result<(), AdapterError> {
        // The UI's "New database" flow lands here. In Postgres, a
        // database is a top-level object (like a MySQL schema), not a
        // namespace inside one. `CREATE DATABASE` also cannot run inside
        // a transaction, so we open a *fresh single connection* (bypassing
        // the pool's implicit-transaction behaviour) against the maintenance
        // database and execute it there.
        use sqlx::ConnectOptions;

        // Maintenance db: use "postgres" (always present). Falls back to
        // "template1" if that for some reason isn't accessible.
        let mut maint_cfg = self.config.clone();
        maint_cfg.database = Some("postgres".to_string());
        let opts = build_connect_options(&maint_cfg);

        let mut conn = opts.connect().await.map_err(|e| {
            log_line!("pg_create_db", "  connect to maintenance db failed: {}", e);
            AdapterError::from(e)
        })?;

        let sql = format!("CREATE DATABASE {}", quote_ident(name));
        log_line!("pg_create_db", "→ {}", sql);
        sqlx::query(&sql)
            .execute(&mut conn)
            .await
            .map(|_| ())
            .map_err(|e| {
                log_line!("pg_create_db", "  CREATE DATABASE failed: {}", e);
                AdapterError::from(e)
            })?;
        log_line!("pg_create_db", "  created database {}", name);
        Ok(())
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
            "pg_run_query",
            "batch of {} statements (pool.acquire={:.1}ms)",
            statements.len(),
            acquire_ms,
        );

        for sql in statements {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                continue;
            }
            log_line!("pg_run_query", "→ {}", trimmed);
            let started = Instant::now();
            let stmt_result = if is_query(trimmed) {
                execute_query(&mut conn, trimmed, row_limit).await
            } else {
                execute_statement(&mut conn, trimmed).await
            };
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

            match &stmt_result {
                Ok(_) => log_line!("pg_run_query", "  ok ({:.1}ms)", duration_ms),
                Err(e) => log_line!("pg_run_query", "  ERR ({:.1}ms): {}", duration_ms, e),
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
                    // Postgres aborts the current (implicit) transaction
                    // on any error and rejects every subsequent statement
                    // with "current transaction is aborted, commands
                    // ignored until end of transaction block". Issue an
                    // explicit ROLLBACK so the rest of the batch can run.
                    // If the user wrapped the script in their own BEGIN
                    // block this rolls that back too, which is the
                    // correct behaviour — their intent was atomicity.
                    use sqlx::Executor;
                    if let Err(rb_err) = conn.execute("ROLLBACK").await {
                        log_line!(
                            "pg_run_query",
                            "  rollback after error failed: {}",
                            rb_err
                        );
                    }
                }
            }
        }

        Ok(QueryResult { statements: results })
    }

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

        let set_cols: Vec<&str> = changes.keys().map(String::as_str).collect();
        let pk_cols: Vec<&str> = primary_key.iter().map(|pk| pk.column.as_str()).collect();
        let sql = crate::mutate::build_update_sql(schema, table, &set_cols, &pk_cols);

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

    pub async fn process_list(&self) -> Result<Vec<ProcessInfo>, AdapterError> {
        let mut conn = self.pool.acquire().await?;
        let rows = sqlx::query(
            "SELECT pid, usename, datname, client_addr::text, state, query,
                    EXTRACT(EPOCH FROM (now() - query_start))::bigint AS time,
                    wait_event_type, wait_event
             FROM pg_stat_activity
             WHERE state IS NOT NULL
             ORDER BY query_start DESC",
        )
        .fetch_all(&mut *conn)
        .await?;

        let mut processes = Vec::with_capacity(rows.len());
        for row in rows {
            let pid: i32 = row.try_get::<i32, _>(0).unwrap_or(0);
            let usename: Option<String> = row.try_get::<Option<String>, _>(1).unwrap_or(None);
            let datname: Option<String> = row.try_get::<Option<String>, _>(2).unwrap_or(None);
            let client_addr: Option<String> = row.try_get::<Option<String>, _>(3).unwrap_or(None);
            let state: Option<String> = row.try_get::<Option<String>, _>(4).unwrap_or(None);
            let query: Option<String> = row.try_get::<Option<String>, _>(5).unwrap_or(None);
            let time: Option<i64> = row.try_get::<Option<i64>, _>(6).unwrap_or(None);

            let kind = match state.as_deref() {
                Some("active") => ProcessKind::Query,
                Some("idle") => ProcessKind::Sleep,
                _ => ProcessKind::Other(state.clone().unwrap_or_default()),
            };

            processes.push(ProcessInfo {
                id: pid.to_string(),
                user: usename,
                host: client_addr,
                database: datname,
                command: state.clone(),
                time: time.map(|t| t.max(0) as u64),
                state,
                info: query,
                kind,
            });
        }

        Ok(processes)
    }

    pub async fn kill_process(&self, id: &str) -> Result<(), AdapterError> {
        let pid: i32 = id.parse().map_err(|_| {
            AdapterError::Other(format!("invalid process id: {id}"))
        })?;
        let mut conn = self.pool.acquire().await?;
        let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .fetch_one(&mut *conn)
            .await?;
        if !terminated {
            return Err(AdapterError::Other(format!(
                "could not terminate process {pid}"
            )));
        }
        Ok(())
    }

    pub async fn kill_processes(&self, ids: &[String]) -> Result<Vec<KillResult>, AdapterError> {
        let mut conn = self.pool.acquire().await?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let pid: i32 = match id.parse() {
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
            match sqlx::query_scalar::<_, bool>("SELECT pg_terminate_backend($1)")
                .bind(pid)
                .fetch_one(&mut *conn)
                .await
            {
                Ok(true) => results.push(KillResult {
                    id: id.clone(),
                    success: true,
                    error: None,
                }),
                Ok(false) => results.push(KillResult {
                    id: id.clone(),
                    success: false,
                    error: Some(format!("could not terminate process {pid}")),
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

/// Parse `SHOW server_version` (e.g. `"16.2"`) into (major, minor) +
/// detect the flavor from the banner. EDB/Greenplum/Timescale all ship
/// identifiable strings in `version()`.
fn parse_pg_version(
    banner: &str,
    short: &str,
) -> (Option<u32>, Option<u32>, Option<String>) {
    let prefix: String = short
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = prefix.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok());

    let lower = banner.to_ascii_lowercase();
    let flavor = if lower.contains("timescale") {
        Some("TimescaleDB".into())
    } else if lower.contains("cockroach") {
        Some("CockroachDB".into())
    } else if lower.contains("edb") || lower.contains("enterprisedb") {
        Some("EnterpriseDB".into())
    } else if lower.contains("greenplum") {
        Some("Greenplum".into())
    } else {
        Some("PostgreSQL".into())
    };
    (major, minor, flavor)
}

fn build_connect_options(cfg: &PostgresConfig) -> PgConnectOptions {
    let mut opts = PgConnectOptions::new()
        .host(&cfg.host)
        .port(cfg.port)
        .username(&cfg.user);
    if let Some(p) = cfg.password.as_deref() {
        opts = opts.password(p);
    }
    if let Some(db) = cfg.database.as_deref() {
        opts = opts.database(db);
    }
    opts.ssl_mode(map_ssl_mode(cfg.ssl_mode.as_deref()))
}

fn map_ssl_mode(s: Option<&str>) -> PgSslMode {
    match s.unwrap_or("Preferred") {
        "Disable" | "DISABLED" => PgSslMode::Disable,
        "Required" | "REQUIRED" | "Require" => PgSslMode::Require,
        "Verify-CA" | "VERIFY_CA" => PgSslMode::VerifyCa,
        "Verify-Full" | "VERIFY_FULL" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

/// `pg_get_function_arguments` returns a comma-separated string like
/// `"a integer, b text DEFAULT ''::text"` or `"OUT id int, IN name text"`.
/// Split into typed params — we ignore defaults and OUT directionality
/// because the caller only cares about the shape of the in-parameters.
fn parse_pg_arguments(raw: &str) -> Vec<RoutineParam> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|arg| {
            // `[IN | OUT | INOUT | VARIADIC] <name> <type> [DEFAULT …]`
            let mut rest = arg;
            let mut mode: Option<String> = None;
            for kw in ["IN ", "OUT ", "INOUT ", "VARIADIC "] {
                if let Some(r) = strip_case_prefix(rest, kw) {
                    mode = Some(kw.trim().to_ascii_lowercase());
                    rest = r.trim_start();
                    break;
                }
            }
            // Strip DEFAULT … trailing clause.
            let without_default = rest.split_once(" DEFAULT ").map(|(a, _)| a).unwrap_or(rest).trim();

            // Split name + type on first whitespace. Anonymous args
            // (no name) still yield a param with empty `name`.
            let (name, data_type) = match without_default.split_once(char::is_whitespace) {
                Some((n, t)) => (n.trim().to_string(), t.trim().to_string()),
                None => (String::new(), without_default.trim().to_string()),
            };
            RoutineParam {
                name,
                data_type,
                mode,
            }
        })
        .collect()
}

fn strip_case_prefix<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn is_query(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_uppercase();
    head.starts_with("SELECT")
        || head.starts_with("SHOW")
        || head.starts_with("EXPLAIN")
        || head.starts_with("WITH")
        || head.starts_with("VALUES")
        || head.starts_with("TABLE ")
}

fn has_limit_clause(sql: &str) -> bool {
    // Same parsing rules as MySQL's helper but without backtick tracking
    // — Postgres doesn't use backticks. Detects top-level LIMIT ignoring
    // quoted literals + identifiers.
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
                    if chunk.eq_ignore_ascii_case(b"IMIT ")
                        || chunk.eq_ignore_ascii_case(b"IMIT\t")
                        || chunk.eq_ignore_ascii_case(b"IMIT\n")
                    {
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

/// Split a multi-statement script on `;` while respecting quoted
/// literals, `"double"` identifiers, `$$dollar quoting$$`, and `--` /
/// `/* */` comments. Postgres dollar-quoted strings make this more
/// involved than MySQL's version because the delimiter is arbitrary
/// (`$$`, `$tag$`, `$function$` …).
pub(crate) fn split_statements(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    // When `dollar_tag` is Some, we're inside a dollar-quoted string and
    // break out only when we see the same tag again.
    let mut dollar_tag: Option<String> = None;

    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];

        if in_line_comment {
            buf.push(ch);
            if ch == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            buf.push(ch);
            if ch == '*' && chars.get(i + 1) == Some(&'/') {
                buf.push('/');
                i += 2;
                in_block_comment = false;
                continue;
            }
            i += 1;
            continue;
        }
        if let Some(tag) = &dollar_tag {
            buf.push(ch);
            if ch == '$' {
                // Try to match `$tag$` starting here.
                let closing: String = format!("${}$", tag);
                let remaining: String = chars[i..].iter().collect();
                if remaining.starts_with(&closing) {
                    for c in closing.chars().skip(1) {
                        buf.push(c);
                    }
                    i += closing.chars().count();
                    dollar_tag = None;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if in_single {
            buf.push(ch);
            if ch == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            buf.push(ch);
            if ch == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }

        // Not in any quoting / commenting state.
        match ch {
            '\'' => {
                in_single = true;
                buf.push(ch);
                i += 1;
            }
            '"' => {
                in_double = true;
                buf.push(ch);
                i += 1;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                in_line_comment = true;
                buf.push(ch);
                i += 1;
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                in_block_comment = true;
                buf.push(ch);
                buf.push('*');
                i += 2;
            }
            '$' => {
                // Try to read a dollar tag: `$<word>$` or `$$`.
                let rest: String = chars[i + 1..].iter().collect();
                if let Some(end) = rest.find('$') {
                    let tag_content = &rest[..end];
                    if tag_content.is_empty()
                        || tag_content
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_')
                    {
                        dollar_tag = Some(tag_content.to_string());
                        buf.push('$');
                        for c in tag_content.chars() {
                            buf.push(c);
                        }
                        buf.push('$');
                        i += tag_content.chars().count() + 2;
                        continue;
                    }
                }
                buf.push(ch);
                i += 1;
            }
            ';' => {
                if !buf.trim().is_empty() {
                    out.push(std::mem::take(&mut buf));
                }
                i += 1;
            }
            _ => {
                buf.push(ch);
                i += 1;
            }
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

async fn execute_query(
    conn: &mut sqlx::PgConnection,
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

    let rows: Vec<PgRow> = sqlx::query(&effective).fetch_all(&mut *conn).await?;

    let columns: Vec<ColumnMeta> = if let Some(first) = rows.first() {
        first
            .columns()
            .iter()
            .map(|c: &PgColumn| ColumnMeta {
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
    conn: &mut sqlx::PgConnection,
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

/// Convert a single Postgres column to a JSON value.
///
/// Postgres's type names come back in lowercase (`int4`, `int8`, `bool`,
/// `timestamptz`, …). We dispatch on them before falling back to string.
pub(crate) fn column_to_json(row: &PgRow, idx: usize, type_name: &str) -> JsonValue {
    let t = type_name.to_ascii_uppercase();

    if t == "BOOL" {
        if let Ok(v) = row.try_get::<Option<bool>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t == "INT2" || t == "SMALLINT" {
        if let Ok(v) = row.try_get::<Option<i16>, _>(idx) {
            return v.map(|n| JsonValue::from(n as i64)).unwrap_or(JsonValue::Null);
        }
    }
    if t == "INT4" || t == "INTEGER" {
        if let Ok(v) = row.try_get::<Option<i32>, _>(idx) {
            return v.map(|n| JsonValue::from(n as i64)).unwrap_or(JsonValue::Null);
        }
    }
    if t == "INT8" || t == "BIGINT" {
        if let Ok(v) = row.try_get::<Option<i64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t == "FLOAT4" || t == "REAL" {
        if let Ok(v) = row.try_get::<Option<f32>, _>(idx) {
            return v.map(|n| JsonValue::from(n as f64)).unwrap_or(JsonValue::Null);
        }
    }
    if t == "FLOAT8" || t == "DOUBLE PRECISION" {
        if let Ok(v) = row.try_get::<Option<f64>, _>(idx) {
            return v.map(JsonValue::from).unwrap_or(JsonValue::Null);
        }
    }
    if t == "NUMERIC" {
        if let Ok(v) = row.try_get::<Option<BigDecimal>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "TIMESTAMPTZ" {
        if let Ok(v) = row.try_get::<Option<DateTime<Utc>>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_rfc3339()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "TIMESTAMP" {
        if let Ok(v) = row.try_get::<Option<NaiveDateTime>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "DATE" {
        if let Ok(v) = row.try_get::<Option<NaiveDate>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "TIME" {
        if let Ok(v) = row.try_get::<Option<NaiveTime>, _>(idx) {
            return v
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "UUID" {
        if let Ok(v) = row.try_get::<Option<uuid::Uuid>, _>(idx) {
            return v
                .map(|u| JsonValue::String(u.to_string()))
                .unwrap_or(JsonValue::Null);
        }
    }
    if t == "JSON" || t == "JSONB" {
        if let Ok(v) = row.try_get::<Option<JsonValue>, _>(idx) {
            return v.unwrap_or(JsonValue::Null);
        }
    }

    // Arrays. Postgres types come back either `_int4` / `_text` (internal
    // catalog form) or `INT4[]` / `TEXT[]` (display form) depending on
    // the code path. Handle both for the scalar element types we support
    // natively; unknown element types fall through to the string path,
    // which yields the raw `{a,b,c}` literal — still better than nothing.
    if is_array_type(&t) {
        let elem = array_element(&t);
        if let Some(v) = decode_array(row, idx, elem) {
            return v;
        }
    }

    // Ranges. Wire format is the canonical text one (`"[1,5)"`, `"empty"`,
    // unbounded sides as empty). We parse into a structured JSON shape so
    // the grid can render bounds without the user eyeballing punctuation.
    if is_range_type(&t) {
        if let Ok(v) = row.try_get::<Option<String>, _>(idx) {
            return v
                .map(|s| parse_pg_range(&s))
                .unwrap_or(JsonValue::Null);
        }
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

fn is_array_type(upper: &str) -> bool {
    upper.ends_with("[]") || upper.starts_with('_')
}

/// Strip the array wrapper and return the canonical element type name
/// (uppercase). `"_INT4"` → `"INT4"`, `"TEXT[]"` → `"TEXT"`.
fn array_element(upper: &str) -> &str {
    if let Some(stripped) = upper.strip_prefix('_') {
        stripped
    } else if let Some(stripped) = upper.strip_suffix("[]") {
        stripped.trim_end()
    } else {
        upper
    }
}

/// Try to decode the column at `idx` as an array of a known scalar
/// element type. Returns `None` for unknown element types so the caller
/// can fall through to the string path.
fn decode_array(row: &PgRow, idx: usize, elem: &str) -> Option<JsonValue> {
    match elem {
        "BOOL" => row.try_get::<Option<Vec<bool>>, _>(idx).ok().map(array_to_json),
        "INT2" | "SMALLINT" => row
            .try_get::<Option<Vec<i16>>, _>(idx)
            .ok()
            .map(|o| o.map(|v| v.into_iter().map(|n| JsonValue::from(n as i64)).collect::<Vec<_>>())
                .map(JsonValue::Array)
                .unwrap_or(JsonValue::Null)),
        "INT4" | "INTEGER" => row
            .try_get::<Option<Vec<i32>>, _>(idx)
            .ok()
            .map(|o| o.map(|v| v.into_iter().map(|n| JsonValue::from(n as i64)).collect::<Vec<_>>())
                .map(JsonValue::Array)
                .unwrap_or(JsonValue::Null)),
        "INT8" | "BIGINT" => row
            .try_get::<Option<Vec<i64>>, _>(idx)
            .ok()
            .map(array_to_json),
        "FLOAT4" | "REAL" => row
            .try_get::<Option<Vec<f32>>, _>(idx)
            .ok()
            .map(|o| o.map(|v| v.into_iter().map(|n| JsonValue::from(n as f64)).collect::<Vec<_>>())
                .map(JsonValue::Array)
                .unwrap_or(JsonValue::Null)),
        "FLOAT8" | "DOUBLE PRECISION" => row
            .try_get::<Option<Vec<f64>>, _>(idx)
            .ok()
            .map(array_to_json),
        "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" => row
            .try_get::<Option<Vec<String>>, _>(idx)
            .ok()
            .map(array_to_json),
        "UUID" => row
            .try_get::<Option<Vec<uuid::Uuid>>, _>(idx)
            .ok()
            .map(|o| o
                .map(|v| v.into_iter().map(|u| JsonValue::String(u.to_string())).collect::<Vec<_>>())
                .map(JsonValue::Array)
                .unwrap_or(JsonValue::Null)),
        "JSON" | "JSONB" => row
            .try_get::<Option<Vec<JsonValue>>, _>(idx)
            .ok()
            .map(|o| o.map(JsonValue::Array).unwrap_or(JsonValue::Null)),
        _ => None,
    }
}

fn array_to_json<T: Into<JsonValue>>(opt: Option<Vec<T>>) -> JsonValue {
    opt.map(|v| JsonValue::Array(v.into_iter().map(Into::into).collect()))
        .unwrap_or(JsonValue::Null)
}

fn is_range_type(upper: &str) -> bool {
    matches!(
        upper,
        "INT4RANGE"
            | "INT8RANGE"
            | "NUMRANGE"
            | "TSRANGE"
            | "TSTZRANGE"
            | "DATERANGE"
            | "INT4MULTIRANGE"
            | "INT8MULTIRANGE"
            | "NUMMULTIRANGE"
            | "TSMULTIRANGE"
            | "TSTZMULTIRANGE"
            | "DATEMULTIRANGE"
    )
}

/// Parse Postgres's canonical range text form into a structured JSON
/// shape. Handles `empty`, `(a,b)`, `[a,b]`, `(a,b]`, `[a,b)`, and
/// open-ended sides (`(,5)` / `[5,)`). Multi-ranges arrive as
/// `{r1,r2,…}` — we recurse per sub-range.
fn parse_pg_range(raw: &str) -> JsonValue {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("empty") {
        return json!({ "empty": true });
    }
    // Multi-range: `{[a,b),[c,d]}` — split on top-level commas between
    // sub-ranges. Simple two-pass scan that tracks bracket depth.
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut parts = Vec::new();
        let mut buf = String::new();
        let mut depth = 0i32;
        for c in inner.chars() {
            match c {
                '[' | '(' => {
                    depth += 1;
                    buf.push(c);
                }
                ']' | ')' => {
                    depth -= 1;
                    buf.push(c);
                }
                ',' if depth == 0 => {
                    parts.push(std::mem::take(&mut buf));
                }
                _ => buf.push(c),
            }
        }
        if !buf.is_empty() {
            parts.push(buf);
        }
        return JsonValue::Array(parts.iter().map(|p| parse_pg_range(p.trim())).collect());
    }

    // Single range: `[a,b)` / `(a,b]` / `[a,b]` / `(a,b)`.
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return JsonValue::String(raw.to_string());
    }
    let lower_inc = bytes[0] == b'[';
    let upper_inc = bytes[bytes.len() - 1] == b']';
    let inner = &trimmed[1..trimmed.len() - 1];
    let (lower_raw, upper_raw) = match inner.split_once(',') {
        Some(x) => x,
        None => return JsonValue::String(raw.to_string()),
    };
    let parse_bound = |s: &str| -> JsonValue {
        let s = s.trim();
        if s.is_empty() {
            JsonValue::Null
        } else {
            // Strip the optional double quotes Postgres adds around
            // values that contain commas/brackets.
            let unquoted = s.trim_matches('"');
            JsonValue::String(unquoted.to_string())
        }
    };
    json!({
        "lower": parse_bound(lower_raw),
        "upper": parse_bound(upper_raw),
        "lowerInc": lower_inc,
        "upperInc": upper_inc,
    })
}

pub(crate) fn bind_json<'q>(
    q: sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>,
    v: &'q JsonValue,
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
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

/// Postgres identifier quoting — double quotes, double them to escape.
pub(crate) fn quote_ident(ident: &str) -> String {
    let escaped = ident.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Decode a Postgres `pg_trigger.tgtype` bitmask into (timing, event) strings.
/// Bits (see `src/include/catalog/pg_trigger.h`):
///   1 = ROW (else STATEMENT), 2 = BEFORE, 4 = INSERT, 8 = DELETE,
///   16 = UPDATE, 32 = TRUNCATE, 64 = INSTEAD.
/// A trigger may fire on several events, so events are OR-joined.
fn decode_pg_tgtype(tgtype: i16) -> (String, String) {
    let t = tgtype as u16;
    let timing = if t & (1 << 6) != 0 {
        "INSTEAD OF"
    } else if t & (1 << 1) != 0 {
        "BEFORE"
    } else {
        "AFTER"
    }
    .to_string();

    let mut events: Vec<&str> = Vec::new();
    if t & (1 << 2) != 0 {
        events.push("INSERT");
    }
    if t & (1 << 3) != 0 {
        events.push("DELETE");
    }
    if t & (1 << 4) != 0 {
        events.push("UPDATE");
    }
    if t & (1 << 5) != 0 {
        events.push("TRUNCATE");
    }
    (timing, events.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_inline_limit() {
        assert!(has_limit_clause("SELECT * FROM t LIMIT 10"));
    }

    #[test]
    fn ignores_limit_inside_string() {
        assert!(!has_limit_clause("SELECT 'LIMIT 10' AS x"));
    }

    #[test]
    fn ignores_limit_inside_double_quote() {
        assert!(!has_limit_clause(r#"SELECT "LIMIT" FROM t"#));
    }

    #[test]
    fn split_simple_statements() {
        let out = split_statements("SELECT 1; SELECT 2;");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn split_respects_dollar_quotes() {
        // A `;` inside a $$ … $$ block must not split.
        let out = split_statements(
            "CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'a;b'; END $$ LANGUAGE plpgsql;",
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn split_respects_named_dollar_tag() {
        let out = split_statements(
            "CREATE FUNCTION f() RETURNS void AS $func$ BEGIN PERFORM 1; END $func$ LANGUAGE plpgsql;",
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn quote_ident_escapes_double_quotes() {
        assert_eq!(quote_ident(r#"weird"col"#), r#""weird""col""#);
    }

    #[test]
    fn parse_pg_arguments_empty_is_no_params() {
        assert!(parse_pg_arguments("").is_empty());
    }

    #[test]
    fn parse_pg_arguments_named_and_typed() {
        let p = parse_pg_arguments("a integer, b text");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].name, "a");
        assert_eq!(p[0].data_type, "integer");
        assert_eq!(p[1].name, "b");
        assert_eq!(p[1].data_type, "text");
    }

    #[test]
    fn parse_pg_arguments_strips_default() {
        let p = parse_pg_arguments("name text DEFAULT 'hi'::text");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].name, "name");
        assert_eq!(p[0].data_type, "text");
    }

    #[test]
    fn parse_pg_arguments_captures_mode() {
        let p = parse_pg_arguments("OUT id integer, IN name text");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].mode.as_deref(), Some("out"));
        assert_eq!(p[1].mode.as_deref(), Some("in"));
    }

    #[test]
    fn range_parses_inclusive_exclusive() {
        let v = parse_pg_range("[1,5)");
        assert_eq!(v["lower"], json!("1"));
        assert_eq!(v["upper"], json!("5"));
        assert_eq!(v["lowerInc"], json!(true));
        assert_eq!(v["upperInc"], json!(false));
    }

    #[test]
    fn range_parses_empty_sentinel() {
        assert_eq!(parse_pg_range("empty"), json!({ "empty": true }));
    }

    #[test]
    fn range_parses_open_upper() {
        let v = parse_pg_range("[10,)");
        assert_eq!(v["lower"], json!("10"));
        assert_eq!(v["upper"], JsonValue::Null);
        assert_eq!(v["upperInc"], json!(false));
    }

    #[test]
    fn multirange_splits_on_top_level_commas() {
        let v = parse_pg_range("{[1,5),[10,20]}");
        let arr = v.as_array().expect("multirange → array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["lower"], json!("1"));
        assert_eq!(arr[1]["upper"], json!("20"));
    }

    #[test]
    fn array_element_strips_suffix_and_prefix() {
        assert_eq!(array_element("INT4[]"), "INT4");
        assert_eq!(array_element("_TEXT"), "TEXT");
        assert_eq!(array_element("BOOL"), "BOOL");
    }

    #[test]
    fn parse_pg_version_extracts_semver() {
        let (maj, min, flavor) = parse_pg_version(
            "PostgreSQL 16.2 on x86_64-pc-linux-gnu, compiled by gcc 11",
            "16.2",
        );
        assert_eq!(maj, Some(16));
        assert_eq!(min, Some(2));
        assert_eq!(flavor.as_deref(), Some("PostgreSQL"));
    }
}
