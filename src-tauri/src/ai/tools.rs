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

/// Static catalog of every tool we expose. Callers pass this verbatim to
/// the provider.
pub fn catalog() -> Vec<ToolDef> {
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
                description: "Execute a SQL statement against the active database connection. May require user approval (the user sees the SQL and approves or denies) — when the user has granted auto-approval for queries via the permissions panel, the tool runs without prompting. Use whenever you need real data to answer the question (SELECT / counts / samples). Keep queries single-statement and add LIMIT to SELECTs unless the user explicitly asked for everything.",
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
                description: "Put SQL into the user's query editor — either as a new tab or by replacing the current query tab's content. REQUIRES USER APPROVAL before writing — the user sees a diff of the change and accepts or rejects. Use this when the user asks you to scaffold, refactor, or rewrite a query. Don't use this to *run* SQL — use `call_sql` for that.",
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
    /// Allow `call_query` to execute SQL. OFF by default because this
    /// reads real rows and can include mutations if the user typed one.
    #[serde(default)]
    pub call_query: bool,
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

    async fn allows(&self, tool: &str) -> bool {
        let f = *self.inner.lock().await;
        match tool {
            "list_schemas" | "list_tables" => f.read_schema,
            "describe_table" => f.read_structure,
            // Accept both the new name and the legacy alias so existing
            // provider loops that still emit `run_query` don't diverge
            // from the rename during the transition.
            "call_query" | "call_sql" | "run_query" => f.call_query,
            "write_query_tab" => f.write_query_tab,
            "publish_notify" => f.publish_notify,
            "subscribe_channel" => f.subscribe_channel,
            _ => false,
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

            let started = Instant::now();
            if auto_approvals.allows("call_query").await {
                crate::log_line!("ai_tool", "call_query auto-approved");
            } else {
                // Ask the UI for approval. Emit + wait with a shared timeout.
                use tauri::Emitter;
                let _ = app.emit(
                    "ai://tool/approval_request",
                    json!({
                        "tool_call_id": tool_call_id,
                        "name": name,
                        "sql": sql,
                    }),
                );
                match approvals.wait(tool_call_id).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!("ai_tool", "call_query approved after {:?}", started.elapsed());
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
            match adapter.execute_raw(&sql, None).await {
                Ok(res) => {
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
