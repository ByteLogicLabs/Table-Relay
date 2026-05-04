//! Intent types — inputs to `Adapter::browse`, `count_records`, `mutate`.
//!
//! These replace the ad-hoc SQL-building the frontend used to do. The
//! frontend expresses *what* it wants ("records 100-149 of `users` where
//! `email` contains `@acme`, sorted by `created_at` desc"); the adapter
//! decides how to fetch it.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// "Show me records from a table / collection, optionally filtered + sorted
/// + paginated." The adapter translates this into its native query.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sort: Vec<SortBy>,
    pub page: Page,
    /// When true, the adapter SHOULD return `total_records` on the result so
    /// the UI can render "page X of Y". When false, skip the count to save
    /// a round-trip. Adapters are free to return `None` even when asked
    /// (e.g. counting is too expensive).
    #[serde(default)]
    pub include_total: bool,
}

/// Companion to `BrowseRequest` — same filter set, no pagination, no sort.
/// Exposed separately so clients that already have rows can just ask for
/// the count on demand.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
}

/// Single filter clause — `column OP value`. The adapter picks how to
/// translate the op to its native language.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    /// `None` for unary ops (`IsNull`, `IsNotNull`).
    #[serde(default)]
    pub value: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsNull,
    IsNotNull,
    In,
    NotIn,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortBy {
    pub column: String,
    #[serde(default)]
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    #[default]
    Asc,
    Desc,
}

/// 1-based page index + page size. Kept small + explicit rather than
/// offset/limit so the UI's mental model (`page N of M`) maps directly.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// 1-based.
    pub number: u32,
    pub size: u32,
}

/// Mutation intent — insert a new record, update an existing one by primary
/// key, or delete one by primary key. Adapters that can't identify records
/// by primary key (document stores without `_id`, say) return `Unsupported`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MutateRequest {
    Insert {
        schema: String,
        table: String,
        /// Column → value map for the new record.
        values: std::collections::BTreeMap<String, JsonValue>,
    },
    Update {
        schema: String,
        table: String,
        primary_key: Vec<PrimaryKeyValue>,
        changes: std::collections::BTreeMap<String, JsonValue>,
    },
    Delete {
        schema: String,
        table: String,
        primary_key: Vec<PrimaryKeyValue>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryKeyValue {
    pub column: String,
    pub value: JsonValue,
}

/// Adapter response to a `MutateRequest`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub records_affected: u64,
    /// For `Insert`, the adapter may echo the auto-generated primary key so
    /// the UI can address the new row immediately.
    #[serde(default)]
    pub generated_primary_key: Option<std::collections::BTreeMap<String, JsonValue>>,
}

/// Structured "modify indexes" intent. Each request can drop and create
/// indexes in a single round; the adapter applies drops first, then
/// creates. This is the non-SQL replacement for the schema editor's
/// `CREATE INDEX` / `DROP INDEX` SQL emitter — Mongo (and any other
/// document store) needs it because it doesn't speak DDL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifyIndexesRequest {
    pub schema: String,
    pub table: String,
    /// Names of existing indexes to drop. Adapters that auto-manage the
    /// primary-key index (e.g. Mongo's `_id_`) should silently skip it —
    /// dropping it is rejected by the server anyway.
    #[serde(default)]
    pub drop: Vec<String>,
    #[serde(default)]
    pub create: Vec<IndexSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpec {
    /// Optional. Adapters that require a name should synthesize one
    /// (e.g. `field1_1_field2_-1` for Mongo) when this is empty.
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<IndexColumn>,
    #[serde(default)]
    pub unique: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub name: String,
    /// Per-field key value. Compass models a Mongo index this way: each
    /// row picks its own type. `asc` / `desc` are the regular cases;
    /// `2dsphere`, `2d`, `text`, `hashed`, `wildcard` are the special
    /// ones — they emit `{ field: "<sentinel>" }` instead of `{ field: 1 }`.
    /// Compound indexes mix-and-match (`{ a: 1, location: "2dsphere" }`).
    /// SQL adapters honor only `asc`/`desc`; anything else is treated as
    /// `asc` since SQL doesn't speak Mongo's special key types.
    #[serde(default)]
    pub direction: Option<IndexKeyValue>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndexKeyValue {
    #[default]
    Asc,
    Desc,
    Text,
    #[serde(rename = "2dsphere")]
    TwoDSphere,
    #[serde(rename = "2d")]
    TwoD,
    Hashed,
    /// Mongo wildcard. The field name is rewritten to a `$**` path —
    /// `*` / empty → `$**` (whole document), `path.*` → `path.$**`,
    /// `path` → `path.$**`.
    Wildcard,
}

/// Backward-compat alias — older intent traffic used `IndexDirection`.
/// Equivalent to the asc/desc subset of `IndexKeyValue`. Kept so SQL
/// adapter code that thinks in terms of "direction only" can stay
/// readable without converting through the wider enum.
pub type IndexDirection = IndexKeyValue;

/// Subscribe to server-pushed events. `pattern` is adapter-native —
/// Redis takes a glob (`foo.*`), Postgres a channel name, Mongo a
/// collection + filter JSON. The adapter documents its own vocabulary.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    /// Optional schema scope (Redis DB index like `"db3"`, Mongo db).
    /// Adapters that ignore it should accept any value.
    #[serde(default)]
    pub schema: Option<String>,
    /// Adapter-specific subscription spec. Required.
    pub pattern: String,
}

/// One server-pushed event. Flat shape so the UI can render without
/// knowing which adapter produced it. Extra per-adapter metadata goes
/// under `extras` (a free-form JSON map) rather than adding keys here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeEvent {
    /// Channel / topic the event came from.
    pub channel: String,
    /// Pattern the event matched, if the subscription was a glob.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Payload as adapter best-effort JSON. Binary/non-UTF-8 payloads
    /// get the standard `{"__binary__": true, "bytes": N}` sentinel.
    pub payload: JsonValue,
    /// Unix ms when the event arrived at the adapter.
    pub received_at_ms: i64,
    /// Adapter-specific metadata (e.g. Redis message type). Always set,
    /// possibly to an empty object, so the TS side doesn't need a guard.
    pub extras: std::collections::BTreeMap<String, JsonValue>,
}
