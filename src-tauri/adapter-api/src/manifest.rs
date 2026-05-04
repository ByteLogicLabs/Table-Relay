//! Static metadata every adapter ships. The Rust `static` is the
//! source of truth at runtime; `manifest.toml` at each adapter's
//! package root (`src-adapters/<key>/manifest.toml`) is the
//! human-readable mirror + the future format for out-of-tree adapters
//! (dylib, WASM, IPC). The adapter's `backend/build.rs` invokes
//! `manifest_build::generate_manifest` to keep the two in sync.
//!
//! Only added/modified through this file so the host knows every
//! possible capability + permission key upfront — no string-keyed
//! bags, no way for an adapter to sneak in a permission the consent
//! dialog can't describe.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterManifest {
    pub adapter: AdapterInfo,
    pub provenance: Provenance,
    pub capabilities: Capabilities,
    pub permissions: Permissions,
    pub query_editor: QueryEditorInfo,
    pub connection_fields: &'static [ConnectionField],
    /// Column types offered to the user in the "add column" picker.
    /// Lowercase, one canonical token per entry (no inline comments);
    /// the structure editor renders them verbatim, so keep the casing /
    /// parentheses consistent with how users would write them in DDL.
    ///
    /// Empty slice means "no catalogue declared"; the frontend falls back
    /// to a free-text input.
    #[serde(default)]
    pub column_types: &'static [&'static str],
    /// Per-adapter system-prompt paragraph the AI chat splices in when
    /// the user's focused connection is of this adapter. Should cover:
    /// the store's paradigm (SQL / KV / document / …), the query-editor
    /// vocabulary the AI should reach for first, and any cross-adapter
    /// pitfalls (no SQL on Redis; SQLite ALTER quirks; …).
    ///
    /// Keep it short — a couple of paragraphs, no examples longer than
    /// one line. The host trims and indents before prepending to the
    /// global system prompt.
    #[serde(default)]
    pub ai_system_context: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    /// Stable identifier. Lowercase, hyphen-separated for multi-word
    /// (e.g. `"mysql"`, `"sql-server"`). Matches the folder under
    /// `src-adapters/` and `ConnectionProfile::adapter_id`.
    pub key: &'static str,
    pub display_name: &'static str,
    pub version: &'static str,
    pub description: &'static str,
    pub tags: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Provenance {
    pub vendor: &'static str,
    pub homepage: Option<&'static str>,
    pub license: Option<&'static str>,
}

/// "Does this adapter support this feature?" — the UI checks these
/// booleans to gate buttons (diagram, routines, query editor, …) so
/// we never show a control that can't work.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    // schema introspection
    pub schemas: bool,
    pub describe_schema: bool,
    pub foreign_keys: bool,
    pub views: bool,
    pub routines: bool,
    pub indexes: bool,
    pub row_counts: bool,
    // data browsing
    pub browse: bool,
    pub server_filter: bool,
    pub server_sort: bool,
    pub streaming: bool,
    pub keyset_pagination: bool,
    // data mutation
    pub update_rows: bool,
    pub insert_rows: bool,
    pub delete_rows: bool,
    pub transactions: bool,
    // ddl
    pub create_database: bool,
    pub create_table: bool,
    pub alter_table: bool,
    pub drop_table: bool,
    /// Adapter exposes structured create/drop index management via
    /// `Adapter::modify_indexes`. The schema editor uses this path for
    /// adapters that don't speak SQL DDL (Mongo). SQL adapters can also
    /// flip this on if they prefer the structured route.
    pub manage_indexes: bool,
    // app features
    pub diagram: bool,
    pub erd_inference: bool,
    pub query_editor: bool,
    pub explain_plan: bool,
    pub ssh_tunnel: bool,
    /// Adapter supports `process_list` / `kill_process` — the UI shows
    /// a "Processes" panel when set.
    pub process_list: bool,
    // file-level I/O — lists of file-format tokens the adapter can
    // ingest / emit. Empty slice = the operation is unsupported. Token
    // vocabulary is deliberately adapter-neutral ("sql", "csv", "json",
    // "ndjson", …) so the UI can gate file pickers by extension without
    // needing a per-adapter switch statement.
    pub import: &'static [&'static str],
    pub export: &'static [&'static str],
    // Server-pushed events. True for Redis pub/sub, Postgres LISTEN/NOTIFY,
    // Mongo change streams, etc. The UI shows a "Realtime" tab entry only
    // when set. Adapters implement this through `Adapter::subscribe`.
    pub realtime: bool,

    // ---- behavior-shaping flags (replace frontend `connection.driver` checks) ----
    /// Realtime semantics. The realtime view's labels, default patterns,
    /// and verbs (LISTEN/NOTIFY vs SUBSCRIBE/PUBLISH vs change-stream)
    /// derive from this — not from a driver-name match.
    pub realtime_kind: RealtimeKind,
    /// Whether subscription patterns may include glob metacharacters
    /// (`*` / `?` / `[`). Redis's `PSUBSCRIBE` says yes; Postgres `LISTEN`
    /// says no.
    pub glob_subscriptions: bool,
    /// SQL dialect for frontend code that builds SQL text (data-grid
    /// raw INSERT/SELECT, schema-editor DDL, sql-editor `USE` prefix).
    /// `Generic` is the safe ANSI-quoting fallback. Document/KV stores
    /// should use `None`.
    pub sql_dialect: SqlDialect,
    /// How a `boolean` column value should be serialized when committed
    /// back through `update_rows`. Postgres rejects `'1'`/`'0'`; MySQL /
    /// SQLite reject `'true'`/`'false'`.
    pub boolean_literal_format: BooleanLiteralFormat,
    /// Whether the connection has a discoverable list of databases the
    /// user can pick (Postgres' `pg_database`, MySQL's `SHOW DATABASES`,
    /// Mongo's `listDatabases`). SQLite is one file → one db, so false.
    pub database_picker: bool,
    /// Optional column name to hide in the data grid. Mongo sets this to
    /// `"_id"` so the JSON tree is the canonical surface for the doc id.
    /// Empty string means "don't hide anything".
    pub hide_column_in_grid: &'static str,
}

/// How an adapter delivers server-pushed events. Drives the realtime
/// view's label, default pattern, glob support, and the start/stop
/// command verbs in the log.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RealtimeKind {
    /// Adapter doesn't expose a realtime channel.
    #[default]
    None,
    /// Postgres-style: literal channel names, no globs, `NOTIFY`/`LISTEN`.
    ListenNotify,
    /// Redis-style: glob patterns, `PUBLISH`/`SUBSCRIBE`/`PSUBSCRIBE`.
    Pubsub,
    /// Mongo-style change streams: collection-scoped, no payload to publish.
    ChangeStream,
}

/// SQL dialect for code that has to emit SQL text on the frontend
/// (identifier quoting, USE prefixes, ALTER variants). Adapters that
/// don't speak SQL use `None`.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlDialect {
    /// Not a SQL store — the SQL editor / DDL builders should not run.
    #[default]
    None,
    /// ANSI-quoting (`"foo"`), no MySQL-isms.
    Generic,
    Mysql,
    Postgres,
    Sqlite,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BooleanLiteralFormat {
    /// `'1'` / `'0'` — MySQL, SQLite.
    #[default]
    OneZero,
    /// `'true'` / `'false'` — PostgreSQL.
    TrueFalse,
}

/// What the adapter needs from the user's machine. Auto-granted for
/// built-in adapters; surfaced as a consent dialog for third-party
/// loaders later. Closed set — adding one means editing this struct
/// AND the host's consent copy, so no adapter can invent an
/// undescribed permission.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub network_outbound: bool,
    pub ssh_tunnel: bool,
    pub read_ssh_keys: bool,
    pub store_known_hosts: bool,
    pub read_credentials: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEditorInfo {
    /// Human label shown on the tab / button (e.g. "SQL editor",
    /// "Mongo shell", "Redis CLI").
    pub label: &'static str,
    pub placeholder: &'static str,
    /// Comment tags recognized by the query editor before execution.
    /// Line comments: `"--"`, `"//"`, `"#"`.
    /// Block comments: `"/* */"` (start + end separated by a space).
    #[serde(default)]
    pub comment_tags: &'static [&'static str],
    /// Result renderer modes supported in query tab output.
    /// Known values: "table", "json".
    #[serde(default)]
    pub result_view_modes: &'static [&'static str],
    /// One-line runnable examples shown in the editor hint and helper UIs.
    #[serde(default)]
    pub examples: &'static [&'static str],
    /// Optional seed template for synthetic/demo data generation flows.
    /// Empty string means "not provided".
    #[serde(default)]
    pub data_faker_template: &'static str,
    /// Monaco language id.
    pub language: &'static str,
    pub statement_separator: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ConnectionField {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
    pub required: bool,
    pub default: Option<&'static str>,
    pub help: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum FieldKind {
    String,
    Secret,
    Int {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<i64>,
    },
    Enum {
        options: &'static [EnumOption],
    },
    Bool,
    /// A filesystem path the user should pick via the OS file dialog.
    /// The frontend renders this as an input + "Browse…" button.
    File {
        /// Allowed file extensions (no leading dot — `&["db", "sqlite"]`).
        /// Empty = any file.
        #[serde(skip_serializing_if = "<[&str]>::is_empty")]
        extensions: &'static [&'static str],
        /// When true, the picker offers "Save As…" so the user can name a
        /// new file; otherwise only existing files are selectable.
        #[serde(default)]
        allow_create: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct EnumOption {
    pub value: &'static str,
    pub label: &'static str,
}
