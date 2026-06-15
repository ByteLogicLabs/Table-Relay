//! The tool-calling loop and the conversation-history helpers it shares with
//! the streaming chat path.

use std::sync::Arc;

use futures::StreamExt;
use tauri::{Emitter, State};

use crate::ai::openai::{ToolStreamEvent, ToolTurn};
use crate::ai::session::SessionSlot;
use crate::ai::tools::ToolDef;
use crate::ai::{AiError, AiProvider, ChatMessage, ChatRole};

use super::chat::{ChunkEvent, DoneEvent};

/// One non-streaming round-trip with bounded auto-retry for transient errors.
/// Used directly when a provider doesn't stream tool turns, and as the safe
/// fallback when a stream fails before emitting any content.
async fn complete_once_with_retry(
    provider: &Arc<dyn AiProvider>,
    history: &[ChatMessage],
    tools: &[ToolDef],
    opts: crate::ai::TurnOptions,
) -> Result<ToolTurn, AiError> {
    const MAX_RETRIES: u32 = 3;
    const BACKOFF_MS: [u64; 3] = [800, 2_000, 5_000];
    let mut attempt = 0u32;
    loop {
        match provider.complete_once(history, Some(tools), opts).await {
            Ok(t) => return Ok(t),
            Err(e) if is_retryable(&e) && attempt < MAX_RETRIES => {
                let wait = BACKOFF_MS[attempt as usize];
                attempt += 1;
                crate::log_chat!("error", "{} (retry {attempt}/{MAX_RETRIES} after {wait}ms)", e);
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Whether a provider error is worth auto-retrying. Transient infrastructure
/// failures (timeouts, upstream 5xx, rate limits) usually succeed on a retry;
/// errors needing user action (auth, bad model, context overflow, cancel) do
/// not and should fail fast.
fn is_retryable(e: &AiError) -> bool {
    match e {
        AiError::NetworkTimeout => true,
        AiError::RateLimit(_) => true,
        // Upstream 5xx are transient server-side; 4xx (in the message) are not.
        AiError::Upstream(msg) => {
            msg.contains("HTTP 5")
                || msg.contains("502")
                || msg.contains("503")
                || msg.contains("504")
                || msg.contains("overloaded")
                || msg.contains("timeout")
        }
        _ => false,
    }
}

/// Tool-loop path. Non-streaming: we round-trip with `complete_once`,
/// execute any tool calls the model asks for, and loop until the model
/// returns a plain-text reply. Once we have that reply, we emit it as one
/// chunk + done so the frontend's existing streaming code picks it up.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_tool_loop(
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
    provider: Arc<dyn AiProvider>,
    request_id: String,
    connection_id: String,
    schema: Option<String>,
    max_iterations: u32,
    max_repeat_calls: u32,
    turn_opts: crate::ai::TurnOptions,
) -> Result<(), AiError> {
    use crate::ai::tools;
    // Filter the tool catalog by the current scope: when cross-database access
    // is off, `list_schemas` is dropped so the model can't enumerate or loop on
    // databases it isn't allowed to reach (it already knows the active one).
    // EXCEPT for Postgres-style adapters (database ≠ schema) where list_schemas
    // lists schemas inside the active DB — there it stays so the model can
    // discover what it can query.
    let cross_db = auto_approvals.get().await.cross_database;
    // `database_is_schema` is true when a "schema" IS a database (MySQL/SQLite).
    // Only Postgres models the database as distinct from its (many) schemas, so
    // key off the dialect — NOT `database_picker` (MySQL sets that too). Default
    // to `true` (conservative MySQL behavior) if the adapter can't be resolved.
    let database_is_schema = match db_registry.manifest(&connection_id).await {
        Ok(m) => !matches!(
            m.capabilities.sql_dialect,
            adapter_api::SqlDialect::Postgres
        ),
        Err(_) => true,
    };
    let tools_catalog = tools::catalog_scoped(cross_db, database_is_schema);
    let tool_ctx = tools::ToolContext {
        connection_id: connection_id.clone(),
        default_schema: schema.clone(),
    };

    // Loop-guard: some models retry a tool with identical args over and over —
    // either an erroring `find()` that keeps failing, OR a *successful* call
    // they keep re-issuing without ever moving on (the "Hi" doom-loop on weak
    // models). Track consecutive identical `(name::arguments)` calls REGARDLESS
    // of success/failure and bail early with a clear message instead of
    // spinning to `max_iterations`. Reset only when the model issues a
    // genuinely different call.
    let mut last_call_sig: Option<String> = None;
    let mut repeat_calls: u32 = 0;
    // Per-turn cache of read-only shape tools (`list_schemas`, `list_tables`,
    // `describe_table`) that already returned successfully. Weak models love to
    // re-call these with identical args dozens of times, ignoring the result,
    // until the request times out. Since the shape can't change mid-turn,
    // re-running is pure waste — we short-circuit a duplicate with a directive
    // telling the model it already has the data and to proceed. This is scoped
    // to read-only tools so legitimate repeats of `call_query` are unaffected.
    use std::collections::HashSet;
    let mut shape_calls_seen: HashSet<String> = HashSet::new();
    fn is_shape_tool(name: &str) -> bool {
        matches!(name, "list_schemas" | "list_tables" | "describe_table")
    }
    for _iter in 0..max_iterations {
        // Snapshot history under a read lock. We re-snapshot every
        // iteration because tool results append new messages.
        let history = {
            let guard = slot.read().await;
            let Some(session) = guard.as_ref() else {
                return Err(AiError::NoActiveSession);
            };
            with_system_prompt(
                &session.messages,
                session.provider_kind.as_str(),
                &session.model,
                session.current_context.as_deref(),
                session.recent_activity.as_deref(),
            )
        };

        // Acquire the next turn. Prefer streaming so the user sees tokens live;
        // fall back to a non-streaming round-trip (with retry) when the provider
        // doesn't stream tool turns or the stream fails before emitting anything.
        // A transient blip shouldn't kill the whole turn — `complete_once_with_retry`
        // backs off and retries retryable errors (timeouts, 5xx, rate limit);
        // non-retryable errors (auth, bad model, cancel) fail fast.
        //
        // `streamed` tracks whether content reached the UI as deltas, so the
        // final-answer block below doesn't re-emit it as a duplicate chunk.
        let mut streamed = false;
        let turn = match provider
            .complete_once_stream(&history, Some(&tools_catalog), turn_opts)
            .await
        {
            Ok(Some(mut stream)) => {
                let mut done_turn: Option<ToolTurn> = None;
                let mut emitted = false;
                let mut stream_err: Option<AiError> = None;
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(ToolStreamEvent::Delta(delta)) => {
                            if !delta.is_empty() {
                                emitted = true;
                                let _ = app.emit(
                                    "ai://chat/chunk",
                                    ChunkEvent {
                                        request_id: request_id.clone(),
                                        delta,
                                    },
                                );
                            }
                        }
                        Ok(ToolStreamEvent::Done(t)) => done_turn = Some(t),
                        Err(e) => {
                            stream_err = Some(e);
                            break;
                        }
                    }
                }
                // A stream is only trustworthy if it produced a real turn:
                // some content, or a tool call. A `Done` with nothing AND no
                // deltas means the endpoint accepted `stream:true` but returned
                // an empty/non-SSE body (some "OpenAI-compatible" proxies do
                // this) — treat it like an unsupported stream and fall back.
                let usable = done_turn.as_ref().is_some_and(|t| {
                    emitted || !t.content.is_empty() || !t.tool_calls.is_empty()
                });
                if usable {
                    streamed = true;
                    done_turn.expect("usable implies Some")
                } else {
                    if let Some(e) = &stream_err {
                        crate::log_chat!("error", "stream failed ({e}); falling back to non-streaming");
                    } else {
                        crate::log_chat!("error", "stream produced no usable output; falling back to non-streaming");
                    }
                    // Safe regardless of any partial deltas already shown: the
                    // frontend reconciles the bubble to `done.content` (and
                    // finalizes cleanly on error), so a transient partial never
                    // persists. Falling back keeps a flaky/incompatible stream
                    // from failing a turn the non-streaming path can complete.
                    complete_once_with_retry(&provider, &history, &tools_catalog, turn_opts).await?
                }
            }
            // Provider doesn't stream tool turns → non-streaming with retry.
            Ok(None) => complete_once_with_retry(&provider, &history, &tools_catalog, turn_opts).await?,
            // Pre-stream failure (auth/HTTP/etc.) → degrade to the non-streaming
            // path, which applies retry for transient errors and surfaces the
            // rest unchanged.
            Err(e) => {
                crate::log_chat!("error", "stream setup failed, falling back to non-streaming: {e}");
                complete_once_with_retry(&provider, &history, &tools_catalog, turn_opts).await?
            }
        };

        if turn.tool_calls.is_empty() {
            // Final answer. Commit + emit done. If we streamed the content as
            // deltas already, skip the one-shot chunk (the frontend reconciles
            // the bubble to `done.content` regardless); otherwise emit it as a
            // single chunk so the non-streaming path still renders.
            let content = turn.content.clone();
            crate::log_chat!("assistant", "{}", content);
            {
                let mut guard = slot.write().await;
                if let Some(session) = guard.as_mut() {
                    session
                        .messages
                        .push(ChatMessage::text(ChatRole::Assistant, content.clone()));
                }
            }
            if !streamed {
                let _ = app.emit(
                    "ai://chat/chunk",
                    ChunkEvent {
                        request_id: request_id.clone(),
                        delta: content.clone(),
                    },
                );
            }
            let _ = app.emit(
                "ai://chat/done",
                DoneEvent {
                    request_id,
                    content,
                    finish_reason: Some("stop"),
                },
            );
            return Ok(());
        }

        // Model wants tools. Commit the assistant turn (with tool_calls) to
        // history so the next round-trip includes it, then execute each
        // tool, commit the tool result messages, and loop.
        {
            let mut guard = slot.write().await;
            if let Some(session) = guard.as_mut() {
                session.messages.push(crate::ai::ChatMessage {
                    role: ChatRole::Assistant,
                    content: turn.content.clone(),
                    tool_calls: turn.tool_calls.clone(),
                    tool_call_id: None,
                });
            }
        }

        // Let the UI render a tool-call card per call so the user sees the
        // model "thinking out loud." These events are advisory; the chat
        // bubble renders from `session.messages` on the frontend after done.
        for tc in &turn.tool_calls {
            crate::log_chat!("tool_call", "{}({})", tc.name, tc.arguments);
            let _ = app.emit(
                "ai://tool/call_started",
                serde_json::json!({
                    "request_id": request_id,
                    "tool_call_id": tc.id,
                    "name": tc.name,
                    "arguments": tc.arguments,
                }),
            );
        }

        // Execute each tool call sequentially. Keeps the code simple and
        // makes the approval UI for `call_query` easier to reason about.
        for tc in &turn.tool_calls {
            let sig = format!("{}::{}", tc.name, tc.arguments);
            // Short-circuit a repeated read-only shape call: the model already
            // got this exact result this turn, so hand back a directive instead
            // of re-querying. Saves the round-trip and nudges it to move on.
            let result = if is_shape_tool(&tc.name) && shape_calls_seen.contains(&sig) {
                tools::ToolResult::directive(format!(
                    "You already called `{}` with these arguments this turn and have the \
                     result above. Do NOT call it again — use that data now to answer or to \
                     call `call_query`/`describe_table` for the next concrete step.",
                    tc.name
                ))
            } else {
                let approvals_arc = approvals.inner().clone();
                let auto_arc = auto_approvals.inner().clone();
                let db_arc = db_registry.inner().clone();
                let r = tools::dispatch(
                    &db_arc,
                    &approvals_arc,
                    &auto_arc,
                    &app,
                    &tool_ctx,
                    &tc.id,
                    &tc.name,
                    &tc.arguments,
                )
                .await;
                // Remember successful shape calls so the next identical one is
                // short-circuited above. Errors aren't cached — a retry might
                // legitimately succeed.
                if is_shape_tool(&tc.name) && !r.is_error {
                    shape_calls_seen.insert(sig.clone());
                }
                r
            };
            crate::log_chat!(
                "tool_result",
                "{} => {}",
                tc.name,
                result.content.chars().take(400).collect::<String>()
            );

            // Commit the tool-result message, which the next model turn
            // will see via `complete_once`.
            {
                let mut guard = slot.write().await;
                if let Some(session) = guard.as_mut() {
                    session.messages.push(crate::ai::ChatMessage {
                        role: ChatRole::Tool,
                        content: result.content.clone(),
                        tool_calls: Vec::new(),
                        tool_call_id: Some(tc.id.clone()),
                    });
                }
            }

            let _ = app.emit(
                "ai://tool/call_finished",
                serde_json::json!({
                    "request_id": request_id,
                    "tool_call_id": tc.id,
                    "result": result.content,
                }),
            );

            // Loop-guard: count consecutive identical `(name::arguments)`
            // calls — whether they errored or succeeded. A model stuck
            // re-issuing the same successful read (the greeting doom-loop) is
            // just as wedged as one retrying a failing `find()`. After
            // MAX_REPEAT_CALLS, stop and emit a readable message so the UI's
            // "Thinking…" bubble resolves instead of spinning to the cap.
            // (`sig` was computed above for the shape-tool short-circuit.)
            let errored = result.is_error;
            if last_call_sig.as_deref() == Some(sig.as_str()) {
                repeat_calls += 1;
            } else {
                last_call_sig = Some(sig.clone());
                repeat_calls = 1;
            }
            // Read-only shape tools never need to be re-run with identical args
            // (the shape can't change mid-turn). The dedup short-circuit above
            // already hands back a cheap "you have this, proceed" directive from
            // the 2nd identical call on — no DB round-trip — so we can afford to
            // let a weak model see that nudge a few times and course-correct
            // before killing the whole turn. Cap of 3 was too tight: a model
            // that re-listed schemas twice after a good result had its entire
            // request (e.g. "analyze this db and make dummy data") aborted. 10
            // gives ~8 dedup nudges to recover while still bounding the loop —
            // the dedup short-circuit makes each repeat cheap (no DB round-trip),
            // so a higher cap costs tokens but not latency.
            const SHAPE_REPEAT_CAP: u32 = 10;
            // The SAME `call_query` with byte-identical args returns the same
            // rows every time — re-issuing it is never progress. Weak models do
            // this dozens of times; with the old budget of 50 the upstream HTTP
            // request times out ("network timeout") long before the guard fires,
            // so the user sees a network error instead of a clean "I looped".
            // Cap identical query repeats low. (A model that needs to retry with
            // DIFFERENT SQL resets the counter — only byte-identical repeats
            // count, so legitimate iterative querying is unaffected.)
            const CALL_QUERY_REPEAT_CAP: u32 = 4;
            let effective_cap = if is_shape_tool(&tc.name) {
                max_repeat_calls.min(SHAPE_REPEAT_CAP)
            } else if tc.name == "call_query" {
                max_repeat_calls.min(CALL_QUERY_REPEAT_CAP)
            } else {
                max_repeat_calls
            };
            if repeat_calls >= effective_cap {
                crate::log_chat!(
                    "error",
                    "tool loop aborted: `{}` called {} times with identical args (errored={})",
                    tc.name,
                    repeat_calls,
                    errored
                );
                let msg = if errored {
                    format!(
                        "I tried `{}` {} times with the same arguments and it kept failing, so I stopped to avoid looping. Last error: {}",
                        tc.name, repeat_calls, result.content
                    )
                } else {
                    format!(
                        "I kept calling `{}` with the same arguments without making progress, so I stopped to avoid looping. Try rephrasing your request, or ask me something more specific.",
                        tc.name
                    )
                };
                {
                    let mut guard = slot.write().await;
                    if let Some(session) = guard.as_mut() {
                        session.messages.push(crate::ai::ChatMessage {
                            role: ChatRole::Assistant,
                            content: msg.clone(),
                            tool_calls: Vec::new(),
                            tool_call_id: None,
                        });
                    }
                }
                let _ = app.emit(
                    "ai://chat/chunk",
                    ChunkEvent {
                        request_id: request_id.clone(),
                        delta: msg.clone(),
                    },
                );
                let _ = app.emit(
                    "ai://chat/done",
                    DoneEvent {
                        request_id,
                        content: msg,
                        finish_reason: Some("error"),
                    },
                );
                return Ok(());
            }
        }
        // Loop: model gets another round.
    }

    // Hit the iteration cap. Emit a failure message so the chat doesn't hang.
    let fallback = format!(
        "I used all {max_iterations} of my allowed tool-calling steps for this turn without reaching a final answer. \
         This usually means the request needs to be broken into smaller asks, or the model is over-exploring. \
         Try a more specific question — or raise “Max tool steps” in Settings → AI if this model needs more room."
    );
    {
        let mut guard = slot.write().await;
        if let Some(session) = guard.as_mut() {
            session
                .messages
                .push(ChatMessage::text(ChatRole::Assistant, fallback.clone()));
        }
    }
    let _ = app.emit(
        "ai://chat/chunk",
        ChunkEvent {
            request_id: request_id.clone(),
            delta: fallback.clone(),
        },
    );
    let _ = app.emit(
        "ai://chat/done",
        DoneEvent {
            request_id,
            content: fallback,
            finish_reason: Some("length"),
        },
    );
    Ok(())
}

/// Prepend the static system prompt in front of the session's message
/// history. The prompt itself is not persisted in `session.messages` —
/// re-injecting it on every turn via this helper keeps the stored
/// transcript clean (no ~1KB of rules per user turn in the chat log) and
/// always ships the latest rules to the model even if we tweak them.
pub(super) fn with_system_prompt(
    history: &[ChatMessage],
    provider: &str,
    model: &str,
    context: Option<&str>,
    recent_activity: Option<&str>,
) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(history.len() + 3);
    out.push(ChatMessage::text(
        ChatRole::System,
        crate::ai::context::system_prompt(provider, model),
    ));
    // Schema context as a SECOND system message, re-added every turn so it stays
    // adjacent to the prompt + the latest user turn (not lost deep in history).
    if let Some(ctx) = context.filter(|c| !c.trim().is_empty()) {
        out.push(ChatMessage::text(ChatRole::System, ctx.to_string()));
    }
    // Recent query activity (ok + errors). Lets the model see what just ran and
    // propose a fix / retry when a query failed. Re-added per turn (it changes).
    if let Some(act) = recent_activity.filter(|a| !a.trim().is_empty()) {
        out.push(ChatMessage::text(
            ChatRole::System,
            format!(
                "Recent queries run in this connection (most recent last). Use this to \
                 diagnose failures and offer a corrected query or retry when one errored:\n\n{act}"
            ),
        ));
    }
    out.extend(repair_orphan_tool_calls(history));
    out
}

/// Defensive history sanitizer. OpenAI (and compatible APIs) reject any
/// request where an assistant message carrying `tool_calls` is not
/// followed by a `tool` message for each `tool_call_id`. The tool loop
/// commits the assistant turn first and the tool replies after — if
/// the loop is interrupted between those steps (cancel, panic, the
/// session being ended mid-flight, or a race with a concurrent send
/// that interleaves an unrelated user message), the persisted history
/// is left malformed and every subsequent send fails with HTTP 400.
///
/// Rather than try to prevent every interruption shape, normalise on
/// the way out: for each assistant turn with `tool_calls`, ensure each
/// id has a matching `tool` message somewhere in the immediately
/// following block of tool replies. Any missing id gets a synthetic
/// "(no result — call did not complete)" reply inserted right after
/// the assistant turn so the wire format is valid and the conversation
/// can continue.
fn repair_orphan_tool_calls(history: &[ChatMessage]) -> Vec<ChatMessage> {
    use std::collections::HashSet;
    let mut out: Vec<ChatMessage> = Vec::with_capacity(history.len());
    let mut i = 0;
    while i < history.len() {
        let m = &history[i];
        if matches!(m.role, ChatRole::Assistant) && !m.tool_calls.is_empty() {
            out.push(m.clone());
            // Ids the assistant turn declared — anything else in the
            // following tool-message block is an orphan from a partial
            // / interrupted prior turn and would make OpenAI reject the
            // request with "tool_call_id ... not found in tool_calls of
            // previous message". Drop those.
            let needed_set: HashSet<String> = m.tool_calls.iter().map(|c| c.id.clone()).collect();
            let mut seen: HashSet<String> = HashSet::new();
            let mut j = i + 1;
            while j < history.len() && matches!(history[j].role, ChatRole::Tool) {
                let id_opt = history[j].tool_call_id.as_deref().map(str::to_string);
                let keep = id_opt
                    .as_ref()
                    .map(|id| needed_set.contains(id) && !seen.contains(id))
                    .unwrap_or(false);
                if keep {
                    if let Some(id) = id_opt {
                        seen.insert(id);
                    }
                    out.push(history[j].clone());
                }
                j += 1;
            }
            // Backfill any declared id that didn't get a reply, so the
            // turn is well-formed for the API.
            for id in needed_set.iter() {
                if !seen.contains(id) {
                    out.push(crate::ai::ChatMessage {
                        role: ChatRole::Tool,
                        content: "(no result — call did not complete)".into(),
                        tool_calls: Vec::new(),
                        tool_call_id: Some(id.clone()),
                    });
                }
            }
            i = j;
        } else if matches!(m.role, ChatRole::Tool) {
            // Stray tool message with no preceding assistant tool_calls
            // turn — drop it. OpenAI rejects tool messages that don't
            // chain back to a tool_calls assistant turn.
            i += 1;
        } else {
            out.push(m.clone());
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod history_sanitizer_tests {
    use super::*;
    use crate::ai::{ChatMessage, ChatRole, ToolCall};

    fn assistant_with_calls(ids: &[&str]) -> ChatMessage {
        ChatMessage {
            role: ChatRole::Assistant,
            content: String::new(),
            tool_calls: ids
                .iter()
                .map(|id| ToolCall {
                    id: (*id).into(),
                    name: "x".into(),
                    arguments: "{}".into(),
                })
                .collect(),
            tool_call_id: None,
        }
    }
    fn tool(id: &str) -> ChatMessage {
        ChatMessage {
            role: ChatRole::Tool,
            content: "ok".into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(id.into()),
        }
    }

    #[test]
    fn passes_through_well_formed_history() {
        let h = vec![
            ChatMessage::text(ChatRole::User, "hi"),
            assistant_with_calls(&["a"]),
            tool("a"),
            ChatMessage::text(ChatRole::Assistant, "done"),
        ];
        let out = repair_orphan_tool_calls(&h);
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn backfills_missing_tool_reply() {
        let h = vec![
            assistant_with_calls(&["a"]),
            ChatMessage::text(ChatRole::User, "never mind"),
        ];
        let out = repair_orphan_tool_calls(&h);
        assert_eq!(out.len(), 3, "synthetic tool reply inserted before user");
        assert!(matches!(out[0].role, ChatRole::Assistant));
        assert!(matches!(out[1].role, ChatRole::Tool));
        assert_eq!(out[1].tool_call_id.as_deref(), Some("a"));
        assert!(matches!(out[2].role, ChatRole::User));
    }

    #[test]
    fn backfills_partial_replies() {
        let h = vec![
            assistant_with_calls(&["a", "b"]),
            tool("a"),
            ChatMessage::text(ChatRole::User, "next"),
        ];
        let out = repair_orphan_tool_calls(&h);
        assert_eq!(out.len(), 4);
        assert_eq!(out[2].tool_call_id.as_deref(), Some("b"));
    }

    #[test]
    fn drops_tool_with_id_not_in_assistant_calls() {
        // Real-world case from logs: a stray tool reply for an id the
        // preceding assistant turn never declared (left over from a
        // partial earlier turn). OpenAI rejects this with
        // "tool_call_id of 'X' not found in tool_calls of previous
        // message"; we drop it so the request is well-formed.
        let h = vec![
            assistant_with_calls(&["a"]),
            tool("a"),
            tool("ghost"),
            ChatMessage::text(ChatRole::User, "next"),
        ];
        let out = repair_orphan_tool_calls(&h);
        assert_eq!(out.len(), 3);
        assert!(matches!(out[0].role, ChatRole::Assistant));
        assert_eq!(out[1].tool_call_id.as_deref(), Some("a"));
        assert!(matches!(out[2].role, ChatRole::User));
    }

    #[test]
    fn drops_standalone_tool_message() {
        let h = vec![
            ChatMessage::text(ChatRole::User, "hi"),
            tool("ghost"),
            ChatMessage::text(ChatRole::Assistant, "ok"),
        ];
        let out = repair_orphan_tool_calls(&h);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0].role, ChatRole::User));
        assert!(matches!(out[1].role, ChatRole::Assistant));
    }
}
