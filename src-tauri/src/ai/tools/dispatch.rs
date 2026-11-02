//! The Rust-side dispatcher that executes a single tool call, plus the
//! result wrapper, per-call context, and the cross-database guard helpers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use adapter_api::SqlDialect;
use serde_json::{json, Value};

use crate::ai::cancel::CancelToken;
use crate::ai::AiError;
use crate::db::registry::Registry;

use super::approval::{ApprovalDecision, ApprovalRegistry, AutoApprovals};
use super::tiers::{classify_batch, CommandLanguage, QueryTier};

/// Context every tool call needs to reach the database.
#[derive(Clone, Default)]
pub struct ToolContext {
    pub connection_id: String,
    pub default_schema: Option<String>,
    /// The chat turn this call belongs to. Sent with approval cards so the UI
    /// can tie a card to its turn and retire it when that turn is stopped.
    pub request_id: Option<String>,
    /// Tripped when the user stops the turn; approval waits end immediately.
    pub cancel: Option<CancelToken>,
}

/// Longest an AI-issued query may run before the tool gives up and tells the
/// model. A lock wait or runaway query used to hang the whole turn — and the
/// session's send lock — indefinitely.
const QUERY_TIMEOUT: Duration = Duration::from_secs(120);

/// Rows of a result shown to the model, and limits that keep one result from
/// flooding its context: a 100 KB TEXT cell in 25 rows used to become a
/// 2.7 MB tool message, re-sent on every later turn (a small local model's
/// whole context window, many times over).
const MAX_ROWS_SHOWN: usize = 25;
const MAX_CELL_CHARS: usize = 500;
const MAX_RESULT_BYTES: usize = 12_000;

/// Detect whether `sql` references a database OTHER than `active`. Catches the
/// two ways to escape the active DB in a MySQL-style dialect: an explicit
/// `USE otherdb` (in any statement of the batch, after any comments), and a
/// qualified `otherdb.table` reference.
///
/// CRITICAL: a qualified `x.y` token is ambiguous — it can be `database.table`,
/// `table.column`, OR `alias.column`. We must NOT flag table/column/alias
/// references (those are normal same-DB SQL). So we only flag `x.` when `x`
/// matches an ACTUAL other database name in `known_databases`. Table aliases
/// like `films f` → `f.id` won't match a real database, so they pass through.
/// `known_databases` is the live `list_schemas` result; comparison is
/// case-insensitive and ignores backticks. Text inside string literals and
/// comments (`'x@otherdb.com'`, `-- see otherdb.t`) is never looked at.
fn references_other_database(
    sql: &str,
    dialect: SqlDialect,
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
    if others.is_empty() {
        return None;
    }

    // Identifier tokens of the code (string contents and comments blanked,
    // quoted identifiers kept), each with whether a `.` follows it.
    let identifiers = |code: &str| -> Vec<(String, bool)> {
        let bytes = code.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            let start = i;
            if c == b'`' || c == b'"' {
                i += 1;
                while i < bytes.len() && bytes[i] != c {
                    i += 1;
                }
                i = (i + 1).min(bytes.len());
            } else if c.is_ascii_alphabetic() || c == b'_' {
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$') {
                    i += 1;
                }
            } else {
                i += 1;
                continue;
            }
            let ident = code[start..i].trim_matches(|ch| ch == '`' || ch == '"').to_ascii_lowercase();
            out.push((ident, bytes.get(i) == Some(&b'.')));
        }
        out
    };

    for stmt in adapter_api::split_sql_statements(sql, dialect) {
        let code = adapter_api::mask_strings_and_comments(&stmt, dialect);
        let idents = identifiers(&code);
        // 1) `USE <db>` binds the session to another database.
        if adapter_api::leading_keyword(&stmt, dialect) == "USE" {
            if let Some((db, _)) = idents.iter().skip_while(|(w, _)| w != "use").nth(1) {
                if others.contains(db) {
                    return Some(db.clone());
                }
            }
        }
        // 2) Qualified `db.table` references — ONLY when the left identifier is
        // a known other database. Aliases and table-qualified columns
        // (`f.id`, `films.title`) won't be in `others`, so they're allowed.
        if let Some((db, _)) = idents.iter().find(|(w, dotted)| *dotted && others.contains(w)) {
            return Some(db.clone());
        }
    }
    None
}

/// Shape a query's result for the model: what ran, what it did, and a capped
/// sample of rows — saying plainly when something was cut so the model never
/// mistakes "25 shown" for "25 exist". `skip_first` drops the `USE <schema>;`
/// the dispatcher prepended for MySQL.
fn shape_query_result(statements: &[adapter_api::StatementResult], skip_first: bool) -> ToolResult {
    // Hide our own `USE` unless it is what failed.
    let statements = if skip_first && statements.len() > 1 && statements[0].error.is_none() {
        &statements[1..]
    } else {
        statements
    };
    let Some(last) = statements.last() else {
        return ToolResult::error("no statements returned");
    };

    let summary = |s: &adapter_api::StatementResult| -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("sql".into(), json!(crate::ai::clip_str(s.sql.trim(), 200)));
        match &s.error {
            Some(e) => {
                obj.insert("status".into(), json!("error"));
                obj.insert("error".into(), json!(e));
            }
            None => {
                obj.insert("status".into(), json!("ok"));
                if let Some(n) = s.rows_affected {
                    obj.insert("rows_affected".into(), json!(n));
                }
                if !s.columns.is_empty() {
                    obj.insert("rows_returned".into(), json!(s.rows.len()));
                }
            }
        }
        Value::Object(obj)
    };

    // A batch keeps going after an error, so the model must learn what
    // succeeded too — reporting only the error made it re-run statements
    // that had already committed.
    if let Some(failed) = statements.iter().position(|s| s.error.is_some()) {
        let err = statements[failed].error.clone().unwrap_or_default();
        if statements.len() == 1 {
            return ToolResult::error(err);
        }
        return ToolResult {
            content: json!({
                "error": format!("statement {} of {} failed: {err}", failed + 1, statements.len()),
                "statements": statements.iter().map(summary).collect::<Vec<_>>(),
            })
            .to_string(),
            is_error: true,
        };
    }

    let mut out = serde_json::Map::new();
    if statements.len() > 1 {
        out.insert("statements".into(), json!(statements.iter().map(summary).collect::<Vec<_>>()));
    }
    out.insert("ok".into(), json!(true));
    if last.columns.is_empty() && last.rows.is_empty() {
        // DML / DDL: no result set, just its effect.
        if let Some(n) = last.rows_affected {
            out.insert("rows_affected".into(), json!(n));
        }
    } else {
        let rows: Vec<Value> = last
            .rows
            .iter()
            .take(MAX_ROWS_SHOWN)
            .map(|r| Value::Array(r.iter().map(clip_cell).collect()))
            .collect();
        out.insert("columns".into(), json!(last.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>()));
        out.insert("row_count".into(), json!(last.rows.len()));
        // The adapter stops at its own row cap; more rows exist on the server.
        if last.truncated {
            out.insert("row_count_is_capped".into(), json!(true));
        }
        out.insert("rows_shown".into(), json!(rows.len()));
        out.insert("rows".into(), Value::Array(rows));
    }
    out.insert("duration_ms".into(), json!(last.duration_ms));

    // Keep the whole message bounded: drop trailing rows until it fits.
    let mut value = Value::Object(out);
    while value.to_string().len() > MAX_RESULT_BYTES {
        let Some(rows) = value.get_mut("rows").and_then(Value::as_array_mut) else { break };
        if rows.len() <= 1 {
            break;
        }
        rows.pop();
        let shown = rows.len();
        value["rows_shown"] = json!(shown);
        value["rows_omitted_for_size"] = json!(true);
    }
    ToolResult::from_value(value)
}

/// A result cell, cut down when it's long text or a large document.
fn clip_cell(v: &Value) -> Value {
    match v {
        Value::String(s) if s.chars().count() > MAX_CELL_CHARS => {
            let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
            json!(format!("{cut}…(+{} chars)", s.chars().count() - MAX_CELL_CHARS))
        }
        Value::Array(_) | Value::Object(_) => {
            let text = v.to_string();
            if text.chars().count() > MAX_CELL_CHARS {
                let cut: String = text.chars().take(MAX_CELL_CHARS).collect();
                json!(format!("{cut}…(+{} chars)", text.chars().count() - MAX_CELL_CHARS))
            } else {
                v.clone()
            }
        }
        _ => v.clone(),
    }
}

/// Choose which statement in a (possibly multi-statement) batch is the one whose
/// result we report to the model + UI.
///
/// For MySQL we auto-prepend `USE <schema>;`, so a batch is `[USE, <query>]`.
/// The `USE` returns 0 rows / 0 columns; reporting the FIRST statement therefore
/// made every query look empty (a `SELECT COUNT(*)` read as "0 rows", so the
/// model declared non-empty tables empty). Rule: the first errored statement
/// wins (surface the failure); otherwise the LAST statement is the real result.
fn select_result_statement(
    statements: &[adapter_api::StatementResult],
) -> Option<&adapter_api::StatementResult> {
    statements
        .iter()
        .find(|s| s.error.is_some())
        .or_else(|| statements.last())
}

/// Result of a tool invocation. We always serialize to a string because
/// that's what the model sees as the `tool` message content.
pub struct ToolResult {
    pub content: String,
    /// Whether this result represents a failure. Set explicitly by the
    /// constructors — callers MUST read this instead of substring-scanning
    /// `content` for `"error"`, which false-positives on legitimate result rows
    /// that merely contain the word "error" (e.g. a status column, a log table).
    pub is_error: bool,
}

impl ToolResult {
    fn from_value(v: Value) -> Self {
        Self { content: v.to_string(), is_error: false }
    }
    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            content: json!({ "error": msg.into() }).to_string(),
            is_error: true,
        }
    }
    /// A non-error result that carries a steering instruction back to the model
    /// (e.g. "you already have this — stop calling and proceed"). Not flagged as
    /// an error so the loop-guard's error path doesn't fire on it.
    pub fn directive(msg: impl Into<String>) -> Self {
        Self {
            content: json!({ "note": msg.into() }).to_string(),
            is_error: false,
        }
    }
}

/// Show an approval card and wait for the user's answer. The card carries the
/// turn's request id so the UI can tie it to its bubble and retire it if that
/// turn is stopped; a stopped turn also stops waiting right away.
async fn ask_user(
    approvals: &Arc<ApprovalRegistry>,
    app: &tauri::AppHandle,
    ctx: &ToolContext,
    tool_call_id: &str,
    mut payload: Value,
) -> Result<ApprovalDecision, AiError> {
    use tauri::Emitter;
    if let (Some(obj), Some(request_id)) = (payload.as_object_mut(), ctx.request_id.as_ref()) {
        obj.insert("request_id".into(), json!(request_id));
    }
    let _ = app.emit("ai://tool/approval_request", payload);
    approvals.wait(tool_call_id, ctx.cancel.as_ref()).await
}

/// Common approval path: if auto-approved for this tool, returns `Ok(())`.
/// Otherwise emits an approval_request for the UI and blocks on the user's
/// decision. Returns `Err(ToolResult)` when the user denies (or approval
/// fails) so the caller can short-circuit with that denial payload.
async fn require_approval(
    auto_approvals: &Arc<AutoApprovals>,
    approvals: &Arc<ApprovalRegistry>,
    app: &tauri::AppHandle,
    ctx: &ToolContext,
    tool_call_id: &str,
    name: &str,
    preview: Value,
) -> Result<(), ToolResult> {
    if auto_approvals.allows(name).await {
        return Ok(());
    }
    let mut payload = match preview {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    payload.insert("tool_call_id".into(), json!(tool_call_id));
    payload.insert("name".into(), json!(name));
    match ask_user(approvals, app, ctx, tool_call_id, Value::Object(payload)).await {
        Ok(ApprovalDecision::Approve) => Ok(()),
        Ok(ApprovalDecision::Deny) => Err(ToolResult::error(format!("user denied `{name}`"))),
        Err(e) => Err(ToolResult::error(format!("approval: {e}"))),
    }
}

/// Guard for shape tools (`list_tables`, `describe_table`): when cross-database
/// access is OFF, reject any `schema` that isn't the active one. Returns
/// `Some(error)` to short-circuit, `None` to proceed.
///
/// IMPORTANT dialect distinction: on MySQL/SQLite "schema" == "database", so a
/// schema other than the active one really is a different database and should be
/// blocked. On Postgres a single database contains MANY schemas (public,
/// netflix, …) — they all belong to the connected database, and a PG connection
/// can't even query across databases. So for adapters where the database is a
/// top-level object distinct from schemas (`database_picker`), we must NOT treat
/// a sibling schema as a "different database" — that wrongly locked the AI out
/// of every schema in its own active database.
async fn guard_active_database(
    auto_approvals: &Arc<AutoApprovals>,
    database_is_distinct_from_schema: bool,
    ctx: &ToolContext,
    requested_schema: &str,
) -> Option<ToolResult> {
    if auto_approvals.cross_database().await {
        return None;
    }
    // Postgres-style adapters: schemas are inside the one connected database,
    // not separate databases. Cross-database scoping is meaningless per
    // connection (switching DB rebuilds the connection), so don't block by
    // schema here — every schema the adapter exposes is in the active DB.
    if database_is_distinct_from_schema {
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

    // Whether this adapter models the database as a top-level object distinct
    // from schemas (Postgres: one DB, many schemas — `public`, `netflix`, …).
    // Drives cross-database guards: for these, sibling schemas are NOT "other
    // databases". MySQL/SQLite treat schema == database (a different schema IS
    // a different database), so the guard must still fire there.
    //
    // NOTE: we key off `sql_dialect == Postgres`, NOT `database_picker` —
    // MySQL also sets `database_picker: true` (it shows a DB picker), but on
    // MySQL schema and database are the same thing.
    let manifest = db_registry.manifest(&ctx.connection_id).await.ok();
    let sql_dialect = manifest
        .as_ref()
        .map(|m| m.capabilities.sql_dialect)
        .unwrap_or(SqlDialect::None);
    let database_is_distinct_from_schema = matches!(sql_dialect, SqlDialect::Postgres);
    // What `call_query` commands are written in, for approval tiers.
    let command_language = match (sql_dialect, manifest.as_ref().map(|m| m.adapter.key)) {
        (SqlDialect::None, Some("mongo")) => CommandLanguage::Mongo,
        (SqlDialect::None, Some("redis")) => CommandLanguage::Redis,
        (SqlDialect::None, _) => CommandLanguage::Unknown,
        (dialect, _) => CommandLanguage::Sql(dialect),
    };

    match name {
        "list_schemas" => {
            // Cross-database gate — but ONLY for adapters where schema ==
            // database (MySQL/SQLite). There, `list_schemas` enumerates other
            // databases, so blocking it when cross-DB is OFF is correct.
            //
            // On Postgres-style adapters (one database, many schemas:
            // `public`, `netflix`, …) listing schemas is SAME-database
            // introspection — the schemas all live in the connected DB and a
            // PG connection can't reach others anyway. Blocking it there
            // locked the model out of its own database's structure, leaving it
            // to guess (`WHERE table_catalog = 'Apps'` → 0 rows → loop). So we
            // allow `list_schemas` on those adapters regardless of the flag.
            if !database_is_distinct_from_schema && !auto_approvals.cross_database().await {
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
                ctx,
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
            if let Some(err) = guard_active_database(
                auto_approvals,
                database_is_distinct_from_schema,
                ctx,
                &schema,
            )
            .await
            {
                return err;
            }
            if let Err(deny) = require_approval(
                auto_approvals,
                approvals,
                app,
                ctx,
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
            if let Some(err) = guard_active_database(
                auto_approvals,
                database_is_distinct_from_schema,
                ctx,
                &schema,
            )
            .await
            {
                return err;
            }
            if let Err(deny) = require_approval(
                auto_approvals,
                approvals,
                app,
                ctx,
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
                None => return ToolResult::error("`query` argument is required"),
            };
            if sql.is_empty() {
                return ToolResult::error("query is empty");
            }

            // Lock to the active database unless cross-database access is granted.
            // We only block a qualified reference when the qualifier is a REAL
            // other database (from `list_schemas`) — never a table alias or a
            // table-qualified column, which share the same `x.y` syntax.
            //
            // Skipped entirely for Postgres-style adapters (`database_picker`):
            // there `list_schemas` returns schemas WITHIN the one connected
            // database (public, netflix, …), so `schema.table` references are
            // same-database and must not be flagged as cross-database. A real
            // cross-database query isn't even possible on a single PG connection.
            if !auto_approvals.cross_database().await && !database_is_distinct_from_schema {
                if let Some(active) = ctx.default_schema.as_deref() {
                    let known: Vec<String> = adapter
                        .list_schemas()
                        .await
                        .map(|list| list.into_iter().map(|s| s.name).collect())
                        .unwrap_or_default();
                    if let Some(other) = references_other_database(&sql, sql_dialect, active, &known) {
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
            let tier = classify_batch(&sql, command_language);
            if auto_approvals.allows_tier(tier).await {
                crate::log_line!("ai_tool", "call_query auto-approved (tier={})", tier.label());
            } else {
                // Ask the UI for approval.
                let card = json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "sql": sql,
                    "tier": tier,
                });
                match ask_user(approvals, app, ctx, tool_call_id, card).await {
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
            let mut final_sql = sql.clone();
            let mut prepended_use = false;
            if let Some(schema) = &ctx.default_schema {
                if matches!(sql_dialect, SqlDialect::Mysql)
                    && adapter_api::leading_keyword(&sql, sql_dialect) != "USE"
                {
                    final_sql = format!("USE `{}`;\n{sql}", schema.replace('`', "``"));
                    prepended_use = true;
                }
            }
            // DDL may commit even if this call is stopped or times out before
            // it returns, so mark the cached schema stale up front too.
            if matches!(tier, QueryTier::Create | QueryTier::Destructive) {
                crate::ai::context::note_schema_change();
            }
            let outcome = match tokio::time::timeout(QUERY_TIMEOUT, adapter.execute_raw(&final_sql, None)).await {
                Ok(r) => r,
                Err(_) => {
                    return ToolResult::error(format!(
                        "query did not finish within {}s and was abandoned (it may still be running on the \
                         server, e.g. waiting on a lock). Use a narrower query or ask the user to run it.",
                        QUERY_TIMEOUT.as_secs()
                    ));
                }
            };
            match outcome {
                Ok(res) => {
                    // Pick the statement whose result we report to the model.
                    //
                    // CRITICAL: for MySQL we auto-prepend `USE <schema>;` (see
                    // above), so the batch is `[USE, <real query>]`. The `USE`
                    // statement returns 0 rows / 0 columns. Reporting
                    // `statements.first()` therefore handed the model an EMPTY
                    // result for EVERY query — e.g. `SELECT COUNT(*)` looked like
                    // "0 rows", so the model said the table was empty even though
                    // it has thousands of rows.
                    //
                    // The meaningful result is the LAST statement (the user's
                    // query). But if ANY statement errored, surface that error
                    // (the `USE` could fail, or the query could). So: first error
                    // wins; otherwise the last statement is the result.
                    let result_stmt = select_result_statement(&res.statements);

                    // Emit a query-log event so the frontend can record this.
                    use tauri::Emitter;
                    let (status, message, duration_ms) = match result_stmt {
                        Some(stmt) if stmt.error.is_none() => ("ok", None, stmt.duration_ms),
                        Some(stmt) => ("error", stmt.error.clone(), stmt.duration_ms),
                        None => ("error", Some("no statements".to_string()), 0.0),
                    };
                    let _ = app.emit("ai://query_log", json!({
                        "connection_id": ctx.connection_id,
                        "statement": sql,
                        "source": "ai",
                        "duration_ms": duration_ms,
                        "status": status,
                        "message": message,
                    }));

                    // DDL makes the cached schema context stale — rebuild it
                    // before the next turn so a table the AI just created is
                    // listed (and a dropped one isn't).
                    if matches!(tier, QueryTier::Create | QueryTier::Destructive)
                        && res.statements.iter().any(|s| s.error.is_none())
                    {
                        crate::ai::context::note_schema_change();
                    }

                    // Compact, bounded representation of what ran and what came
                    // back (see `shape_query_result`).
                    shape_query_result(&res.statements, prepended_use)
                }
                Err(e) => ToolResult::error(format!("call_query failed: {e}")),
            }
        }
        "write_query_tab" => {
            let sql = match args.get("sql").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`query` argument is required"),
            };
            if sql.is_empty() {
                return ToolResult::error("query is empty");
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
                let card = json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "sql": sql,
                    "mode": mode,
                    "title": title,
                });
                match ask_user(approvals, app, ctx, tool_call_id, card).await {
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
        "open_object_tab" => {
            let object = match args.get("object").and_then(|v| v.as_str()) {
                Some(s) => s.trim().to_string(),
                None => return ToolResult::error("`object` argument is required"),
            };
            if object != "trigger" && object != "table" {
                return ToolResult::error("object must be 'trigger' or 'table'");
            }
            // Optional fields. `name` omitted => blank new-object editor.
            let obj_name = args
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let req_schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let prefill_sql = args
                .get("sql")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let schema = req_schema
                .or_else(|| ctx.default_schema.clone())
                .unwrap_or_default();

            use tauri::Emitter;
            let started = Instant::now();
            if auto_approvals.allows("open_object_tab").await {
                crate::log_line!(
                    "ai_tool",
                    "open_object_tab auto-approved (object={object})"
                );
            } else {
                let card = json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "object": object,
                    "objectName": obj_name,
                    "schema": schema,
                    "sql": prefill_sql,
                });
                match ask_user(approvals, app, ctx, tool_call_id, card).await {
                    Ok(ApprovalDecision::Approve) => {
                        crate::log_line!(
                            "ai_tool",
                            "open_object_tab approved after {:?} (object={object})",
                            started.elapsed()
                        );
                    }
                    Ok(ApprovalDecision::Deny) => {
                        return ToolResult::error("user declined opening the editor tab");
                    }
                    Err(e) => return ToolResult::error(format!("approval: {e}")),
                }
            }

            // The tabs state lives in React — emit and let WorkspaceView open
            // the dedicated trigger / table editor tab.
            let _ = app.emit(
                "ai://tab/open-object",
                json!({
                    "tool_call_id": tool_call_id,
                    "connection_id": ctx.connection_id,
                    "object": object,
                    "name": obj_name,
                    "schema": schema,
                    "sql": prefill_sql,
                }),
            );
            ToolResult::from_value(json!({
                "ok": true,
                "object": object,
                "message": format!("Opened a {object} editor tab for the user to review and save."),
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

            let started = Instant::now();
            if auto_approvals.allows("publish_notify").await {
                crate::log_line!("ai_tool", "publish_notify auto-approved");
            } else {
                let card = json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "sql": cmd,
                    "channel": channel,
                    "payload": payload,
                });
                match ask_user(approvals, app, ctx, tool_call_id, card).await {
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
                let card = json!({
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "sql": preview,
                    "channel": channel,
                });
                match ask_user(approvals, app, ctx, tool_call_id, card).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use adapter_api::StatementResult;

    fn stmt(sql: &str, rows: usize, cols: usize, error: Option<&str>) -> StatementResult {
        StatementResult {
            sql: sql.into(),
            duration_ms: 1.0,
            columns: (0..cols)
                .map(|i| adapter_api::ColumnMeta {
                    name: format!("c{i}"),
                    type_hint: "int".into(),
                })
                .collect(),
            rows: (0..rows).map(|_| vec![json!(1)]).collect(),
            rows_affected: None,
            error: error.map(String::from),
            truncated: false,
        }
    }

    #[test]
    fn picks_last_statement_skipping_use_prefix() {
        // The exact MySQL bug: `[USE (0 rows), SELECT COUNT(*) (1 row)]`.
        // Reporting the first statement made COUNT look empty.
        let batch = vec![
            stmt("USE `db`", 0, 0, None),
            stmt("SELECT COUNT(*) FROM actors", 1, 1, None),
        ];
        let chosen = select_result_statement(&batch).unwrap();
        assert_eq!(chosen.sql, "SELECT COUNT(*) FROM actors");
        assert_eq!(chosen.rows.len(), 1);
    }

    #[test]
    fn errored_statement_wins_over_last() {
        // If the USE fails, surface that error rather than the (empty) last stmt.
        let batch = vec![
            stmt("USE `nope`", 0, 0, Some("Unknown database 'nope'")),
            stmt("SELECT 1", 0, 0, None),
        ];
        let chosen = select_result_statement(&batch).unwrap();
        assert_eq!(chosen.error.as_deref(), Some("Unknown database 'nope'"));
    }

    #[test]
    fn single_statement_is_returned_as_is() {
        let batch = vec![stmt("SELECT * FROM actors LIMIT 5", 5, 6, None)];
        let chosen = select_result_statement(&batch).unwrap();
        assert_eq!(chosen.rows.len(), 5);
    }

    #[test]
    fn empty_batch_is_none() {
        assert!(select_result_statement(&[]).is_none());
    }

    fn parse(r: &ToolResult) -> Value {
        serde_json::from_str(&r.content).unwrap()
    }

    #[test]
    fn writes_report_rows_affected() {
        let mut upd = stmt("UPDATE t SET a = 1 WHERE b = 2", 0, 0, None);
        upd.rows_affected = Some(500);
        let r = shape_query_result(&[stmt("USE `db`", 0, 0, None), upd], true);
        let v = parse(&r);
        assert!(!r.is_error);
        assert_eq!(v["rows_affected"], json!(500));
        assert!(v.get("statements").is_none(), "our USE prefix is hidden");
    }

    #[test]
    fn partial_batch_failure_says_what_already_ran() {
        let mut del = stmt("DELETE FROM t WHERE x < 5", 0, 0, None);
        del.rows_affected = Some(120);
        let batch = vec![del, stmt("INSERT INTO t VALUES (1)", 0, 0, Some("Duplicate entry '1'")), stmt("SELECT 1", 1, 1, None)];
        let r = shape_query_result(&batch, false);
        let v = parse(&r);
        assert!(r.is_error);
        assert!(v["error"].as_str().unwrap().starts_with("statement 2 of 3 failed"));
        assert_eq!(v["statements"][0]["rows_affected"], json!(120));
        assert_eq!(v["statements"][2]["status"], json!("ok"));
    }

    #[test]
    fn failed_use_prefix_is_reported() {
        let batch = vec![stmt("USE `nope`", 0, 0, Some("Unknown database 'nope'")), stmt("SELECT 1", 0, 0, Some("No database selected"))];
        let r = shape_query_result(&batch, true);
        assert!(r.is_error);
        assert!(r.content.contains("Unknown database"));
    }

    #[test]
    fn results_say_when_rows_were_cut() {
        let mut s = stmt("SELECT * FROM big", 10_000, 1, None);
        s.truncated = true;
        let v = parse(&shape_query_result(&[s], false));
        assert_eq!(v["row_count"], json!(10_000));
        assert_eq!(v["row_count_is_capped"], json!(true));
        assert_eq!(v["rows_shown"], json!(25));
    }

    #[test]
    fn huge_cells_and_results_are_bounded() {
        let mut s = stmt("SELECT body FROM docs", 25, 1, None);
        for row in s.rows.iter_mut() {
            row[0] = json!("x".repeat(108_000));
        }
        let r = shape_query_result(&[s], false);
        assert!(r.content.len() <= MAX_RESULT_BYTES, "len {}", r.content.len());
        let v = parse(&r);
        assert!(v["rows"][0][0].as_str().unwrap().contains("…(+107500 chars)"));
        assert_eq!(v["rows_omitted_for_size"], json!(true));
    }

    #[test]
    fn cross_database_guard_reads_code_only() {
        let known = vec!["shop".to_string(), "sakila".to_string(), "test".to_string()];
        let check = |sql: &str| references_other_database(sql, SqlDialect::Mysql, "shop", &known);
        // Not references to another database.
        assert_eq!(check("SELECT * FROM users WHERE email LIKE '%@sakila.com'"), None);
        assert_eq!(check("SELECT 1 -- compare with sakila.film later"), None);
        assert_eq!(check("SELECT f.id FROM films f"), None);
        assert_eq!(check("SELECT * FROM shop.users"), None);
        // References to another database, however they're dressed up.
        assert_eq!(check("SELECT * FROM sakila.film").as_deref(), Some("sakila"));
        assert_eq!(check("SELECT * FROM `Sakila`.`film`").as_deref(), Some("sakila"));
        assert_eq!(check("USE sakila").as_deref(), Some("sakila"));
        assert_eq!(check("SELECT 1;\nUSE sakila;\nSELECT * FROM film").as_deref(), Some("sakila"));
        assert_eq!(check("-- c\nUSE sakila").as_deref(), Some("sakila"));
        assert_eq!(check("/* x */ USE `sakila`").as_deref(), Some("sakila"));
    }
}
