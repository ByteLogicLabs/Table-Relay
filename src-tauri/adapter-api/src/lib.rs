//! Public surface every built-in adapter implements.
//!
//! This crate defines the `Adapter` trait plus the intent types it
//! takes and the value types it returns. The host (`db-table`) links
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
    BrowseResult, ColumnInfo, ColumnMeta, ConnectionProfile, ForeignKey, IndexInfo, QueryResult,
    RoutineDefinition, RoutineInfo, RoutineParam, SchemaInfo, ServerInfo, StatementResult,
    TableInfo, TableKind, TableStructure, ViewInfo,
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
