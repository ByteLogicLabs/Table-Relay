//! Tool definitions exposed to the model + the Rust-side dispatcher that
//! executes them.
//!
//! Protocol: OpenAI-compatible `tools` / `tool_calls`. Works out of the box
//! for OpenAI proper, `llama-server`, Ollama, Groq, LM Studio — any backend
//! that speaks `/v1/chat/completions` with `tool_choice: auto`. Anthropic +
//! Gemini have their own tool-use shapes; they fall back to plain chat
//! (context-only) in v1.
//!
//! Approval model: `list_schemas`, `list_tables`, `describe_table` run
//! silently — they expose shapes only, never rows. `call_sql` is gated
//! behind an async approval round-trip with the UI so the user sees the
//! SQL before it executes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

use crate::db::registry::Registry;

use super::AiError;

/// Coarse operation class for a single SQL/command statement. Drives
/// per-tier auto-approval: the user can let the model run reads silently
/// while still being prompted before writes or schema changes. `Destructive`
/// is the irreversible subset (no-WHERE DELETE/UPDATE, DROP, TRUNCATE) and
/// is NEVER auto-approvable — it always requires an explicit prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryTier {
    Read,        // SELECT / SHOW / EXPLAIN / WITH-cte SELECT, Mongo find/aggregate, Redis GET
    Write,       // INSERT / UPDATE (with WHERE), Mongo insert/update, Redis SET
    Create,      // CREATE TABLE/INDEX/VIEW/DATABASE, Mongo createCollection/createIndex
    Delete,      // DELETE (with WHERE), Mongo deleteOne/deleteMany(filter), Redis DEL
    Destructive, // no-WHERE DELETE/UPDATE, DROP, TRUNCATE, Mongo drop/dropDatabase
}

impl QueryTier {
    /// Short human label for the approval card badge.
    pub fn label(self) -> &'static str {
        match self {
            QueryTier::Read => "READ",
            QueryTier::Write => "WRITE",
            QueryTier::Create => "CREATE",
            QueryTier::Delete => "DELETE",
            QueryTier::Destructive => "DESTRUCTIVE",
        }
    }
}

/// Does this statement contain a top-level WHERE clause? Crude but adequate:
/// we only need it to distinguish "DELETE FROM t" from "DELETE FROM t WHERE …".
/// A WHERE that only appears inside a parenthesised subquery still counts as
/// "no top-level WHERE" so we err toward treating it as destructive.
fn has_top_level_where(upper: &str) -> bool {
    let bytes = upper.as_bytes();
    let mut depth: i32 = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth = (depth - 1).max(0),
            b'W' if depth == 0 => {
                // word-boundary match for "WHERE"
                if upper[i..].starts_with("WHERE") {
                    let before = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
                    let after = i + 5 >= bytes.len() || !bytes[i + 5].is_ascii_alphanumeric();
                    if before && after {
                        return true;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Strip a leading `WITH <cte> AS (...)` prefix so the real verb (which may be
/// `DELETE`/`UPDATE`/`INSERT` after a CTE) is what we classify.
fn strip_leading_cte(upper: &str) -> &str {
    let trimmed = upper.trim_start();
    if !trimmed.starts_with("WITH") {
        return trimmed;
    }
    // Walk past balanced parens of the CTE list; the statement verb follows
    // the last `)` before a top-level keyword. Cheap heuristic: find the first
    // top-level DML/DDL keyword after depth returns to 0.
    let bytes = trimmed.as_bytes();
    let mut depth: i32 = 0;
    let mut i = 4; // past "WITH"
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth = (depth - 1).max(0),
            _ if depth == 0 => {
                for kw in ["SELECT", "INSERT", "UPDATE", "DELETE"] {
                    if trimmed[i..].starts_with(kw) {
                        return &trimmed[i..];
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    trimmed
}

/// Classify a single SQL statement. Used for SQL-dialect adapters; Mongo/Redis
/// pass through `classify_native` instead.
pub fn classify_sql(sql: &str) -> QueryTier {
    let upper_full = sql.trim().to_ascii_uppercase();
    let upper = strip_leading_cte(&upper_full);

    let starts = |kw: &str| upper.starts_with(kw);

    // Irreversible structural changes first.
    if starts("DROP ") || starts("TRUNCATE") {
        return QueryTier::Destructive;
    }
    if starts("ALTER") {
        // ALTER ... DROP <col/constraint> is destructive; other ALTERs are DDL.
        return if upper.contains(" DROP ") { QueryTier::Destructive } else { QueryTier::Create };
    }
    if starts("CREATE") {
        return QueryTier::Create;
    }
    if starts("DELETE") {
        return if has_top_level_where(upper) { QueryTier::Delete } else { QueryTier::Destructive };
    }
    if starts("UPDATE") {
        return if has_top_level_where(upper) { QueryTier::Write } else { QueryTier::Destructive };
    }
    if starts("INSERT") || starts("REPLACE") || starts("UPSERT") || starts("MERGE") {
        return QueryTier::Write;
    }
    // SELECT / SHOW / EXPLAIN / DESCRIBE / WITH-select / PRAGMA / etc.
    QueryTier::Read
}

/// Highest (most dangerous) tier across all `;`-separated statements in a
/// batch. Ordering: Destructive > Delete > Create > Write > Read. A batch is
/// gated at its strongest tier so a sneaky `SELECT 1; DROP TABLE x` can't ride
/// in under the Read permission.
pub fn classify_batch(sql: &str) -> QueryTier {
    fn rank(t: QueryTier) -> u8 {
        match t {
            QueryTier::Read => 0,
            QueryTier::Write => 1,
            QueryTier::Create => 2,
            QueryTier::Delete => 3,
            QueryTier::Destructive => 4,
        }
    }
    split_statements_lenient(sql)
        .into_iter()
        .map(|s| classify_sql(&s))
        .max_by_key(|t| rank(*t))
        .unwrap_or(QueryTier::Read)
}

/// Split on `;` while respecting single/double quotes and backtick identifiers.
/// Good enough for tier classification (we don't need perfect statement
/// boundaries, only to not mistake a `;` inside a string literal for a split).
fn split_statements_lenient(sql: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let (mut sq, mut dq, mut bq) = (false, false, false);
    let mut prev = '\0';
    for ch in sql.chars() {
        match ch {
            '\'' if !dq && !bq && prev != '\\' => { sq = !sq; cur.push(ch); }
            '"' if !sq && !bq && prev != '\\' => { dq = !dq; cur.push(ch); }
            '`' if !sq && !dq => { bq = !bq; cur.push(ch); }
            ';' if !sq && !dq && !bq => {
                if !cur.trim().is_empty() { parts.push(cur.trim().to_string()); }
                cur.clear();
            }
            _ => cur.push(ch),
        }
        prev = ch;
    }
    if !cur.trim().is_empty() { parts.push(cur.trim().to_string()); }
    if parts.is_empty() { parts.push(sql.trim().to_string()); }
    parts
}

#[cfg(test)]
mod tier_tests {
    use super::*;

    #[test]
    fn classifies_core_verbs() {
        assert_eq!(classify_sql("SELECT * FROM users"), QueryTier::Read);
        assert_eq!(classify_sql("  show tables"), QueryTier::Read);
        assert_eq!(classify_sql("INSERT INTO t VALUES (1)"), QueryTier::Write);
        assert_eq!(classify_sql("UPDATE t SET a=1 WHERE id=2"), QueryTier::Write);
        assert_eq!(classify_sql("DELETE FROM t WHERE id=2"), QueryTier::Delete);
        assert_eq!(classify_sql("CREATE TABLE t (id int)"), QueryTier::Create);
        assert_eq!(classify_sql("CREATE INDEX i ON t(a)"), QueryTier::Create);
    }

    #[test]
    fn no_where_mutations_are_destructive() {
        assert_eq!(classify_sql("DELETE FROM t"), QueryTier::Destructive);
        assert_eq!(classify_sql("UPDATE t SET a=1"), QueryTier::Destructive);
        assert_eq!(classify_sql("DROP TABLE t"), QueryTier::Destructive);
        assert_eq!(classify_sql("TRUNCATE t"), QueryTier::Destructive);
        assert_eq!(classify_sql("ALTER TABLE t DROP COLUMN a"), QueryTier::Destructive);
    }

    #[test]
    fn subquery_where_does_not_save_a_bare_update() {
        // The only WHERE is inside the subquery → still destructive.
        assert_eq!(
            classify_sql("UPDATE t SET a=(SELECT x FROM y WHERE y.id=1)"),
            QueryTier::Destructive
        );
    }

    #[test]
    fn cte_fronted_delete_is_classified_by_real_verb() {
        assert_eq!(
            classify_sql("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT 1)"),
            QueryTier::Delete
        );
    }

    #[test]
    fn batch_takes_strongest_tier() {
        assert_eq!(classify_batch("SELECT 1; DROP TABLE x"), QueryTier::Destructive);
        assert_eq!(classify_batch("SELECT 1; INSERT INTO t VALUES (1)"), QueryTier::Write);
    }
}

/// Shape sent to the model as part of `tools: [...]`. Serde renames match
/// the OpenAI function-calling schema exactly.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub kind: &'static str, // always "function"
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolFunction {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

/// Catalog filtered for the current scope. When `cross_database` is false the
/// model is locked to the active database, so we DROP `list_schemas` entirely:
/// the active DB is already stated in the context, and exposing the tool only
/// invited weak models to loop-call it (and hit the loop-guard abort). With it
/// gone, the model can't enumerate or fixate on databases it can't reach.
pub fn catalog_scoped(cross_database: bool) -> Vec<ToolDef> {
    let mut tools = catalog_all();
    if !cross_database {
        tools.retain(|t| t.function.name != "list_schemas");
    }
    tools
}

fn catalog_all() -> Vec<ToolDef> {
    vec![
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "list_schemas",
                description: "List every database/schema on the current connection. Returns an array of schema names.",
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "required": []
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "list_tables",
                description: "List every table and view in a schema. Returns `{ name, kind }` entries.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name. If omitted, uses the active schema from the system context." }
                    },
                    "required": []
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "describe_table",
                description: "Get the full column list, primary key, indexes, and foreign keys for a specific table.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name. If omitted, uses the active schema." },
                        "table": { "type": "string", "description": "Table name." }
                    },
                    "required": ["table"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "call_query",
                description: "YOU execute this SQL against the live database and receive the rows back — this is how you actually run queries and get data. May require user approval (the user sees the SQL and approves or denies); with auto-approval granted it runs without prompting. Use whenever the task needs real data or a real change: SELECT / counts / samples, and INSERT/UPDATE/CREATE the user asked you to perform. This is the tool for getting an answer or doing the work. Keep queries single-statement and add LIMIT to SELECTs unless the user explicitly asked for everything.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "The SQL to execute. One statement. Prefer SELECT with LIMIT." }
                    },
                    "required": ["sql"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "write_query_tab",
                description: "Does NOT run anything — it only places SQL into the user's query editor for THEM to review and run manually. Use ONLY when the user explicitly wants the SQL in their editor (\"put it in a tab\", \"write/draft/scaffold this query\", \"open in editor\", or to tweak before running). REQUIRES USER APPROVAL (they see a diff). If the user wants an answer or wants the work actually done, use `call_query` instead — writing a tab leaves the query UNEXECUTED, so do not treat it as completing a data task.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "The SQL to write into the editor. Multi-statement OK; formatted nicely." },
                        "mode": {
                            "type": "string",
                            "enum": ["new", "replace"],
                            "description": "`new` to open a fresh query tab; `replace` to overwrite the content of the currently-focused query tab (falls back to `new` if no query tab is active)."
                        },
                        "title": { "type": "string", "description": "Optional tab title — defaults to a short snippet of the SQL." }
                    },
                    "required": ["sql", "mode"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "publish_notify",
                description: "Publish a realtime message to a pub/sub channel. Translates to Postgres `NOTIFY <channel>, '<payload>'` or Redis `PUBLISH <channel> <payload>` depending on the active adapter. REQUIRES USER APPROVAL before sending. Use when the user asks you to publish, notify, send, or trigger on a channel.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "channel": { "type": "string", "description": "Channel/topic name. Plain identifier on Postgres (no wildcards); any string on Redis." },
                        "payload": { "type": "string", "description": "Message body. Plain text or JSON-stringified. Keep under 8000 bytes on Postgres." }
                    },
                    "required": ["channel", "payload"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "subscribe_channel",
                description: "Start a realtime subscription on the user's realtime tab. Prefills the channel input and triggers the Start button. Postgres requires a literal channel name (no wildcards). Redis accepts globs like `foo.*` (runs PSUBSCRIBE) or plain names (runs SUBSCRIBE). REQUIRES USER APPROVAL. Use when the user asks you to subscribe, listen, watch, or monitor a channel.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "channel": { "type": "string", "description": "Channel name / Redis glob. On Postgres: literal identifier only." }
                    },
                    "required": ["channel"]
                }),
            },
        },
    ]
}

/// Context every tool call needs to reach the database.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub connection_id: String,
    pub default_schema: Option<String>,
}

/// Detect whether `sql` references a database OTHER than `active`. Catches the
/// two ways to escape the active DB in a MySQL-style dialect: an explicit
/// `USE otherdb`, and a qualified `otherdb.table` reference.
///
/// CRITICAL: a qualified `x.y` token is ambiguous — it can be `database.table`,
/// `table.column`, OR `alias.column`. We must NOT flag table/column/alias
/// references (those are normal same-DB SQL). So we only flag `x.` when `x`
/// matches an ACTUAL other database name in `known_databases`. Table aliases
/// like `films f` → `f.id` won't match a real database, so they pass through.
/// `known_databases` is the live `list_schemas` result; comparison is
/// case-insensitive and ignores backticks.
fn references_other_database(
    sql: &str,
    active: &str,
    known_databases: &[String],
) -> Option<String> {
    let active_norm = active.trim_matches('`').to_ascii_lowercase();
    // The set of OTHER database names we should block references to.
    let others: std::collections::HashSet<String> = known_databases
        .iter()
        .map(|d| d.trim_matches('`').to_ascii_lowercase())
        .filter(|d| *d != active_norm)
        .collect();

    // 1) `USE <db>` — binds the session to another database. Block any USE that
    // targets a real other database (not the active one).
    let upper = sql.trim_start().to_ascii_uppercase();
    if upper.starts_with("USE ") {
        let db = sql.trim_start()[4..]
            .trim()
            .trim_end_matches(';')
            .trim()
            .trim_matches('`')
            .to_ascii_lowercase();
        if others.contains(&db) {
            return Some(db);
        }
    }

    // 2) Qualified `db.table` references — but ONLY flag when the left
    // identifier is a known other database. Aliases and table-qualified columns
    // (`f.id`, `films.title`) won't be in `others`, so they're allowed.
    if others.is_empty() {
        return None;
    }
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        let is_ident_start = c.is_ascii_alphabetic() || c == '_' || c == '`';
        if !is_ident_start {
            i += 1;
            continue;
        }
        let start = i;
        if c == '`' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'`' {
                i += 1;
            }
            i += 1; // closing backtick
        } else {
            while i < bytes.len() {
                let ch = bytes[i] as char;
                if ch.is_ascii_alphanumeric() || ch == '_' {
                    i += 1;
                } else {
                    break;
                }
            }
        }
        if i < bytes.len() && bytes[i] == b'.' {
            let ident = sql[start..i].trim_matches('`').to_ascii_lowercase();
            if others.contains(&ident) {
                return Some(ident);
            }
        }
    }
    None
}

/// Result of a tool invocation. We always serialize to a string because
/// that's what the model sees as the `tool` message content.
pub struct ToolResult {
    pub content: String,
}

impl ToolResult {
    fn from_value(v: Value) -> Self {
        Self { content: v.to_string() }
    }
    fn error(msg: impl Into<String>) -> Self {
        Self {
            content: json!({ "error": msg.into() }).to_string(),
        }
    }
    /// A non-error result that carries a steering instruction back to the model
    /// (e.g. "you already have this — stop calling and proceed"). Not flagged as
    /// an error so the loop-guard's error path doesn't fire on it.
    pub fn directive(msg: impl Into<String>) -> Self {
        Self {
            content: json!({ "note": msg.into() }).to_string(),
        }
    }
}

/// Orchestrates approval for `call_sql`. A call from the provider's tool
/// loop registers a oneshot with a request id; the UI calls
/// `ai_approve_tool_call` which fulfils it. We time out after 5 minutes so
/// a never-answered approval can't hang the chat forever.
#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    /// User denied the tool call; the tool returns an error string to the
    /// model so it can adjust or apologise.
    Deny,
}

/// Per-tool auto-approval flags. When a flag is `true`, the dispatcher
/// skips the UI prompt and executes as if the user approved. Toggled
/// from the permissions drawer in the chat panel. Stateless across
/// restarts — we keep this in-memory so a granted permission expires at
/// the end of the app session, matching the user's expectation that
/// "allow this chat" is a temporary trust rather than a persistent ACL.
#[derive(Default, Debug)]
pub struct AutoApprovals {
    inner: Mutex<AutoApprovalFlags>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AutoApprovalFlags {
    /// Allow the model to list schemas / databases / tables without
    /// prompting. Defaults to `true` because schema shapes are safe —
    /// no rows ever leave the adapter through these tools.
    #[serde(default = "default_true")]
    pub read_schema: bool,
    /// Allow the model to fetch column/index/FK definitions via
    /// `describe_table`. Also shape-only.
    #[serde(default = "default_true")]
    pub read_structure: bool,
    /// Legacy master switch for `call_query`. Kept for back-compat with
    /// settings persisted before the per-tier split. When `true` it grants
    /// every non-destructive tier (read/write/create/delete) so old configs
    /// keep working; destructive statements still always prompt.
    #[serde(default)]
    pub call_query: bool,
    /// Per-operation auto-approval for `call_query`. Each tier is gated
    /// independently so the user can, e.g., let reads run silently while
    /// still being prompted before writes or schema changes. Destructive
    /// statements (no-WHERE DELETE/UPDATE, DROP, TRUNCATE) are NEVER
    /// auto-approvable and have no flag.
    #[serde(default)]
    pub call_query_read: bool,
    #[serde(default)]
    pub call_query_write: bool,
    #[serde(default)]
    pub call_query_create: bool,
    #[serde(default)]
    pub call_query_delete: bool,
    /// Allow the model to read/query databases OTHER than the one the user
    /// is currently focused on. Defaults to `false` — the AI is locked to the
    /// active database so it can't enumerate or touch the other (often dozens
    /// of) databases on the same server. When `false`, `list_schemas` returns
    /// only the active schema and `list_tables`/`describe_table`/`call_query`
    /// reject references to any other database.
    #[serde(default)]
    pub cross_database: bool,
    /// Allow `write_query_tab` to open / replace editor tabs.
    #[serde(default)]
    pub write_query_tab: bool,
    /// Allow `publish_notify` to send NOTIFY / PUBLISH.
    #[serde(default)]
    pub publish_notify: bool,
    /// Allow `subscribe_channel` to start LISTEN / SUBSCRIBE.
    #[serde(default)]
    pub subscribe_channel: bool,
}

fn default_true() -> bool { true }

impl Default for AutoApprovalFlags {
    fn default() -> Self {
        Self {
            read_schema: true,
            read_structure: true,
            call_query: false,
            call_query_read: false,
            call_query_write: false,
            call_query_create: false,
            call_query_delete: false,
            cross_database: false,
            write_query_tab: false,
            publish_notify: false,
            subscribe_channel: false,
        }
    }
}

impl AutoApprovals {
    pub async fn get(&self) -> AutoApprovalFlags {
        *self.inner.lock().await
    }

    pub async fn set(&self, flags: AutoApprovalFlags) {
        *self.inner.lock().await = flags;
    }

    /// Whether the model may reach databases other than the active one.
    async fn cross_database(&self) -> bool {
        self.inner.lock().await.cross_database
    }

    async fn allows(&self, tool: &str) -> bool {
        let f = *self.inner.lock().await;
        match tool {
            "list_schemas" | "list_tables" => f.read_schema,
            "describe_table" => f.read_structure,
            // `call_query` is gated per-tier via `allows_tier`, not here.
            "write_query_tab" => f.write_query_tab,
            "publish_notify" => f.publish_notify,
            "subscribe_channel" => f.subscribe_channel,
            _ => false,
        }
    }

    /// Per-tier gate for `call_query`. Destructive statements never auto-
    /// approve. The legacy `call_query` master grants every non-destructive
    /// tier so pre-split configs keep working.
    async fn allows_tier(&self, tier: QueryTier) -> bool {
        if tier == QueryTier::Destructive {
            return false;
        }
        let f = *self.inner.lock().await;
        if f.call_query {
            return true; // legacy master switch covers all non-destructive tiers
        }
        match tier {
            QueryTier::Read => f.call_query_read,
            QueryTier::Write => f.call_query_write,
            QueryTier::Create => f.call_query_create,
            QueryTier::Delete => f.call_query_delete,
            QueryTier::Destructive => false,
        }
    }
}

impl ApprovalRegistry {
    pub async fn wait(&self, id: &str) -> Result<ApprovalDecision, AiError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id.to_string(), tx);
        }
        // 5-minute cap — the UI banner is persistent so the user can reply
        // whenever, but we don't want to lock the tool loop forever.
        let deadline = tokio::time::timeout(Duration::from_secs(300), rx).await;
        // Always clean up the entry.
        {
            let mut guard = self.pending.lock().await;
            guard.remove(id);
        }
        match deadline {
            Ok(Ok(decision)) => Ok(decision),
            Ok(Err(_)) => Err(AiError::Other("approval channel closed".into())),
            Err(_) => Err(AiError::Other("approval timed out after 5 minutes".into())),
        }
    }

    pub async fn resolve(&self, id: &str, decision: ApprovalDecision) -> bool {
        let mut guard = self.pending.lock().await;
        if let Some(tx) = guard.remove(id) {
            let _ = tx.send(decision);
            true
        } else {
            false
        }
    }
}

/// Common approval path: if auto-approved for this tool, returns `Ok(())`.
/// Otherwise emits an approval_request for the UI and blocks on the user's
/// decision. Returns `Err(ToolResult)` when the user denies (or approval
/// fails) so the caller can short-circuit with that denial payload.
async fn require_approval(
    auto_approvals: &Arc<AutoApprovals>,
    approvals: &Arc<ApprovalRegistry>,
    app: &tauri::AppHandle,
    tool_call_id: &str,
    name: &str,
    preview: Value,
) -> Result<(), ToolResult> {
    if auto_approvals.allows(name).await {
        return Ok(());
    }
    use tauri::Emitter;
    let mut payload = match preview {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    payload.insert("tool_call_id".into(), json!(tool_call_id));
    payload.insert("name".into(), json!(name));
    let _ = app.emit("ai://tool/approval_request", Value::Object(payload));
    match approvals.wait(tool_call_id).await {
        Ok(ApprovalDecision::Approve) => Ok(()),
        Ok(ApprovalDecision::Deny) => Err(ToolResult::error(format!("user denied `{name}`"))),
        Err(e) => Err(ToolResult::error(format!("approval: {e}"))),
    }
}

/// Guard for shape tools (`list_tables`, `describe_table`): when cross-database
/// access is OFF, reject any `schema` that isn't the active one. Returns
/// `Some(error)` to short-circuit, `None` to proceed.
async fn guard_active_database(
    auto_approvals: &Arc<AutoApprovals>,
    ctx: &ToolContext,
    requested_schema: &str,
) -> Option<ToolResult> {
    if auto_approvals.cross_database().await {
        return None;
    }
    let active = ctx.default_schema.as_deref().unwrap_or_default();
    // No active schema set → nothing to scope against; allow.
    if active.is_empty() {
        return None;
    }
    if !requested_schema.eq_ignore_ascii_case(active) {
        return Some(ToolResult::error(format!(
            "Blocked: `{requested_schema}` is a different database. Cross-database access is disabled — \
             you are locked to the active database `{active}`. Ask the user to enable \
             \"Cross-database access\" in AI permissions to reach other databases."
        )));
    }
    None
}

/// Execute one tool call and return a stringified JSON result. `call_query`
/// waits on the approval registry before touching the database.
pub async fn dispatch(
    db_registry: &Arc<Registry>,
    approvals: &Arc<ApprovalRegistry>,
    auto_approvals: &Arc<AutoApprovals>,
    app: &tauri::AppHandle,
    ctx: &ToolContext,
    tool_call_id: &str,
    name: &str,
    arguments: &str,
) -> ToolResult {
    // Parse `arguments` as JSON up front — several tools share the parse.
    let args: Value = match serde_json::from_str(arguments) {
        Ok(v) => v,
        Err(_) if arguments.trim().is_empty() => json!({}),
        Err(e) => return ToolResult::error(format!("invalid JSON arguments: {e}")),
    };

    let adapter = match db_registry.get(&ctx.connection_id).await {
        Ok(d) => d,
        Err(e) => return ToolResult::error(format!("connection unavailable: {e}")),
    };

    match name {
        "list_schemas" => {
            // Hard backstop: when cross-database access is OFF, `list_schemas`
            // is removed from the catalog — but a weak model can replay the tool
            // name from earlier history or hallucinate it. Return a directive
            // ERROR (not a success) so the model stops re-calling and proceeds
            // with the active database it already knows. A successful result
            // here is what caused the 3×-loop-then-abort behaviour.
            if !auto_approvals.cross_database().await {
                let active = ctx.default_schema.clone().unwrap_or_default();
                let active_label = if active.is_empty() { "the active database".to_string() } else { format!("`{active}`") };
                return ToolResult::error(format!(
                    "`list_schemas` is disabled — cross-database access is OFF and you are already \
                     connected to {active_label}. Do NOT call this tool again. Proceed using \
                     {active_label}: call `describe_table` or `call_query` directly with bare table \
                     names. To work across databases, the user must enable \"Cross-database access\" \
                     in AI permissions."
                ));
            }
            if let Err(deny) = require_approval(
                auto_approvals,
                approvals,
                app,
                tool_call_id,
                name,
                json!({ "summary": "List every schema the current user can see." }),
            ).await {
                return deny;
            }
            match adapter.list_schemas().await {
                Ok(list) => {
                    let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
                    ToolResult::from_value(json!({ "schemas": names }))
                }
                Err(e) => ToolResult::error(format!("list_schemas failed: {e}")),
            }
        }
        "list_tables" => {
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| ctx.default_schema.clone())
                .unwrap_or_default();
            if schema.is_empty() {
                return ToolResult::error("schema is required (no active schema on this session)");
            }
            if let Some(err) = guard_active_database(auto_approvals, ctx, &schema).await {
                return err;
            }
            if let Err(deny) = require_approval(
                auto_approvals,
                approvals,
                app,
                tool_call_id,
                name,
                json!({ "summary": format!("List tables + views in schema `{schema}`.") }),
            ).await {
                return deny;
            }
            match adapter.list_schemas().await {
                Ok(list) => match list.iter().find(|s| s.name == schema) {
                    Some(s) => {
                        let tables: Vec<Value> = s
                            .tables
                            .iter()
                            .map(|t| json!({ "name": t.name, "kind": format!("{:?}", t.kind).to_lowercase() }))
                            .collect();
                        ToolResult::from_value(json!({ "schema": schema, "tables": tables }))
                    }
                    None => ToolResult::error(format!("schema `{schema}` not found")),
                },
                Err(e) => ToolResult::error(format!("list_tables failed: {e}")),
            }
        }
        "describe_table" => {
            let table = match args.get("table").and_then(|v| v.as_str()) {
                Some(t) => t.to_string(),
                None => return ToolResult::error("`table` argument is required"),
            };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| ctx.default_schema.clone())
                .unwrap_or_default();
            if schema.is_empty() {
                return ToolResult::error("schema is required (no active schema on this session)");
            }
            if let Some(err) = guard_active_database(auto_approvals, ctx, &schema).await {
                return err;
            }
            if let Err(deny) = require_approval(
                auto_approvals,
                approvals,
                app,
                tool_call_id,
                name,
                json!({ "summary": format!("Describe `{schema}.{table}` (columns, indexes, foreign keys).") }),
            ).await {
                return deny;
            }
            match adapter.describe_table(&schema, &table).await {
                Ok(ts) => {
                    // Slim the structure before returning it to the model —
                    // `TableStructure` carries charset/collation/extra/index-flags
                    // that are rarely useful for SQL reasoning and blow up the
                    // context by ~5-10x on wide tables. Keep name, type,
                    // nullable, PK status, and FK target only.
                    let columns: Vec<Value> = ts.columns.iter().map(|c| {
                        let mut obj = serde_json::Map::new();
                        obj.insert("name".into(), json!(c.name));
                        obj.insert("type".into(), json!(c.data_type));
                        if !c.nullable { obj.insert("notNull".into(), json!(true)); }
                        if c.is_primary { obj.insert("pk".into(), json!(true)); }
                        if let Some(def) = &c.default { obj.insert("default".into(), json!(def)); }
                        Value::Object(obj)
                    }).collect();
                    let foreign_keys: Vec<Value> = ts.foreign_keys.iter().map(|fk| {
                        json!({
                            "columns": fk.from_columns,
                            "refTable": fk.to_table,
                            "refColumns": fk.to_columns,
                        })
                    }).collect();
                    let indexes: Vec<Value> = ts.indexes.iter()
                        // Filter out the implicit PRIMARY index — it's redundant
                        // with the pk flag on columns.
                        .filter(|i| i.name != "PRIMARY")
                        .map(|i| json!({
                            "name": i.name,
                            "columns": i.columns,
                            "unique": i.unique,
                        })).collect();
                    ToolResult::from_value(json!({
                        "schema": ts.schema,
                        "table": ts.name,
                        "columns": columns,
                        "primaryKey": ts.primary_key,
                        "foreignKeys": foreign_keys,
                        "indexes": indexes,
                    }))
                }
                Err(e) => ToolResult::error(format!("describe_table failed: {e}")),
            }
        }
        "call_query" | "call_sql" | "run_query" => {
            let sql = match args.get("sql").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`sql` argument is required"),
            };
            if sql.is_empty() {
                return ToolResult::error("sql is empty");
            }

            // Lock to the active database unless cross-database access is granted.
            // We only block a qualified reference when the qualifier is a REAL
            // other database (from `list_schemas`) — never a table alias or a
            // table-qualified column, which share the same `x.y` syntax.
            if !auto_approvals.cross_database().await {
                if let Some(active) = ctx.default_schema.as_deref() {
                    let known: Vec<String> = adapter
                        .list_schemas()
                        .await
                        .map(|list| list.into_iter().map(|s| s.name).collect())
                        .unwrap_or_default();
                    if let Some(other) = references_other_database(&sql, active, &known) {
                        return ToolResult::error(format!(
                            "Blocked: query references database `{other}`, but cross-database access is disabled. \
                             You are locked to the active database `{active}`. Ask the user to enable \
                             \"Cross-database access\" in AI permissions to query other databases."
                        ));
                    }
                }
            }

            let started = Instant::now();
            // Classify the statement (batch = strongest tier) so we can gate
            // auto-approval per operation kind and badge the approval card.
            let tier = classify_batch(&sql);
            if auto_approvals.allows_tier(tier).await {
                crate::log_line!("ai_tool", "call_query auto-approved (tier={})", tier.label());
            } else {
                // Ask the UI for approval. Emit + wait with a shared timeout.
                use tauri::Emitter;
                let _ = app.emit(
                    "ai://tool/approval_request",
                    json!({
                        "tool_call_id": tool_call_id,
                        "name": name,
                        "sql": sql,
                        "tier": tier,
                    }),
                );
                match approvals.wait(tool_call_id).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!("ai_tool", "call_query approved (tier={}) after {:?}", tier.label(), started.elapsed());
                    }
                    Ok(ApprovalDecision::Deny) => {
                        return ToolResult::error("user denied the query");
                    }
                    Err(e) => return ToolResult::error(format!("approval: {e}")),
                }
            }

            // Don't auto-append a LIMIT to the AI's query. The model is
            // already instructed (via the system prompt) to add LIMIT to
            // SELECTs, and silently mutating its SQL has bitten us — most
            // recently producing `LIMIT N LIMIT N` when the user's query
            // ended with `\nLIMIT X`. We still cap the rows shipped back to
            // the model to 25 below, so context stays small even if the
            // query returns thousands of rows.
            // The `USE <schema>;` prefix is a MySQL-ism. Only MySQL has a `USE`
            // statement: Postgres/SQLite bind a connection to one database and
            // have no `USE`, and non-SQL stores (Mongo, Redis) would be
            // corrupted by it (`USE ...;\ndb.find()` no longer starts with
            // `db.`, which is what broke Mongo). So gate strictly on MySQL.
            let sql_dialect = db_registry
                .manifest(&ctx.connection_id)
                .await
                .map(|m| m.capabilities.sql_dialect)
                .unwrap_or(adapter_api::SqlDialect::None);
            let mut final_sql = sql.clone();
            if let Some(schema) = &ctx.default_schema {
                if matches!(sql_dialect, adapter_api::SqlDialect::Mysql)
                    && !sql.trim_start().to_ascii_uppercase().starts_with("USE ")
                {
                    final_sql = format!("USE `{schema}`;\n{sql}");
                }
            }
            match adapter.execute_raw(&final_sql, None).await {
                Ok(res) => {
                    // Emit a query-log event so the frontend can record this
                    let first = res.statements.first();
                    let (status, message, duration_ms) = match first {
                        Some(stmt) if stmt.error.is_none() => ("ok", None, stmt.duration_ms),
                        Some(stmt) => ("error", stmt.error.clone(), stmt.duration_ms),
                        None => ("error", Some("no statements".to_string()), 0.0),
                    };
                    use tauri::Emitter;
                    let _ = app.emit("ai://query_log", json!({
                        "connection_id": ctx.connection_id,
                        "statement": sql,
                        "source": "ai",
                        "duration_ms": duration_ms,
                        "status": status,
                        "message": message,
                    }));

                    // Compact representation — first statement's first 25 rows.
                    // Keeps the feedback to the model under a few KB even on
                    // wide tables.
                    let first = res.statements.first();
                    let summary = match first {
                        Some(stmt) if stmt.error.is_none() => {
                            let rows_shown = stmt.rows.iter().take(25).collect::<Vec<_>>();
                            let column_names: Vec<&str> = stmt.columns.iter().map(|c| c.name.as_str()).collect();
                            json!({
                                "columns": column_names,
                                "row_count_shown": rows_shown.len(),
                                "rows": rows_shown,
                                "truncated": stmt.rows.len() > rows_shown.len(),
                                "duration_ms": stmt.duration_ms,
                            })
                        }
                        Some(stmt) => json!({ "error": stmt.error.clone().unwrap_or_default() }),
                        None => json!({ "error": "no statements returned" }),
                    };
                    ToolResult::from_value(summary)
                }
                Err(e) => ToolResult::error(format!("call_query failed: {e}")),
            }
        }
        "write_query_tab" => {
            let sql = match args.get("sql").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`sql` argument is required"),
            };
            if sql.is_empty() {
                return ToolResult::error("sql is empty");
            }
            let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("new");
            if mode != "new" && mode != "replace" {
                return ToolResult::error("mode must be 'new' or 'replace'");
            }
            let title = args.get("title").and_then(|v| v.as_str()).map(str::to_string);

            use tauri::Emitter;
            let started = Instant::now();
            if auto_approvals.allows("write_query_tab").await {
                crate::log_line!(
                    "ai_tool",
                    "write_query_tab auto-approved (mode={mode})"
                );
            } else {
                // Reuse the existing approval UI — the tool name lets the
                // frontend render a tab-aware approval card instead of the
                // generic SQL-run one.
                let _ = app.emit(
                    "ai://tool/approval_request",
                    json!({
                        "tool_call_id": tool_call_id,
                        "name": name,
                        "sql": sql,
                        "mode": mode,
                        "title": title,
                    }),
                );
                match approvals.wait(tool_call_id).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!(
                            "ai_tool",
                            "write_query_tab approved after {:?} (mode={mode})",
                            started.elapsed()
                        );
                    }
                    Ok(ApprovalDecision::Deny) => {
                        return ToolResult::error("user declined the tab write");
                    }
                    Err(e) => return ToolResult::error(format!("approval: {e}")),
                }
            }

            // Hand the write over to the frontend. No DB round-trip — the
            // tabs state lives in React, so we emit an event and rely on
            // WorkspaceView to pick it up and mutate.
            let _ = app.emit(
                "ai://tab/write",
                json!({
                    "tool_call_id": tool_call_id,
                    "connection_id": ctx.connection_id,
                    "schema": ctx.default_schema,
                    "sql": sql,
                    "mode": mode,
                    "title": title,
                }),
            );
            ToolResult::from_value(json!({
                "ok": true,
                "mode": mode,
                "message": format!("Wrote SQL to a {mode} query tab."),
            }))
        }
        "publish_notify" => {
            let channel = match args.get("channel").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`channel` argument is required"),
            };
            if channel.is_empty() {
                return ToolResult::error("channel is empty");
            }
            let payload = args
                .get("payload")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Pick the adapter-native publish verb from the manifest's
            // `realtime_kind` — not the adapter key. Adding a new adapter
            // with pub/sub-style realtime needs only a manifest flag, not
            // a new arm here.
            let manifest = db_registry.manifest(&ctx.connection_id).await.ok();
            let realtime_kind = manifest
                .map(|m| m.capabilities.realtime_kind)
                .unwrap_or(adapter_api::RealtimeKind::None);
            let cmd = match realtime_kind {
                adapter_api::RealtimeKind::ListenNotify => {
                    let safe_channel = channel.replace('"', "\"\"");
                    let safe_payload = payload.replace('\'', "''");
                    format!("NOTIFY \"{safe_channel}\", '{safe_payload}'")
                }
                adapter_api::RealtimeKind::Pubsub => {
                    // Shell-style argv splitting with backslash-escaped quotes.
                    let escaped = payload.replace('\\', "\\\\").replace('"', "\\\"");
                    format!("PUBLISH {channel} \"{escaped}\"")
                }
                adapter_api::RealtimeKind::ChangeStream | adapter_api::RealtimeKind::None => {
                    return ToolResult::error(
                        "publish_notify not supported — adapter has no listen/notify or pubsub channel",
                    );
                }
            };

            use tauri::Emitter;
            let started = Instant::now();
            if auto_approvals.allows("publish_notify").await {
                crate::log_line!("ai_tool", "publish_notify auto-approved");
            } else {
                let _ = app.emit(
                    "ai://tool/approval_request",
                    json!({
                        "tool_call_id": tool_call_id,
                        "name": name,
                        "sql": cmd,
                        "channel": channel,
                        "payload": payload,
                    }),
                );
                match approvals.wait(tool_call_id).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!(
                            "ai_tool",
                            "publish_notify approved after {:?}",
                            started.elapsed()
                        );
                    }
                    Ok(ApprovalDecision::Deny) => {
                        return ToolResult::error("user denied the publish");
                    }
                    Err(e) => return ToolResult::error(format!("approval: {e}")),
                }
            }
            match adapter.execute_raw(&cmd, None).await {
                Ok(_) => ToolResult::from_value(json!({
                    "ok": true,
                    "channel": channel,
                    "payload_bytes": payload.len(),
                })),
                Err(e) => ToolResult::error(format!("publish_notify failed: {e}")),
            }
        }
        "subscribe_channel" => {
            let channel = match args.get("channel").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`channel` argument is required"),
            };
            if channel.is_empty() {
                return ToolResult::error("channel is empty");
            }
            // Adapters that don't support glob subscriptions reject
            // wildcards server-side; reject here too so the model gets a
            // useful error before approval instead of a stale denial.
            let manifest = db_registry.manifest(&ctx.connection_id).await.ok();
            let caps = manifest.map(|m| m.capabilities);
            let glob_supported = caps.map(|c| c.glob_subscriptions).unwrap_or(false);
            let realtime_kind = caps
                .map(|c| c.realtime_kind)
                .unwrap_or(adapter_api::RealtimeKind::None);
            let has_glob_chars = channel.chars().any(|c| c == '*' || c == '?' || c == '[');
            if has_glob_chars && !glob_supported {
                return ToolResult::error(
                    "Subscription channel cannot contain wildcards — this adapter only supports literal channels",
                );
            }

            // Build a human-friendly preview string for the approval card.
            // The verb depends on the adapter's realtime kind, not its id.
            let preview = match realtime_kind {
                adapter_api::RealtimeKind::ListenNotify => {
                    let safe = channel.replace('"', "\"\"");
                    format!("LISTEN \"{safe}\"")
                }
                adapter_api::RealtimeKind::Pubsub => {
                    format!("{} {channel}", if has_glob_chars { "PSUBSCRIBE" } else { "SUBSCRIBE" })
                }
                adapter_api::RealtimeKind::ChangeStream => format!("WATCH {channel}"),
                adapter_api::RealtimeKind::None => format!("SUBSCRIBE {channel}"),
            };

            use tauri::Emitter;
            let started = Instant::now();
            if auto_approvals.allows("subscribe_channel").await {
                crate::log_line!("ai_tool", "subscribe_channel auto-approved");
            } else {
                let _ = app.emit(
                    "ai://tool/approval_request",
                    json!({
                        "tool_call_id": tool_call_id,
                        "name": name,
                        "sql": preview,
                        "channel": channel,
                    }),
                );
                match approvals.wait(tool_call_id).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!(
                            "ai_tool",
                            "subscribe_channel approved after {:?}",
                            started.elapsed()
                        );
                    }
                    Ok(ApprovalDecision::Deny) => {
                        return ToolResult::error("user denied the subscribe");
                    }
                    Err(e) => return ToolResult::error(format!("approval: {e}")),
                }
            }

            // Subscriptions are stateful and belong to the RealtimeView, not
            // to the tool dispatcher. Hand the channel over via an event so
            // the frontend prefills + starts the subscription on the user's
            // behalf. The tool result tells the model that the UI has been
            // nudged — it should not expect a stream of events back.
            let _ = app.emit(
                "ai://realtime/subscribe",
                json!({
                    "tool_call_id": tool_call_id,
                    "connection_id": ctx.connection_id,
                    "channel": channel,
                }),
            );
            ToolResult::from_value(json!({
                "ok": true,
                "channel": channel,
                "message": "Subscription start requested on the realtime tab. Received events stream into that tab's list; they are not returned to this chat.",
            }))
        }
        other => ToolResult::error(format!("unknown tool: {other}")),
    }
}
