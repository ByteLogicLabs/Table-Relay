//! The tool-calling loop and the conversation-history helpers it shares with
//! the streaming chat path.

use std::sync::Arc;

use tauri::{Emitter, State};

use crate::ai::session::SessionSlot;
use crate::ai::{AiError, AiProvider, ChatMessage, ChatRole};

use super::chat::{ChunkEvent, DoneEvent};

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
) -> Result<(), AiError> {
    use crate::ai::tools;
    // Filter the tool catalog by the current scope: when cross-database access
    // is off, `list_schemas` is dropped so the model can't enumerate or loop on
    // databases it isn't allowed to reach (it already knows the active one).
    let cross_db = auto_approvals.get().await.cross_database;
    let tools_catalog = tools::catalog_scoped(cross_db);
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
            with_system_prompt(&session.messages)
        };

        let turn = provider
            .complete_once(&history, Some(&tools_catalog))
            .await?;

        if turn.tool_calls.is_empty() {
            // Final answer. Commit + emit as one chunk + done.
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
            let _ = app.emit(
                "ai://chat/chunk",
                ChunkEvent {
                    request_id: request_id.clone(),
                    delta: content.clone(),
                },
            );
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
                if is_shape_tool(&tc.name) && !r.content.contains("\"error\"") {
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
            let errored = result.content.contains("\"error\"");
            if last_call_sig.as_deref() == Some(sig.as_str()) {
                repeat_calls += 1;
            } else {
                last_call_sig = Some(sig.clone());
                repeat_calls = 1;
            }
            // Read-only shape tools never need more than a couple identical
            // calls — abort them well before the (possibly large) generic cap so
            // a weak model can't burn the whole budget re-listing the same
            // tables. `call_query` keeps the full `max_repeat_calls` budget.
            const SHAPE_REPEAT_CAP: u32 = 3;
            let effective_cap = if is_shape_tool(&tc.name) {
                max_repeat_calls.min(SHAPE_REPEAT_CAP)
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
pub(super) fn with_system_prompt(history: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(history.len() + 2);
    out.push(ChatMessage::text(
        ChatRole::System,
        crate::ai::context::system_prompt().to_string(),
    ));
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
