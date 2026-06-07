//! Schema-context builder. Produces a compact markdown blob that's injected
//! as a system message so every turn of the chat starts with a shared
//! understanding of "what database we're looking at."
//!
//! Design goals:
//!   - Fits a 4k-context model comfortably by default (cap ~6KB, ~1500 tokens).
//!   - Human-readable; the model treats it as documentation.
//!   - No rows ever, just shapes — safe to ship to hosted providers.
//!
//! When schemas are too wide to fit under the cap we degrade gracefully: list
//! every table name, include full detail only for a subset (default 40).
//! Tool-use (M8.4 Stage 2) will later let the model fetch full detail on
//! demand, so this truncation is cosmetic, not a correctness issue.

use std::sync::Arc;

use adapter_api::{template, AdapterError};
use serde_json::json;

use crate::commands::ai::FocusHint;
use crate::db::registry::Registry;

/// Soft cap on the rendered context size. 6KB ≈ 1.5k-2k tokens depending on
/// tokenizer — leaves plenty of room for chat history + user turn within a
/// 4k context window.
const MAX_CONTEXT_BYTES: usize = 6_000;

/// Static, non-schema-dependent instructions. Prepended by the provider
/// wrappers as the first message on every request, never stored in
/// `session.messages`. Splitting it out of the schema context avoids
/// re-injecting ~1KB of rules into history every time the user switches
/// tabs — the rules don't change, so they don't belong in the transcript.
///
/// Rules are written in second person ("you") and assume the model is the
/// subject of the verb. The two most common failure modes we've seen:
///   1. Model writes SQL in chat and asks the user to "use call_sql" —
///      treating the tool as something the user invokes. Wording here
///      carefully says "the tool is the deliverable" and "never preview SQL".
///   2. Model infers country/language from email domains. Explicit ban.
pub fn system_prompt(provider: &str, model: &str) -> String {
    // Identity line: tells the model who it is and what's driving it. Falls back
    // gracefully when model is empty (e.g. opencode using its configured default).
    let model_part = if model.trim().is_empty() { "its default model" } else { model };
    let identity = format!(
        "You are Table Relay Agent with provider {provider} and model {model_part}.\n\n"
    );
    identity + SYSTEM_PROMPT_BODY
}

/// The static rules body, identity-independent. Prefixed with the dynamic
/// identity line in [`system_prompt`].
const SYSTEM_PROMPT_BODY: &str =
    "You are a SQL assistant embedded in a live database client.\n\n\
     Always respond in English by default, regardless of the language the user's \
     greeting or message appears to be in. Only switch languages if the user \
     explicitly asks you to use a different language.\n\n\
     Tools you can call:\n\
     - `describe_table` — use BEFORE writing any SQL that names a column or table you \
     haven't already seen. Never guess identifiers.\n\
     - `call_query` (a.k.a. `run_query`) — YOU execute the SQL yourself against the live \
     database and get the rows back. Use this whenever the answer requires reading or \
     changing real data: find, search, look up, count, list, show, get, sample, preview, \
     check, inspect, filter, how many, which, who, what are, any with — and for \
     INSERT/UPDATE/CREATE the user asked you to perform. **Call the tool yourself**; the \
     tool call IS the deliverable. Do not paste SQL in chat and ask the user to run it.\n\
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
     they resolve against the active database.\n\
     - You may be locked to the active database. If a tool returns a \"cross-database \
     access is disabled\" error, do NOT retry against another database — tell the user they \
     can enable cross-database access in the AI permissions panel.\n\n\
     Answering data questions — things you cannot know without querying:\n\
     - Do NOT infer language, country, region, or locale from email domains. Gmail, \
     Yahoo, Hotmail, iCloud etc. are global — they do not indicate any country.\n\
     - Do NOT assume columns store particular values or formats without sampling. If \
     the user asks \"find X\", first check what columns exist that could hold X \
     (country, locale, phone, address, language), and if unsure, sample a few rows with \
     `call_sql` (SELECT ... LIMIT 10) before writing a filter.\n\
     - If no obvious column exists for the user's question, tell them what columns you \
     see and ask which one to filter on — don't make up a heuristic.";
/// Max tables we try to fully describe when the schema is large. Every
/// table beyond this is listed by name only; the model can ask for more
/// via `describe_table` once tool use is wired.
const MAX_FULL_TABLES: usize = 40;

pub async fn build(
    registry: &Arc<Registry>,
    connection_id: &str,
    schema: Option<&str>,
    focus: Option<&FocusHint>,
) -> Result<String, AdapterError> {
    let adapter = registry.get(connection_id).await?;
    let manifest = registry.manifest(connection_id).await.ok();
    let schemas = adapter.list_schemas().await?;

    // Pick which schema to focus on: the one the UI told us about, falling
    // back to the driver's default, then the first schema in the list.
    let schema_name = schema
        .map(str::to_string)
        .or_else(|| schemas.first().map(|s| s.name.clone()))
        .unwrap_or_default();

    // Per-adapter context slice — short paragraph the adapter ships in
    // `templates/ai_system_context.md`, describing its dialect /
    // vocabulary / pitfalls. The template may reference `{adapter.key}`,
    // `{schema.name}`, etc; we render it here with the runtime context.
    // Empty for the test-fixture adapter; skip cleanly when absent.
    let template_ctx = json!({
        "adapter": manifest.as_ref().map(|m| json!({
            "key": m.adapter.key,
            "displayName": m.adapter.display_name,
        })).unwrap_or(json!({})),
        "schema": { "name": schema_name },
        "connection": { "id": connection_id },
    });
    let adapter_ctx: Option<String> = manifest
        .as_ref()
        .map(|m| template::render(m.ai_system_context, &template_ctx))
        .filter(|s| !s.trim().is_empty());
    let Some(info) = schemas.iter().find(|s| s.name == schema_name) else {
        let primer = adapter_ctx
            .map(|c| format!("# Adapter primer\n\n{}\n\n", c.trim()))
            .unwrap_or_default();
        return Ok(format!(
            "{primer}# Database context\n\nNo schema `{schema_name}` on this connection."
        ));
    };

    let fks = adapter.list_relations(&schema_name).await.unwrap_or_default();

    let mut out = String::new();
    // CRITICAL RULES FIRST. These ride at the very top of the freshly-injected
    // context message every turn — the highest-salience position for models
    // that underweight the separate static system prompt (weak local models
    // were replying in Chinese and looping `list_schemas` despite the static
    // rules). Stated imperatively, before anything else.
    out.push_str("# IMPORTANT RULES (read first)\n\n");
    out.push_str(&format!(
        "1. **Reply in English.** Always respond in English regardless of the user's \
         greeting language. Only switch if the user explicitly asks for another language.\n\
         2. **You are already connected to the `{schema_name}` database.** Do NOT call \
         `list_schemas` — you know the database; it is `{schema_name}`. All tables below \
         belong to it. Reference them by bare name.\n\
         3. If a tool says \"cross-database access is disabled\", do not retry — tell the \
         user to enable it in AI permissions.\n\n"
    ));
    // Adapter primer next — the model needs to know "this is Redis, not
    // SQL" (or "MySQL vs SQLite") before it reads the schema markdown and
    // starts forming a plan. Wrapped in a header so it's visually distinct
    // from the schema block below.
    if let Some(ctx) = adapter_ctx {
        out.push_str("# Adapter primer\n\n");
        out.push_str(ctx.trim());
        out.push_str("\n\n");
    }
    out.push_str("# Database context\n\n");
    out.push_str(&format!(
        "Active database: `{schema_name}`. All queries and table references are scoped to it.\n\n"
    ));
    out.push_str(&format!("- Active database: `{schema_name}`\n"));
    out.push_str(&format!("- Tables in `{schema_name}`: {}\n", info.tables.len()));
    if !schemas.is_empty() {
        let other_count = schemas.iter().filter(|s| s.name != schema_name).count();
        if other_count > 0 {
            // Don't enumerate the other databases — that's exactly the
            // server-wide list we're trying to keep the model from fixating on.
            // Just acknowledge they exist and that they're out of scope.
            out.push_str(&format!(
                "- {other_count} other database(s) exist on this server but are out of scope for this conversation.\n"
            ));
        }
    }
    out.push('\n');

    // Focus block — what the user is looking at right now. Placed before the
    // table listing so the model sees "this" immediately instead of sifting
    // through 40 tables first. Rendered inline (not through tool calls) so
    // it's available even on providers that don't support tools.
    if let Some(focus) = focus {
        out.push_str("## Active focus\n\n");
        match focus {
            FocusHint::Query { sql } => {
                let snippet = if sql.len() > 3_000 {
                    format!("{}\n-- …(truncated, {} bytes total)…", &sql[..3_000], sql.len())
                } else {
                    sql.clone()
                };
                out.push_str("The user is editing a query tab. The current buffer is:\n\n```sql\n");
                out.push_str(&snippet);
                out.push_str("\n```\n\n");
            }
            FocusHint::Routine { schema: rsch, name, kind } => {
                out.push_str(&format!(
                    "The user is viewing {kind} `{rsch}.{name}`. "
                ));
                match adapter.describe_routine(rsch, name, kind).await {
                    Ok(def) => {
                        out.push_str("Definition:\n\n```sql\n");
                        if !def.parameters.is_empty() {
                            let params = def
                                .parameters
                                .iter()
                                .map(|p| format!("{} {}", p.name, p.data_type))
                                .collect::<Vec<_>>()
                                .join(", ");
                            if let Some(ret) = &def.returns {
                                out.push_str(&format!(
                                    "CREATE FUNCTION `{rsch}`.`{name}` ({params}) RETURNS {ret}\n"
                                ));
                            } else {
                                out.push_str(&format!(
                                    "CREATE PROCEDURE `{rsch}`.`{name}` ({params})\n"
                                ));
                            }
                        } else if kind == "view" {
                            out.push_str(&format!("CREATE VIEW `{rsch}`.`{name}` AS\n"));
                        }
                        let body = if def.body.len() > 4_000 {
                            format!("{}\n-- …(truncated, {} bytes total)…", &def.body[..4_000], def.body.len())
                        } else {
                            def.body.clone()
                        };
                        out.push_str(&body);
                        out.push_str("\n```\n\n");
                    }
                    Err(e) => {
                        out.push_str(&format!("(failed to load definition: {e})\n\n"));
                    }
                }
            }
            FocusHint::Table { schema: tsch, name } => {
                out.push_str(&format!(
                    "The user is viewing table `{tsch}.{name}`. Call `describe_table` if you need the column list.\n\n"
                ));
            }
            FocusHint::Realtime { pattern, is_running, recent_channels } => {
                out.push_str(
                    "The user is on the **realtime** tab. They want help with pub/sub: \
                     publish (NOTIFY/PUBLISH) a message, subscribe (LISTEN/SUBSCRIBE) to a \
                     channel, or inspect received events. Use the adapter primer above \
                     for the exact syntax — wildcards behave differently between Redis \
                     and Postgres. When the user asks you to publish, prefer the \
                     `publish_notify` tool (subject to user approval). When they ask \
                     you to start a subscription, emit the channel name clearly; the UI's \
                     Start button runs it.\n\n",
                );
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
                    let shown: Vec<String> = recent_channels
                        .iter()
                        .take(10)
                        .map(|c| format!("`{c}`"))
                        .collect();
                    out.push_str(&format!("Recent channels observed: {}\n", shown.join(", ")));
                }
                out.push('\n');
            }
        }
    }

    // Fast exit: no tables to describe.
    if info.tables.is_empty() {
        out.push_str("_The active schema has no tables._\n");
        return Ok(out);
    }

    // Pick which tables get full detail. We sort alphabetically so the output
    // is stable across runs.
    let mut table_names: Vec<String> = info.tables.iter().map(|t| t.name.clone()).collect();
    table_names.sort();

    let full_count = table_names.len().min(MAX_FULL_TABLES);

    out.push_str("## Tables\n\n");
    for name in table_names.iter().take(full_count) {
        // `describe_table` can be slow for enormous schemas. Worst case we
        // just skip the ones that fail — the model still sees the name.
        match adapter.describe_table(&schema_name, name).await {
            Ok(structure) => {
                out.push_str(&format!("### `{}`\n", name));
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
                    out.push_str(&format!(
                        "- `{}` {}{}\n",
                        col.name, col.data_type, tag_str
                    ));
                }
                out.push('\n');

                // Bail early if we're running over the soft cap — keeps the
                // output bounded even when schemas have huge column counts.
                if out.len() > MAX_CONTEXT_BYTES {
                    out.push_str("_(output truncated to fit the context window)_\n");
                    break;
                }
            }
            Err(e) => {
                out.push_str(&format!("### `{}` — _(describe failed: {})_\n\n", name, e));
            }
        }
    }

    if table_names.len() > full_count {
        let remainder = table_names.len() - full_count;
        out.push_str(&format!(
            "\n_Additional {remainder} tables not shown in full:_ {}\n",
            table_names
                .iter()
                .skip(full_count)
                .map(|n| format!("`{n}`"))
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }

    // Relationships section — compact, one line per FK.
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

    Ok(out)
}

