//! Schema-context builder. Produces a compact markdown blob that's injected
//! as a system message so every turn of the chat starts with a shared
//! understanding of "what database we're looking at."
//!
//! Design goals:
//!   - Bounded: every table NAME is listed (up to a few hundred), column detail
//!     only for as many tables as fit a ~6KB budget.
//!   - Human-readable; the model treats it as documentation.
//!   - No rows ever, just shapes — safe to ship to hosted providers.
//!   - Honest about what the model can do: a provider without tools is told to
//!     write SQL for the user instead of being taught tools it can't call.
//!
//! The schema part (rules, primer, table listing) is cached per connection,
//! database and schema for a few minutes, so editing the query buffer — which
//! changes the focus and so rebuilds the context — doesn't re-describe every
//! table on each turn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use adapter_api::{template, Adapter, AdapterError, SqlDialect};
use futures::stream::{self, StreamExt};
use serde_json::json;

use crate::commands::ai::FocusHint;
use crate::db::registry::Registry;

/// Budget for the per-table column listing. 6KB ≈ 1.5k-2k tokens depending on
/// tokenizer — leaves room for chat history + the user turn on small models.
const TABLE_DETAIL_BYTES: usize = 6_000;

/// Max tables whose columns we fetch. Every table beyond this (or beyond the
/// byte budget) is listed by name only.
const MAX_FULL_TABLES: usize = 40;

/// Table names listed at all. Past this the model is pointed at `list_tables`.
const MAX_LISTED_TABLES: usize = 300;

/// `describe_table` calls in flight while building — sequential round-trips to
/// a remote server made a 40-table build take many seconds.
const DESCRIBE_CONCURRENCY: usize = 6;

/// A slow server must not hold the turn hostage: a table that doesn't describe
/// in time is listed by name only.
const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a built schema listing is reused. Changes the AI makes itself
/// invalidate it at once (see [`note_schema_change`]); this bounds staleness
/// for changes made elsewhere.
pub const SCHEMA_CONTEXT_TTL: Duration = Duration::from_secs(300);

/// Bumped whenever the AI runs DDL. Part of the session's context key, so the
/// next turn rebuilds.
static SCHEMA_EPOCH: AtomicU64 = AtomicU64::new(0);

/// The schema may have changed (the AI just ran DDL): drop cached listings.
pub fn note_schema_change() {
    SCHEMA_EPOCH.fetch_add(1, Ordering::SeqCst);
    cache().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

pub fn schema_epoch() -> u64 {
    SCHEMA_EPOCH.load(Ordering::SeqCst)
}

/// The static part of the context for one (connection, database, schema).
#[derive(Clone)]
struct SchemaSection {
    /// Rules, adapter primer and the database summary — goes before the focus.
    head: String,
    /// Table listing and foreign keys — goes after the focus.
    tables: String,
}

struct CachedSection {
    built_at: Instant,
    epoch: u64,
    section: SchemaSection,
}

fn cache() -> &'static Mutex<HashMap<String, CachedSection>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSection>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_section(key: &str) -> Option<SchemaSection> {
    let cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    cache
        .get(key)
        .filter(|c| c.epoch == schema_epoch() && c.built_at.elapsed() < SCHEMA_CONTEXT_TTL)
        .map(|c| c.section.clone())
}

fn store_section(key: String, section: SchemaSection) {
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    let epoch = schema_epoch();
    cache.retain(|_, c| c.epoch == epoch && c.built_at.elapsed() < SCHEMA_CONTEXT_TTL);
    cache.insert(key, CachedSection { built_at: Instant::now(), epoch, section });
}

/// Static, non-schema-dependent instructions. Prepended by the provider
/// wrappers as the first message on every request, never stored in
/// `session.messages`. Splitting it out of the schema context avoids
/// re-injecting ~1KB of rules into history every time the user switches
/// tabs — the rules don't change, so they don't belong in the transcript.
///
/// `tools` says whether this turn can call the DB tools (natively or over
/// MCP). Without them the prompt must not teach tool use: models told about
/// `call_query` they couldn't call claimed to have run queries and invented
/// the results.
///
/// Rules are written in second person ("you") and assume the model is the
/// subject of the verb. The two most common failure modes we've seen:
///   1. Model writes SQL in chat and asks the user to "use call_sql" —
///      treating the tool as something the user invokes. Wording here
///      carefully says "the tool is the deliverable" and "never preview SQL".
///   2. Model infers country/language from email domains. Explicit ban.
pub fn system_prompt(provider: &str, model: &str, tools: bool) -> String {
    // Identity line: tells the model who it is and what's driving it. Falls back
    // gracefully when model is empty (e.g. opencode using its configured default).
    let model_part = if model.trim().is_empty() { "its default model" } else { model };
    let mut out = format!(
        "You are Table Relay Agent with provider {provider} and model {model_part}.\n\n"
    );
    out.push_str(PROMPT_INTRO);
    if tools {
        out.push_str(PROMPT_TOOLS);
        out.push_str(PROMPT_GROUNDING_TOOLS);
        out.push_str(PROMPT_DATA_QUESTIONS_TOOLS);
    } else {
        out.push_str(PROMPT_NO_TOOLS);
        out.push_str(PROMPT_GROUNDING_NO_TOOLS);
        out.push_str(PROMPT_DATA_QUESTIONS_NO_TOOLS);
    }
    out
}

const PROMPT_INTRO: &str =
    "You are a database assistant embedded in a live database client. Use the query \
     language of the active connection — the adapter primer in the context says which \
     (a SQL dialect, MongoDB shell commands, or raw Redis commands).\n\n\
     Reply in the language the user writes in: Indonesian if they write Indonesian, \
     English if they write English, and so on. Judge it from the user's own words — their \
     latest message, or their earlier messages when the latest is app-generated (a Fix / \
     Explain / Generate request) or holds only SQL. If there is no clear language (just \
     code, or a one-word greeting like \"hi\"), use English. Never reply in a language the \
     user hasn't used. Only your prose follows the user: SQL, identifiers and tool \
     arguments stay exactly as they are.\n\n";

/// Rule 1 of the context's rule block — the language rule restated where weak
/// local models actually read it (they replied in Chinese to an English "hi").
const LANGUAGE_RULE: &str =
    "1. **Reply in the user's language.** Write in the language the user writes in \
     (Indonesian → Indonesian, English → English, …); with no clear language, use English. \
     Never switch to a language the user hasn't used. Keep SQL and identifiers unchanged.\n";

const PROMPT_TOOLS: &str =
    "Tools you can call:\n\
     - `describe_table` — use BEFORE writing any query that names a column or table you \
     haven't already seen. Never guess identifiers.\n\
     - `call_query` (a.k.a. `run_query`) — YOU execute the statement yourself against the \
     live database and get the rows back (`sql` holds the SQL, or the native command on \
     MongoDB/Redis). Use this whenever the answer requires reading or changing real data: \
     find, search, look up, count, list, show, get, sample, preview, check, inspect, filter, \
     how many, which, who, what are, any with — and for INSERT/UPDATE/CREATE the user asked \
     you to perform. **Call the tool yourself**; the tool call IS the deliverable. Do not \
     paste SQL in chat and ask the user to run it. The result reports `rows_affected` for \
     writes, a per-statement summary for multi-statement batches, and only a sample of the \
     rows (`rows_shown` of `row_count`) — use COUNT/aggregates for totals.\n\
     - `write_query_tab` — does NOT execute anything. It only DROPS SQL into the user's \
     query editor for THEM to review and run manually. Use it ONLY when the user explicitly \
     wants the SQL in their editor: \"put it in a tab\", \"write/scaffold/draft this query\", \
     \"open in editor\", or when they want to edit before running. If the user wants an \
     ANSWER or wants the work done, use `call_query` instead — do not `write_query_tab` and \
     consider the task finished, because nothing ran. mode=replace overwrites the current \
     query tab, mode=new opens a separate one.\n\
     - `open_object_tab` — opens a dedicated EDITOR tab for a TRIGGER or a TABLE so the user \
     can review and save it (not a plain query tab). Use when the user wants to create or \
     edit a trigger or a table's structure: \"create a trigger\", \"edit this trigger\", \
     \"create a table\", \"edit the table\". For a trigger you can pass `sql` with a full \
     `CREATE TRIGGER …` statement to prefill the editor; pass `name` to edit an existing \
     object, or omit it for a blank new editor. It does NOT execute — the user saves from \
     the editor. To run DDL yourself instead, use `call_query`.\n\
     - `publish_notify` — use when the user asks you to publish / notify / send / trigger \
     a message on a pub/sub channel. Works on Postgres (NOTIFY) and Redis (PUBLISH).\n\
     - `subscribe_channel` — use when the user asks you to subscribe / listen / watch / \
     monitor a channel on the realtime tab. The UI fills the channel and starts the \
     subscription; events stream into the realtime tab, not into this chat.\n\n\
     Calling tools — hard rules:\n\
     - **Call the tool. Never preview SQL in the chat asking for confirmation.** The UI \
     automatically shows an Approve/Deny button before anything executes — the user is \
     always in control.\n\
     - If the user says yes / run it / go ahead / please / do it, call the tool \
     immediately. Don't paraphrase the plan back.\n\
     - Keep chat responses brief. One sentence before the tool call is plenty; the SQL \
     itself shows up in the approval card.\n\
     - After a tool returns, interpret the result in 1-3 sentences. Don't restate the \
     raw numbers unless asked; summarize.\n\n\
     Database scope:\n\
     - You operate on ONE active database, named in the context below. Do not call \
     `list_schemas` to discover \"which database\" — you are already connected to it and \
     the context states its name. Reference tables by bare name (or active-db-qualified); \
     they resolve against the active database. Don't switch databases with `USE`.\n\
     - You may be locked to the active database. If a tool returns a \"cross-database \
     access is disabled\" error, do NOT retry against another database — tell the user they \
     can enable cross-database access in the AI permissions panel.\n\n";

const PROMPT_NO_TOOLS: &str =
    "You have NO tools in this chat: you cannot run queries, look tables up, or see any \
     data yourself. Work only from the database context below and what the user tells you.\n\
     - When the user wants data or a change, write the statement in one fenced code block \
     (```sql for SQL databases) for them to run, with one line on what it does.\n\
     - Never claim you ran something, and never present results, row counts or sample data \
     you weren't given. When the user pastes results or an error, work from those.\n\
     - Write queries for the active database named in the context; reference its tables by \
     bare name.\n\n";

const PROMPT_GROUNDING_TOOLS: &str =
    "Grounding — NEVER hallucinate (most important rule):\n\
     - Every table, column, value, count, and relationship you state MUST come from \
     the injected context above or from a tool result you actually received this \
     conversation. If you have not seen it, you do not know it.\n\
     - Do NOT invent or guess table names, column names, data types, enum values, row \
     counts, or sample data. If you are unsure a table or column exists, call \
     `describe_table` (or `list_tables`) FIRST and read the real structure before \
     writing any query that references it.\n\
     - The injected schema may be PARTIAL: large schemas list some tables by name only \
     (no columns), and some describes can fail. For ANY table whose columns you have \
     not actually seen, you MUST call `describe_table` before querying it — never \
     assume its columns.\n\
     - Never present a query's result, a number, or a fact unless a tool returned it. \
     Do not fabricate output to look complete. If a tool errored or returned nothing, \
     say so plainly.\n\
     - When you genuinely lack the information and cannot get it from a tool, say you \
     don't know and ask the user — do not fill the gap with a plausible guess.\n\n";

const PROMPT_GROUNDING_NO_TOOLS: &str =
    "Grounding — NEVER hallucinate (most important rule):\n\
     - Every table, column, value, count, and relationship you state MUST come from \
     the injected context above or from what the user shared. If you have not seen it, \
     you do not know it.\n\
     - Do NOT invent or guess table names, column names, data types, enum values, row \
     counts, or sample data.\n\
     - The injected schema may be PARTIAL: large schemas list some tables by name only \
     (no columns). For a table whose columns you have not seen, say so and ask the user \
     for them (or to open the table) — never assume its columns.\n\
     - When you genuinely lack the information, say you don't know and ask the user — \
     do not fill the gap with a plausible guess.\n\n";

const PROMPT_DATA_QUESTIONS_TOOLS: &str =
    "Answering data questions — things you cannot know without querying:\n\
     - Do NOT infer language, country, region, or locale from email domains. Gmail, \
     Yahoo, Hotmail, iCloud etc. are global — they do not indicate any country.\n\
     - Do NOT assume columns store particular values or formats without sampling. If \
     the user asks \"find X\", first check what columns exist that could hold X \
     (country, locale, phone, address, language), and if unsure, sample a few rows with \
     `call_query` (SELECT ... LIMIT 10) before writing a filter.\n\
     - If no obvious column exists for the user's question, tell them what columns you \
     see and ask which one to filter on — don't make up a heuristic.";

const PROMPT_DATA_QUESTIONS_NO_TOOLS: &str =
    "Answering data questions — things you cannot know without the data:\n\
     - Do NOT infer language, country, region, or locale from email domains. Gmail, \
     Yahoo, Hotmail, iCloud etc. are global — they do not indicate any country.\n\
     - Do NOT assume columns store particular values or formats. If the filter depends on \
     how values look, give the user a small sampling query (SELECT ... LIMIT 10) to run \
     first, then write the real query from what they report.\n\
     - If no obvious column exists for the user's question, tell them what columns you \
     see and ask which one to filter on — don't make up a heuristic.";

/// Quote an identifier for the active dialect (for SQL shown to the model).
fn quote_ident(dialect: Option<SqlDialect>, name: &str) -> String {
    match dialect {
        Some(SqlDialect::Mysql) => format!("`{}`", name.replace('`', "``")),
        Some(SqlDialect::Postgres | SqlDialect::Sqlite | SqlDialect::Generic) => {
            format!("\"{}\"", name.replace('"', "\"\""))
        }
        _ => name.to_string(),
    }
}

/// `text` cut to `max` bytes with a marker, for definitions pasted into the
/// context.
fn clipped_sql(text: &str, max: usize) -> String {
    if text.len() > max {
        format!(
            "{}\n-- …(truncated, {} bytes total)…",
            crate::ai::clip_str(text, max),
            text.len()
        )
    } else {
        text.to_string()
    }
}

/// What to do about a table whose columns the model hasn't seen.
fn unknown_columns_hint(tools: bool) -> &'static str {
    if tools {
        "call `describe_table` before querying it — never guess its columns"
    } else {
        "ask the user for its columns — never guess them"
    }
}

/// Build the context message for one turn. `database` is the connection's
/// current database where it differs from the schema (Postgres); it's part of
/// the cache key because switching databases keeps the connection id.
pub async fn build(
    registry: &Arc<Registry>,
    connection_id: &str,
    schema: Option<&str>,
    focus: Option<&FocusHint>,
    tools: bool,
) -> Result<String, AdapterError> {
    let adapter = registry.get(connection_id).await?;
    let manifest = registry.manifest(connection_id).await.ok();
    let dialect = manifest.map(|m| m.capabilities.sql_dialect);
    let database = registry.profile(connection_id).await.ok().and_then(|p| p.database);

    let key = format!(
        "{connection_id}|{}|{}|{tools}",
        database.as_deref().unwrap_or(""),
        schema.unwrap_or("")
    );
    let section = match cached_section(&key) {
        Some(s) => s,
        None => {
            let s = build_schema_section(registry, &adapter, connection_id, schema, tools).await?;
            store_section(key, s.clone());
            s
        }
    };

    let mut out = section.head;
    if let Some(focus) = focus {
        out.push_str(&build_focus(&adapter, focus, dialect, tools).await);
    }
    out.push_str(&section.tables);
    Ok(out)
}

async fn build_schema_section(
    registry: &Arc<Registry>,
    adapter: &Arc<dyn Adapter>,
    connection_id: &str,
    schema: Option<&str>,
    tools: bool,
) -> Result<SchemaSection, AdapterError> {
    let manifest = registry.manifest(connection_id).await.ok();
    let schemas = adapter.list_schemas().await?;

    // Postgres models the database (e.g. `apex`) as distinct from its SQL schema
    // (`public`). `schema_name` here is the SQL SCHEMA. Tools take a `schema`
    // arg — the model must pass the schema, never the database name, or
    // describe_table/list_tables fail with "not found". Call that out explicitly.
    let is_postgres = manifest
        .map(|m| matches!(m.capabilities.sql_dialect, SqlDialect::Postgres))
        .unwrap_or(false);

    // Which schema the chat is about: the one the UI told us, else the
    // connection's own default, else the only one there is. Never just the
    // first in the list — on MySQL that's often `information_schema`, and the
    // model was told "you are connected to `information_schema`".
    let default_schema = registry.meta(connection_id).await.and_then(|m| m.server.default_schema);
    let has = |n: &str| schemas.iter().any(|s| s.name == n);
    let schema_name: Option<String> = schema
        .map(str::to_string)
        .or_else(|| default_schema.filter(|d| has(d)))
        .or_else(|| (is_postgres && has("public")).then(|| "public".to_string()))
        .or_else(|| (schemas.len() == 1).then(|| schemas[0].name.clone()));

    // Per-adapter context slice — short paragraph the adapter ships in
    // `templates/ai_system_context.md`, describing its dialect /
    // vocabulary / pitfalls. The template may reference `{adapter.key}`,
    // `{schema.name}`, etc; we render it here with the runtime context.
    // Empty for the test-fixture adapter; skip cleanly when absent.
    let template_ctx = json!({
        "adapter": manifest.map(|m| json!({
            "key": m.adapter.key,
            "displayName": m.adapter.display_name,
        })).unwrap_or(json!({})),
        "schema": { "name": schema_name.as_deref().unwrap_or("") },
        "connection": { "id": connection_id },
    });
    let primer = manifest
        .map(|m| template::render(m.ai_system_context, &template_ctx))
        .filter(|s| !s.trim().is_empty())
        .map(|c| format!("# Adapter primer\n\n{}\n\n", c.trim()))
        .unwrap_or_default();

    let Some(schema_name) = schema_name else {
        // Nothing selected and nothing to infer: say so instead of guessing.
        let mut names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        let shown = names.iter().take(50).map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
        let more = names.len().saturating_sub(50);
        let more = if more > 0 { format!(" (+{more} more)") } else { String::new() };
        let head = format!(
            "# IMPORTANT RULES (read first)\n\n\
             {LANGUAGE_RULE}\
             2. **No database is selected on this connection.** Ask the user which database \
             to work in, or qualify every table with its database name.\n\n\
             {primer}# Database context\n\n\
             No active database. Databases on this server: {shown}{more}.\n\n"
        );
        return Ok(SchemaSection { head, tables: String::new() });
    };

    let Some(info) = schemas.iter().find(|s| s.name == schema_name) else {
        return Ok(SchemaSection {
            head: format!("{primer}# Database context\n\nNo schema `{schema_name}` on this connection.\n\n"),
            tables: String::new(),
        });
    };

    let mut head = String::new();
    // CRITICAL RULES FIRST. These ride at the very top of the freshly-injected
    // context message every turn — the highest-salience position for models
    // that underweight the separate static system prompt (weak local models
    // were replying in Chinese and looping `list_schemas` despite the static
    // rules). Stated imperatively, before anything else.
    head.push_str("# IMPORTANT RULES (read first)\n\n");
    head.push_str(LANGUAGE_RULE);
    match (is_postgres, tools) {
        // The #1 source of "not found" errors: the model passes the DATABASE
        // name as the `schema` tool arg. State the schema explicitly and ban
        // using the database name as a schema.
        (true, true) => head.push_str(&format!(
            "2. **The active SQL schema is `{schema_name}`.** When a tool takes a `schema` \
             argument (describe_table, list_tables, …), pass `{schema_name}` — or omit it to \
             use the active schema. NEVER pass the database name as `schema`. Reference \
             tables by bare name; they resolve to `{schema_name}`.\n"
        )),
        (true, false) => head.push_str(&format!(
            "2. **The active SQL schema is `{schema_name}`.** Reference tables by bare name; \
             they resolve to `{schema_name}`.\n"
        )),
        (false, true) => head.push_str(&format!(
            "2. **You are already connected to the `{schema_name}` database.** Do NOT call \
             `list_schemas` — you know the database; it is `{schema_name}`. All tables below \
             belong to it. Reference them by bare name.\n"
        )),
        (false, false) => head.push_str(&format!(
            "2. **You are connected to the `{schema_name}` database.** All tables below belong \
             to it. Reference them by bare name.\n"
        )),
    }
    if tools {
        head.push_str(
            "3. If a tool says \"cross-database access is disabled\", do not retry — tell the \
             user to enable it in AI permissions.\n",
        );
    }
    head.push('\n');
    // Adapter primer next — the model needs to know "this is Redis, not
    // SQL" (or "MySQL vs SQLite") before it reads the schema markdown and
    // starts forming a plan.
    head.push_str(&primer);
    head.push_str("# Database context\n\n");
    let scope_noun = if is_postgres { "schema" } else { "database" };
    head.push_str(&format!(
        "Active {scope_noun}: `{schema_name}`. All queries and table references are scoped to it.\n\n"
    ));
    head.push_str(&format!("- Tables in `{schema_name}`: {}\n", info.tables.len()));
    let mut others: Vec<&str> = schemas
        .iter()
        .map(|s| s.name.as_str())
        .filter(|n| *n != schema_name)
        .collect();
    others.sort_unstable();
    if !others.is_empty() {
        if is_postgres {
            // Postgres schemas live in the same database and are reachable —
            // they're namespaces, not other databases.
            let shown = others.iter().take(20).map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
            let more = others.len().saturating_sub(20);
            let more = if more > 0 { format!(" (+{more} more)") } else { String::new() };
            head.push_str(&format!(
                "- Other schemas in this database: {shown}{more}. Qualify their tables as \
                 `schema.table`.\n"
            ));
        } else {
            // Don't enumerate the other databases — that's exactly the
            // server-wide list we're trying to keep the model from fixating on.
            // Just acknowledge they exist and that they're out of scope.
            head.push_str(&format!(
                "- {} other database(s) exist on this server but are out of scope for this conversation.\n",
                others.len()
            ));
        }
    }
    head.push('\n');

    let tables = build_tables(adapter, &schema_name, info, tools).await;
    Ok(SchemaSection { head, tables })
}

/// Every table name, then columns for as many tables as fit, then FKs.
async fn build_tables(
    adapter: &Arc<dyn Adapter>,
    schema_name: &str,
    info: &adapter_api::SchemaInfo,
    tools: bool,
) -> String {
    let mut out = String::new();
    if info.tables.is_empty() {
        out.push_str("_The active schema has no tables._\n");
        return out;
    }

    // Sorted so the output is stable across runs.
    let mut tables: Vec<&adapter_api::TableInfo> = info.tables.iter().collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));

    // Names first, all of them (up to a cap): the old listing only named the
    // tables it also described, so once the column detail hit the byte budget
    // the remaining tables vanished and the model "didn't know" they existed.
    out.push_str("## Tables\n\n");
    let listed: Vec<String> = tables
        .iter()
        .take(MAX_LISTED_TABLES)
        .map(|t| {
            let mut s = format!("`{}`", t.name);
            match (t.kind, t.row_count) {
                (adapter_api::TableKind::View, _) => s.push_str(" (view)"),
                (_, Some(n)) => s.push_str(&format!(" (~{n} rows)")),
                _ => {}
            }
            s
        })
        .collect();
    out.push_str(&listed.join(", "));
    out.push('\n');
    if tables.len() > MAX_LISTED_TABLES {
        let more = tables.len() - MAX_LISTED_TABLES;
        out.push_str(&if tools {
            format!("\n_+{more} more tables not listed — call `list_tables` to see them._\n")
        } else {
            format!("\n_+{more} more tables not listed._\n")
        });
    }
    out.push('\n');

    // Columns for the first tables, fetched concurrently, kept in order.
    let wanted: Vec<String> = tables.iter().take(MAX_FULL_TABLES).map(|t| t.name.clone()).collect();
    let described: Vec<(String, Result<adapter_api::TableStructure, String>)> = stream::iter(wanted)
        .map(|name| {
            let adapter = adapter.clone();
            let schema = schema_name.to_string();
            async move {
                let r = match tokio::time::timeout(DESCRIBE_TIMEOUT, adapter.describe_table(&schema, &name)).await {
                    Ok(Ok(s)) => Ok(s),
                    Ok(Err(e)) => Err(e.to_string()),
                    Err(_) => Err("timed out".to_string()),
                };
                (name, r)
            }
        })
        .buffered(DESCRIBE_CONCURRENCY)
        .collect()
        .await;

    let mut detail = String::new();
    let mut detailed = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for (name, r) in described {
        match r {
            Ok(structure) => {
                let mut block = format!("### `{name}`\n");
                for col in &structure.columns {
                    let mut tags = Vec::new();
                    if col.is_primary { tags.push("PK"); }
                    if col.is_unique && !col.is_primary { tags.push("UK"); }
                    if !col.nullable { tags.push("NOT NULL"); }
                    let tag_str = if tags.is_empty() {
                        String::new()
                    } else {
                        format!(" [{}]", tags.join(", "))
                    };
                    block.push_str(&format!("- `{}` {}{}\n", col.name, col.data_type, tag_str));
                }
                block.push('\n');
                // Bounded even when tables have huge column counts.
                if !detail.is_empty() && detail.len() + block.len() > TABLE_DETAIL_BYTES {
                    break;
                }
                detail.push_str(&block);
                detailed += 1;
            }
            Err(e) => {
                crate::log_line!("ai_context", "describe {schema_name}.{name} failed: {e}");
                failed.push(name);
            }
        }
    }
    if detailed > 0 {
        out.push_str("## Columns\n\n");
        out.push_str(&detail);
    }
    if detailed < tables.len() {
        out.push_str(&format!(
            "_Columns are listed above for {detailed} of {} tables. For any other table, {}._\n",
            tables.len(),
            unknown_columns_hint(tools)
        ));
    }
    if !failed.is_empty() {
        crate::log_line!("ai_context", "{} table(s) could not be described", failed.len());
    }

    // Relationships section — compact, one line per FK.
    let fks = adapter.list_relations(schema_name).await.unwrap_or_default();
    if !fks.is_empty() {
        out.push_str("\n## Foreign keys\n\n");
        for fk in fks.iter().take(100) {
            out.push_str(&format!(
                "- `{}.{}` → `{}.{}`\n",
                fk.from_table,
                fk.from_columns.join(", "),
                fk.to_table,
                fk.to_columns.join(", "),
            ));
        }
        if fks.len() > 100 {
            out.push_str(&format!("\n_(+ {} more FKs omitted)_\n", fks.len() - 100));
        }
    }
    out
}

/// What the user is looking at right now. Placed before the table listing so
/// the model sees "this" immediately instead of sifting through the tables
/// first. Rendered inline (not through tool calls) so it's available even on
/// providers that don't support tools.
async fn build_focus(
    adapter: &Arc<dyn Adapter>,
    focus: &FocusHint,
    dialect: Option<SqlDialect>,
    tools: bool,
) -> String {
    let mut out = String::from("## Active focus\n\n");
    match focus {
        FocusHint::Query { sql } => {
            out.push_str("The user is editing a query tab. The current buffer is:\n\n```sql\n");
            out.push_str(&clipped_sql(sql, 3_000));
            out.push_str("\n```\n\n");
        }
        FocusHint::Routine { schema: rsch, name, kind } => {
            out.push_str(&format!("The user is viewing {kind} `{rsch}.{name}`. "));
            match adapter.describe_routine(rsch, name, kind).await {
                Ok(def) => {
                    let qualified = format!("{}.{}", quote_ident(dialect, rsch), quote_ident(dialect, name));
                    out.push_str("Definition:\n\n```sql\n");
                    if !def.parameters.is_empty() {
                        let params = def
                            .parameters
                            .iter()
                            .map(|p| format!("{} {}", p.name, p.data_type))
                            .collect::<Vec<_>>()
                            .join(", ");
                        if let Some(ret) = &def.returns {
                            out.push_str(&format!("CREATE FUNCTION {qualified} ({params}) RETURNS {ret}\n"));
                        } else {
                            out.push_str(&format!("CREATE PROCEDURE {qualified} ({params})\n"));
                        }
                    } else if kind == "view" {
                        out.push_str(&format!("CREATE VIEW {qualified} AS\n"));
                    }
                    out.push_str(&clipped_sql(&def.body, 4_000));
                    out.push_str("\n```\n\n");
                }
                Err(e) => out.push_str(&format!("(failed to load definition: {e})\n\n")),
            }
        }
        FocusHint::Table { schema: tsch, name } => {
            // Describe it right here: "this table" is what the next question is
            // about, and it may be one the listing has no columns for.
            out.push_str(&format!("The user is viewing table `{tsch}.{name}`."));
            match tokio::time::timeout(DESCRIBE_TIMEOUT, adapter.describe_table(tsch, name)).await {
                Ok(Ok(structure)) => {
                    out.push_str(" Its columns:\n\n");
                    for col in &structure.columns {
                        let pk = if col.is_primary { " [PK]" } else { "" };
                        out.push_str(&format!("- `{}` {}{pk}\n", col.name, col.data_type));
                    }
                    out.push('\n');
                }
                _ => out.push_str(&format!(" To see its columns, {}.\n\n", unknown_columns_hint(tools))),
            }
        }
        FocusHint::Trigger { schema: tsch, name } => {
            out.push_str(&format!("The user is editing trigger `{tsch}.{name}`. "));
            match adapter.describe_trigger(tsch, name).await {
                Ok(def) => {
                    out.push_str(if tools {
                        "Its current definition is below. To edit it, return the full \
                         corrected `CREATE TRIGGER` (and any function it depends on) — open \
                         it in the editor with `open_object_tab` (object=trigger), or run the \
                         DDL with `call_query`.\n\n```sql\n"
                    } else {
                        "Its current definition is below. To edit it, return the full \
                         corrected `CREATE TRIGGER` (and any function it depends on) in one \
                         ```sql block for the user to run.\n\n```sql\n"
                    });
                    out.push_str(&clipped_sql(&def.create_sql, 4_000));
                    out.push_str("\n```\n\n");
                }
                Err(e) => out.push_str(&format!("(failed to load definition: {e})\n\n")),
            }
        }
        FocusHint::Realtime { pattern, is_running, recent_channels } => {
            out.push_str(
                "The user is on the **realtime** tab. They want help with pub/sub: \
                 publish (NOTIFY/PUBLISH) a message, subscribe (LISTEN/SUBSCRIBE) to a \
                 channel, or inspect received events. Use the adapter primer above \
                 for the exact syntax — wildcards behave differently between Redis \
                 and Postgres. ",
            );
            out.push_str(if tools {
                "When the user asks you to publish, prefer the `publish_notify` tool \
                 (subject to user approval). When they ask you to start a subscription, \
                 use `subscribe_channel` or emit the channel name clearly; the UI's Start \
                 button runs it.\n\n"
            } else {
                "Give the exact command to publish, or the channel/pattern to type into \
                 the subscribe box.\n\n"
            });
            if pattern.is_empty() {
                out.push_str("Current subscription pattern: (none set)\n");
            } else {
                out.push_str(&format!("Current subscription pattern: `{pattern}`\n"));
            }
            out.push_str(&format!(
                "Subscription active: {}\n",
                if *is_running { "yes" } else { "no" },
            ));
            if !recent_channels.is_empty() {
                let shown: Vec<String> = recent_channels.iter().take(10).map(|c| format!("`{c}`")).collect();
                out.push_str(&format!("Recent channels observed: {}\n", shown.join(", ")));
            }
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_without_tools_teaches_no_tools() {
        let p = system_prompt("anthropic", "m", false);
        assert!(!p.contains("call_query"), "{p}");
        assert!(!p.contains("describe_table"), "{p}");
        assert!(p.contains("NO tools"));
        let p = system_prompt("openai", "m", true);
        assert!(p.contains("call_query"));
    }

    #[test]
    fn quoting_follows_the_dialect() {
        assert_eq!(quote_ident(Some(SqlDialect::Mysql), "a`b"), "`a``b`");
        assert_eq!(quote_ident(Some(SqlDialect::Postgres), "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(None, "x"), "x");
    }

    #[test]
    fn schema_change_invalidates_cached_sections() {
        let key = "test-conn|db|s|true".to_string();
        store_section(key.clone(), SchemaSection { head: "h".into(), tables: "t".into() });
        assert!(cached_section(&key).is_some());
        note_schema_change();
        assert!(cached_section(&key).is_none());
    }
}
