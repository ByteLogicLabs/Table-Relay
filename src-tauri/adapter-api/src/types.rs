//! Value types the adapter trait takes and returns. Kept neutral — no SQL
//! vocabulary leaks through names — so the same surface works for Mongo,
//! Redis, etc. when we add them.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Adapter-facing connection profile. Distinct from the store's row shape
/// (which also has ids, timestamps, consent flags) so the store can evolve
/// without the adapter trait churning.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    /// Stable adapter id — matches `AdapterManifest::id` (e.g. `"mysql"`).
    pub adapter_id: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// Freeform SSL mode string — interpretation is adapter-specific.
    pub ssl_mode: Option<String>,

    // --- SSH tunnel (optional; only honored by adapters that declare the
    // `ssh-tunnel` permission in their manifest) ---
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    #[serde(default)]
    pub ssh_auth_kind: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    #[serde(default)]
    pub ssh_key_passphrase: Option<String>,

    /// Adapter-specific extension bag. Lets an adapter declare fields in its
    /// manifest that neither the host nor other adapters know about.
    #[serde(default)]
    pub extras: std::collections::BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// Adapter id — e.g. `"mysql"`. Matches `ConnectionProfile::adapter_id`.
    pub adapter_id: String,
    /// Raw version string as reported by the server.
    pub version: String,
    #[serde(default)]
    pub version_major: Option<u32>,
    #[serde(default)]
    pub version_minor: Option<u32>,
    /// Adapter-specific flavor label — e.g. "MySQL" / "MariaDB" / "Percona".
    #[serde(default)]
    pub flavor: Option<String>,
    pub default_schema: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub tables: Vec<TableInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: TableKind,
    pub row_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
    /// Populated by document stores (Mongo, etc.).
    Collection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub schema: String,
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub row_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub length: Option<i64>,
    pub is_primary: bool,
    pub is_unique: bool,
    pub is_foreign: bool,
    pub is_indexed: bool,
    /// Adapter-specific extras (e.g. MySQL `EXTRA` column). Empty when absent.
    #[serde(default)]
    pub extra: String,
    #[serde(default)]
    pub character_set: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub from_schema: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_schema: String,
    pub to_table: String,
    pub to_columns: Vec<String>,
}

/// Result of `execute_raw`. May contain multiple statements; each carries its
/// own timing + rows/affected count.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub statements: Vec<StatementResult>,
}

// ---- Process list / kill ----

/// One active process/connection on the database server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    /// Seconds the process has been in its current state.
    #[serde(default)]
    pub time: Option<u64>,
    #[serde(default)]
    pub state: Option<String>,
    /// The SQL / command text currently executing (may be truncated).
    #[serde(default)]
    pub info: Option<String>,
    pub kind: ProcessKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessKind {
    Connection,
    Query,
    Sleep,
    Other(String),
}

/// Result of a single kill attempt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillResult {
    pub id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---- Command warnings (destructive query detection) ----

/// A structured warning about a command before execution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandWarning {
    pub kind: WarningKind,
    pub message: String,
    /// The specific statement that triggered the warning.
    pub statement: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WarningKind {
    DestructiveNoWhere,
    DropObject,
    TruncateTable,
    BulkUpdate,
    Custom(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// The command as the user submitted it (SQL string, Mongo command, …).
    pub sql: String,
    pub duration_ms: f64,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<JsonValue>>,
    pub rows_affected: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_hint: String,
}

/// Result of `browse` — rows come back as `Vec<Vec<JsonValue>>` aligned to
/// `columns`, same wire shape the frontend already consumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<JsonValue>>,
    pub duration_ms: f64,
    /// Echoes the 1-based page index the rows were fetched for. Lets the
    /// UI ignore a stale response if the user paged again mid-flight.
    pub page: u32,
    /// Populated when the caller asked for a count in the same round-trip.
    #[serde(default)]
    pub total_records: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub name: String,
    pub is_updatable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name: String,
    /// "procedure" | "function".
    pub kind: String,
    pub returns: Option<String>,
    pub parameters: Vec<RoutineParam>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineParam {
    pub name: String,
    pub data_type: String,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDefinition {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub returns: Option<String>,
    pub parameters: Vec<RoutineParam>,
    pub body: String,
    pub is_deterministic: bool,
    pub data_access: String,
    pub security_type: String,
    pub definer: String,
    pub create_sql: String,
}

/// Summary row for a trigger, surfaced in the sidebar's "Triggers" section.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// Table the trigger is attached to.
    pub table: String,
    /// "BEFORE" | "AFTER" | "INSTEAD OF".
    pub timing: String,
    /// "INSERT" | "UPDATE" | "DELETE" (MySQL: single event; Postgres/SQLite
    /// may combine, e.g. "INSERT OR UPDATE" — adapters return the raw form).
    pub event: String,
}

/// Full definition for one trigger, used by the trigger editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDefinition {
    pub schema: String,
    pub name: String,
    pub table: String,
    pub timing: String,
    pub event: String,
    /// Trigger body / action statement (the part after `FOR EACH ROW` etc.).
    pub body: String,
    /// The full `CREATE TRIGGER …` statement reconstructed for display/editing.
    pub create_sql: String,
}

/// Structured request to create-or-replace a trigger. The adapter owns the
/// DDL generation per dialect (MySQL has no `CREATE OR REPLACE TRIGGER`, so it
/// drops then recreates inside the same call).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTriggerRequest {
    pub schema: String,
    pub name: String,
    /// Previous name when renaming/editing an existing trigger; `None` for a
    /// brand-new trigger. Adapters drop the old one before creating the new.
    pub original_name: Option<String>,
    pub table: String,
    pub timing: String,
    pub event: String,
    pub body: String,
    /// Optional raw `CREATE TRIGGER …` override. When provided the adapter runs
    /// it verbatim (after dropping `original_name` if set) instead of assembling
    /// the statement from the structured fields. Lets the editor offer a
    /// free-form DDL mode for dialect features the structured form can't express.
    pub create_sql: Option<String>,
}
