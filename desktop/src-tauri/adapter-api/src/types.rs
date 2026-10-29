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

/// One labeled server/database statistic for the connection "Information"
/// dialog (server version, default collation, on-disk size, table count,
/// uptime, …). Adapters return whatever is meaningful for their engine as
/// pre-formatted display strings; the UI renders them verbatim as label/value
/// rows, so adapters own the formatting (human-readable byte sizes, etc.).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDetail {
    pub label: String,
    pub value: String,
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
    /// Index method / algorithm as the engine reports it (MySQL
    /// `INDEX_TYPE`: BTREE/HASH/FULLTEXT/SPATIAL; Postgres `pg_am.amname`:
    /// btree/hash/gin/gist/…). `None` for adapters that don't expose it.
    /// Lets the schema editor show the real method and diff changes to it
    /// instead of always assuming BTREE.
    #[serde(default)]
    pub algorithm: Option<String>,
    /// True when this index physically backs the table's PRIMARY KEY (MySQL
    /// `PRIMARY`, Postgres `<table>_pkey`, SQLite `origin = pk`, Mongo `_id_`).
    /// The schema editor shows it read-only since the PK is managed through the
    /// column's PRIMARY flag, not the index pane — this lets the frontend tell
    /// which index that is without dialect-specific name guessing.
    #[serde(default)]
    pub is_primary: bool,
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
    /// Referential actions as canonical SQL (`NO ACTION`, `CASCADE`,
    /// `SET NULL`, `RESTRICT`, `SET DEFAULT`). `None` when the adapter
    /// doesn't surface them; the editor then shows `NO ACTION` and only
    /// marks the FK dirty on a real change once actions are known.
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
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

/// Hard safety ceiling on rows returned by a single raw-query statement that
/// carries no `LIMIT` of its own. A `SELECT * FROM huge_table` with no bound
/// would otherwise materialize the whole table into memory and flood the
/// frontend (freezing the UI). Adapters append `LIMIT MAX_RESULT_ROWS` to such
/// statements and set `StatementResult::truncated` when the ceiling is hit.
/// This is a backstop, not the normal paging size — the query editor pages at
/// 50-1000 rows and browse is server-paginated; only otherwise-unbounded
/// queries reach this cap.
pub const MAX_RESULT_ROWS: u32 = 10_000;

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
    /// True when the result was capped at `MAX_RESULT_ROWS` because the
    /// statement had no `LIMIT` of its own — more rows exist on the server.
    #[serde(default)]
    pub truncated: bool,
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

// ---- User / role management ----
//
// Engine-neutral surface for the "Manage users" feature. SQL engines map a
// user to an account (`'name'@'host'` on MySQL, a `ROLE` on Postgres); document
// / KV stores map it to their own account concept (Mongo users, Redis ACL
// users). The adapter owns the dialect — the frontend only ever sees these
// structs.

/// Whether the *current* connection is allowed to manage other users, plus a
/// short human-readable reason to show when it can't. Returned by
/// `Adapter::can_manage_users`; the UI both gates the feature per-driver (via
/// the manifest `manage_users` flag) AND disables the create/alter/drop
/// controls at runtime based on this.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageUsersCapability {
    /// The current account can create/alter/drop users and edit privileges.
    pub can_manage: bool,
    /// Why not, when `can_manage` is false (e.g. "requires the CREATE USER
    /// privilege"). Empty when `can_manage` is true.
    pub reason: String,
}

/// One database user / role / account, as shown in the users list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    /// Account name. For MySQL this is the bare user (paired with `host`);
    /// for Postgres/Mongo/Redis it is the role/user name.
    pub name: String,
    /// Host the account is scoped to (MySQL `'name'@'host'`). `None` for
    /// engines without a host component.
    #[serde(default)]
    pub host: Option<String>,
    /// True when the account can log in (Postgres `rolcanlogin`, MySQL always
    /// true, Redis `on`). `None` when the concept doesn't apply.
    #[serde(default)]
    pub can_login: Option<bool>,
    /// True when the account has server-admin / superuser powers (Postgres
    /// `rolsuper`, MySQL `SUPER`/`ALL … WITH GRANT OPTION`, Mongo root).
    #[serde(default)]
    pub is_superuser: Option<bool>,
    /// True when the account is locked / disabled and cannot connect.
    #[serde(default)]
    pub is_locked: Option<bool>,
    /// Free-form extra attributes to show as a secondary line (e.g. Postgres
    /// "Create DB, Create role"; Mongo databases the roles span). Adapter-
    /// formatted for display; may be empty.
    #[serde(default)]
    pub attributes: Vec<String>,
}

/// The effective privileges / grants held by a single account. `statements`
/// are the engine's own grant lines, shown verbatim so nothing is lost in
/// translation (MySQL `SHOW GRANTS`, Postgres assembled `GRANT …`, Mongo role
/// list, Redis ACL rule string).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantInfo {
    pub statements: Vec<String>,
}

/// Request to create a new user / role.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub name: String,
    /// MySQL host part; ignored by engines without a host concept. Defaults to
    /// `%` when omitted for MySQL.
    #[serde(default)]
    pub host: Option<String>,
    /// Plaintext password to set. `None` creates a password-less account where
    /// the engine allows it.
    #[serde(default)]
    pub password: Option<String>,
    /// Grant server-admin / superuser powers on creation (Postgres `SUPERUSER`,
    /// MySQL `WITH GRANT OPTION` on `*.*`). Defaults to false.
    #[serde(default)]
    pub is_superuser: bool,
    /// Whether the account may log in (Postgres `LOGIN`). Defaults to true.
    #[serde(default = "default_true")]
    pub can_login: bool,
}

/// Request to alter an existing user / role. Only the `Some` fields are
/// applied; `None` leaves that attribute unchanged.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterUserRequest {
    pub name: String,
    #[serde(default)]
    pub host: Option<String>,
    /// New password. `Some("")` is rejected by adapters; `None` leaves it.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub is_superuser: Option<bool>,
    #[serde(default)]
    pub can_login: Option<bool>,
    /// Lock (true) / unlock (false) the account. `None` leaves it.
    #[serde(default)]
    pub is_locked: Option<bool>,
}

/// Identifies a single account for drop / grant-inspection. `host` is the
/// MySQL host part, ignored elsewhere.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    pub name: String,
    #[serde(default)]
    pub host: Option<String>,
}

fn default_true() -> bool {
    true
}
