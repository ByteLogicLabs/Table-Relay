//! Public surface every built-in adapter implements.
//!
//! This crate defines the `Adapter` trait plus the intent types it
//! takes and the value types it returns. The host (`table-relay`) links
//! every adapter directly — there is no dylib boundary, no ABI stamp —
//! so every type here is a plain Rust struct/enum.
//!
//! Vocabulary is intentionally SQL-agnostic so the same surface fits
//! non-SQL stores (Mongo, Redis, …) later. See `multi-drivers.md` for
//! the architecture document.

pub mod error;
pub mod intent;
pub mod log;
pub mod manifest;
pub mod ssh_hosts;
pub mod template;
pub mod types;

/// Render bytes as an uppercase hex string (e.g. `FFD8FFE0…`). Used by adapters
/// to surface a non-UTF-8 BLOB/`bytea`/binary value in a readable, copyable form
/// — the same convention TablePlus and other clients use — instead of dropping
/// it or showing a placeholder. Dep-free so every adapter can call it.
pub fn bytes_to_hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Heuristic: do these bytes look like binary (not human-readable text)?
/// Used to decide whether a column value — from EITHER the binary (`Vec<u8>`)
/// or the text (`String`) read path — should be shown as hex instead of a
/// blank/garbled cell, matching TablePlus.
///
/// Operates on raw bytes so it's correct for any encoding: a NUL byte, or more
/// than ~10% C0 control bytes (tab/newline/return excepted), means binary.
/// Multi-byte UTF-8 (emoji incl. zero-width joiners, CJK, accents) is all
/// high bytes (0x80+), never flagged — real text is preserved.
pub fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let mut control = 0usize;
    for &b in bytes {
        if b == 0 {
            return true; // a NUL byte is a near-certain binary signal
        }
        if b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r' {
            control += 1;
        }
    }
    control * 100 > bytes.len() * 10
}

use std::sync::Arc;

use async_trait::async_trait;

pub use error::AdapterError;
pub use intent::{
    BrowseRequest, CountRequest, Filter, FilterOp, IndexColumn, IndexDirection, IndexKeyValue,
    IndexSpec, ModifyIndexesRequest, MutateRequest, Mutation, Page, PrimaryKeyValue, SortBy,
    SortDirection, SubscribeEvent, SubscribeRequest,
};
pub use manifest::{
    AdapterInfo, AdapterManifest, BooleanLiteralFormat, Capabilities, ConnectionField, EnumOption,
    FieldKind, Permissions, Provenance, QueryEditorInfo, RealtimeKind, SqlDialect,
};
pub use types::{
    BrowseResult, ColumnInfo, ColumnMeta, CommandWarning, ConnectionProfile, ForeignKey, IndexInfo,
    KillResult, ProcessInfo, ProcessKind, QueryResult, RoutineDefinition, RoutineInfo, RoutineParam,
    SaveTriggerRequest, SchemaInfo, ServerDetail, ServerInfo, StatementResult, TableInfo, TableKind,
    TableStructure, TriggerDefinition, TriggerInfo, ViewInfo, WarningKind,
};

/// Contract every built-in adapter implements.
///
/// Methods are grouped by intent: metadata → schema introspection →
/// data browsing → data mutation → DDL → escape hatch → lifecycle.
/// Non-trivial methods default to `Unsupported` so a new adapter can
/// grow one capability at a time.
#[async_trait]
pub trait Adapter: Send + Sync {
    // ---- metadata ------------------------------------------------------

    /// Round-trip check. Returns server identity + default schema.
    async fn ping(&self) -> Result<ServerInfo, AdapterError>;

    /// Live server/database statistics for the connection "Information" dialog:
    /// default collation/charset, on-disk size, table/collection count, server
    /// uptime, active connections, and so on. `schema` is the
    /// currently-focused database, so size/collation can be scoped to it.
    ///
    /// Each adapter returns whatever is meaningful for its engine, already
    /// formatted for display. Default is empty — the dialog then shows only the
    /// connection profile fields.
    async fn server_details(
        &self,
        _schema: Option<&str>,
    ) -> Result<Vec<ServerDetail>, AdapterError> {
        Ok(Vec::new())
    }

    // ---- schema introspection -----------------------------------------

    /// Every schema (database, namespace, …) the current user can see,
    /// plus the tables/collections inside each.
    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AdapterError>;

    /// Names of the top-level *databases* on this server, for the
    /// "Open database" picker. For engines where databases and schemas
    /// are the same thing (MySQL, SQLite) the default derives names
    /// from `list_schemas`. Postgres overrides to return `pg_database`
    /// since schemas there are a separate concept nested inside a
    /// database.
    async fn list_databases(&self) -> Result<Vec<String>, AdapterError> {
        let schemas = self.list_schemas().await?;
        Ok(schemas.into_iter().map(|s| s.name).collect())
    }

    /// Full structural info for one table/collection. For SQL adapters
    /// this is columns + indexes + FKs; for others it's whatever best
    /// approximates.
    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, AdapterError>;

    /// Bulk describe every table in a schema. Default loops
    /// `describe_table`; SQL adapters should override with a single
    /// info_schema round-trip.
    async fn describe_schema(
        &self,
        schema: &str,
    ) -> Result<Vec<TableStructure>, AdapterError> {
        let schemas = self.list_schemas().await?;
        let Some(info) = schemas.iter().find(|s| s.name == schema) else {
            return Err(AdapterError::NotFound(format!("schema {schema} not found")));
        };
        let mut out = Vec::with_capacity(info.tables.len());
        for t in &info.tables {
            if let Ok(s) = self.describe_table(schema, &t.name).await {
                out.push(s);
            }
        }
        Ok(out)
    }

    /// All relations (FKs) inside a schema. SQL adapters implement;
    /// document/KV adapters return `Unsupported` or infer.
    async fn list_relations(
        &self,
        _schema: &str,
    ) -> Result<Vec<ForeignKey>, AdapterError> {
        Err(AdapterError::Unsupported(
            "list_relations not implemented for this adapter".into(),
        ))
    }

    /// List views (SQL-specific). Default `Unsupported`.
    async fn list_views(&self, _schema: &str) -> Result<Vec<ViewInfo>, AdapterError> {
        Err(AdapterError::Unsupported(
            "list_views not implemented for this adapter".into(),
        ))
    }

    /// `CREATE VIEW` DDL for one view, used by SQL export. Default
    /// `Unsupported` — adapters without views (or without a way to render the
    /// DDL) leave it, and the export simply skips views for that driver.
    async fn view_definition(
        &self,
        _schema: &str,
        _name: &str,
    ) -> Result<String, AdapterError> {
        Err(AdapterError::Unsupported(
            "view_definition not implemented for this adapter".into(),
        ))
    }

    /// List stored routines (procedures / functions). Default `Unsupported`.
    async fn list_routines(
        &self,
        _schema: &str,
    ) -> Result<Vec<RoutineInfo>, AdapterError> {
        Err(AdapterError::Unsupported(
            "list_routines not implemented for this adapter".into(),
        ))
    }

    /// Fetch full definition for a routine. Default `Unsupported`.
    async fn describe_routine(
        &self,
        _schema: &str,
        _name: &str,
        _kind: &str,
    ) -> Result<RoutineDefinition, AdapterError> {
        Err(AdapterError::Unsupported(
            "describe_routine not implemented for this adapter".into(),
        ))
    }

    /// List triggers in a schema (SQL-specific). Default `Unsupported`.
    async fn list_triggers(
        &self,
        _schema: &str,
    ) -> Result<Vec<TriggerInfo>, AdapterError> {
        Err(AdapterError::Unsupported(
            "list_triggers not implemented for this adapter".into(),
        ))
    }

    /// Fetch a trigger's full definition. Default `Unsupported`.
    async fn describe_trigger(
        &self,
        _schema: &str,
        _name: &str,
    ) -> Result<TriggerDefinition, AdapterError> {
        Err(AdapterError::Unsupported(
            "describe_trigger not implemented for this adapter".into(),
        ))
    }

    /// Create or replace a trigger. Adapters own the per-dialect DDL: MySQL
    /// has no `CREATE OR REPLACE TRIGGER`, so it drops `original_name` (when
    /// set) before creating. Default `Unsupported`.
    async fn save_trigger(
        &self,
        _req: SaveTriggerRequest,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "save_trigger not implemented for this adapter".into(),
        ))
    }

    /// Drop a trigger. Default `Unsupported`.
    async fn drop_trigger(
        &self,
        _schema: &str,
        _name: &str,
        _table: &str,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "drop_trigger not implemented for this adapter".into(),
        ))
    }

    // ---- data browsing -------------------------------------------------

    /// Paginate + filter + sort rows from one table/collection. The
    /// adapter owns the translation to its native query language — the
    /// frontend never sees SQL on this path.
    async fn browse(&self, req: BrowseRequest) -> Result<BrowseResult, AdapterError>;

    /// Total record count under a filter. Adapters may return `None`
    /// to signal "counting is too expensive, don't show a total".
    async fn count_records(
        &self,
        req: CountRequest,
    ) -> Result<Option<u64>, AdapterError>;

    /// Fetch one full record by primary-key value, untruncated.
    ///
    /// Adapters whose `browse` returns size-capped previews of huge values
    /// (Mongo) override this so the UI can lazy-load the complete record when
    /// the user opens a single row. `id` is the JSON form of the record's
    /// primary key. Returns `None` if no record matches.
    ///
    /// Default returns `Unsupported` — SQL adapters return full values in
    /// `browse` already and don't need a second fetch.
    async fn get_record(
        &self,
        _schema: &str,
        _table: &str,
        _id: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, AdapterError> {
        Err(AdapterError::Unsupported(
            "get_record not implemented for this adapter".into(),
        ))
    }

    // ---- data mutation -------------------------------------------------

    /// Insert / update / delete records identified by primary key.
    async fn mutate(&self, req: MutateRequest) -> Result<Mutation, AdapterError>;

    // ---- DDL -----------------------------------------------------------

    /// Create a new schema / database / namespace. `charset` /
    /// `collation` are SQL-specific hints; non-SQL adapters ignore them.
    async fn create_schema(
        &self,
        _name: &str,
        _charset: Option<&str>,
        _collation: Option<&str>,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "create_schema not implemented for this adapter".into(),
        ))
    }

    /// Character sets / encodings the live server offers for new
    /// databases. The "Create database" dialog renders these as the
    /// Encoding picker; an empty list means the dialog hides the row.
    ///
    /// Default returns `Ok(vec![])` — adapters that don't model
    /// per-database encodings (SQLite, Mongo, Redis) leave the default;
    /// MySQL queries `SHOW CHARACTER SET`.
    async fn list_charsets(&self) -> Result<Vec<String>, AdapterError> {
        Ok(Vec::new())
    }

    /// Collations the live server offers, scoped to the chosen
    /// `charset`. Returning an empty list means the dialog hides the
    /// Collation row even after the user picks an encoding.
    async fn list_collations(&self, _charset: &str) -> Result<Vec<String>, AdapterError> {
        Ok(Vec::new())
    }

    /// Every collation the live server knows about, independent of any
    /// charset. The schema editor's per-column "collation" cell renders
    /// these as a searchable dropdown (free-text still accepted). MySQL
    /// reads `information_schema.COLLATIONS`; Postgres reads
    /// `pg_collation`. Default returns `Ok(vec![])` so adapters without a
    /// collation concept (SQLite, Mongo, Redis) keep a free-text cell.
    async fn list_all_collations(&self) -> Result<Vec<String>, AdapterError> {
        Ok(Vec::new())
    }

    /// Apply a structured "modify indexes" request — drop named indexes,
    /// create new ones, in that order, against a single table/collection.
    /// Default returns `Unsupported`; adapters opt in by overriding and
    /// flipping `Capabilities::manage_indexes` in the manifest.
    ///
    /// Frontend uses this for adapters that don't speak DDL (Mongo).
    /// SQL adapters keep the existing path of generating `CREATE INDEX` /
    /// `DROP INDEX` statements through the schema editor's save-batch
    /// builder; this method is here so the document-store path has a
    /// structured channel rather than abusing `execute_raw`.
    async fn modify_indexes(
        &self,
        _req: ModifyIndexesRequest,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "modify_indexes not implemented for this adapter".into(),
        ))
    }

    // ---- escape hatch --------------------------------------------------

    /// Run an adapter-native command verbatim. For SQL this is a SQL
    /// string; for Mongo it would be a command document. Frontends that
    /// want the "query editor" experience call this.
    async fn execute_raw(
        &self,
        command: &str,
        row_limit: Option<u32>,
    ) -> Result<QueryResult, AdapterError>;

    /// Run an adapter-native command with an optional schema/database scope
    /// supplied by the UI. Adapters that do not have a per-command database
    /// switch can ignore `schema`; SQL adapters can use it to make query-tab
    /// execution follow the database selected in the workspace rail.
    async fn execute_raw_scoped(
        &self,
        command: &str,
        row_limit: Option<u32>,
        _schema: Option<&str>,
    ) -> Result<QueryResult, AdapterError> {
        self.execute_raw(command, row_limit).await
    }

    /// Streaming variant of `execute_raw_scoped`. Implementations that can
    /// execute a batch statement-by-statement on one session should send each
    /// `StatementResult` as soon as it is available and still return the full
    /// `QueryResult` at the end. The default preserves compatibility for
    /// adapters that only expose a batch result.
    async fn execute_raw_scoped_stream(
        &self,
        command: &str,
        row_limit: Option<u32>,
        schema: Option<&str>,
        sink: tokio::sync::mpsc::UnboundedSender<StatementResult>,
    ) -> Result<QueryResult, AdapterError> {
        let result = self.execute_raw_scoped(command, row_limit, schema).await?;
        for statement in &result.statements {
            let _ = sink.send(statement.clone());
        }
        Ok(result)
    }

    // ---- command analysis -----------------------------------------------

    /// Return structured warnings for a raw command before execution.
    /// Default returns empty vec (no warnings). Adapters override to
    /// flag destructive patterns in their native query language.
    async fn analyze_command(&self, _command: &str) -> Vec<CommandWarning> {
        Vec::new()
    }

    // ---- process list ---------------------------------------------------

    /// List active processes/connections on the server. Default returns
    /// Unsupported — adapters opt in by overriding and flipping
    /// `Capabilities::process_list` in the manifest.
    async fn process_list(&self) -> Result<Vec<ProcessInfo>, AdapterError> {
        Err(AdapterError::Unsupported(
            "process_list not supported by this adapter".into(),
        ))
    }

    /// Kill a single process/connection by its identifier. Default
    /// returns Unsupported.
    async fn kill_process(&self, _id: &str) -> Result<(), AdapterError> {
        Err(AdapterError::Unsupported(
            "kill_process not supported by this adapter".into(),
        ))
    }

    /// Kill multiple processes/connections at once. Default loops
    /// `kill_process`; adapters can override for efficiency (e.g.
    /// MySQL can batch KILL statements).
    async fn kill_processes(&self, ids: &[String]) -> Result<Vec<KillResult>, AdapterError> {
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            match self.kill_process(id).await {
                Ok(()) => results.push(KillResult {
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

    // ---- realtime ------------------------------------------------------

    /// Subscribe to server-pushed events (Redis pub/sub, Postgres
    /// LISTEN/NOTIFY, Mongo change streams, …). The adapter spawns its
    /// own task to pump events into `sink`; the returned handle owns a
    /// cancel trigger so the caller can stop the subscription.
    ///
    /// Default implementation rejects — adapters opt in by overriding +
    /// flipping `capabilities.realtime` in the manifest.
    async fn subscribe(
        &self,
        _req: SubscribeRequest,
        _sink: tokio::sync::mpsc::UnboundedSender<SubscribeEvent>,
    ) -> Result<SubscriptionHandle, AdapterError> {
        Err(AdapterError::Unsupported(
            "subscribe not implemented for this adapter".into(),
        ))
    }

    // ---- lifecycle -----------------------------------------------------

    /// Gracefully close pools / sessions. Called when the user disconnects.
    async fn shutdown(&self);
}

/// Opaque handle the host holds per active subscription. Dropping it
/// signals the adapter's pump task to exit; explicit `cancel()` is the
/// same thing but reads better at call sites.
pub struct SubscriptionHandle {
    cancel: tokio::sync::oneshot::Sender<()>,
}

impl SubscriptionHandle {
    pub fn new() -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Self { cancel: tx }, rx)
    }

    /// Signal the adapter's pump to stop. Safe to call once; ignored
    /// if the receiver has already been dropped.
    pub fn cancel(self) {
        let _ = self.cancel.send(());
    }
}

/// Constructs `Adapter` instances. One `Factory` per registered
/// adapter kind, kept in the host `FactoryRegistry` for the life of
/// the app. `connect` takes a decrypted `ConnectionProfile` (secrets
/// already pulled from the store) and returns a live connection.
#[async_trait]
pub trait Factory: Send + Sync {
    /// Static metadata about this adapter.
    fn manifest(&self) -> &'static AdapterManifest;

    /// Build a fresh `Adapter` from a profile.
    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> Result<Arc<dyn Adapter>, AdapterError>;
}
