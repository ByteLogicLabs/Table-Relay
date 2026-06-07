//! Chat-send command and the legacy streaming path. The tool-calling loop
//! lives in the sibling `tool_loop` module.

use std::sync::Arc;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::ai::session::SessionSlot;
use crate::ai::{session, AiError, ChatMessage, ChatRole, CompletionRequest};

use super::tool_loop::{run_tool_loop, with_system_prompt};
use super::{DEFAULT_AI_MAX_TOKENS, DEFAULT_MAX_REPEAT_CALLS, DEFAULT_MAX_TOOL_ITERATIONS};

#[derive(Debug, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ChatKind {
    #[default]
    Chat,
    Fix,
    Explain,
    Generate,
}

#[derive(Debug, Deserialize)]
pub struct ChatSendInput {
    pub request_id: String,
    pub content: String,
    /// Optional: the active DB connection and schema the user is looking at.
    /// When present, the first turn of the session auto-prepends a system
    /// message describing that schema (tables / columns / FKs) so the model
    /// can answer questions about the data shape without being told explicitly.
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    /// Optional pointer to the specific tab/object the user has open. Lets
    /// the model answer "check this function" without a paste. Separate from
    /// `schema` because the *schema* context is an always-loaded summary
    /// while `focus` is the thing-being-looked-at right now.
    #[serde(default)]
    pub focus: Option<FocusHint>,
    /// Shortcut mode — when not `chat`, the backend wraps `content` / `sql` /
    /// `error_message` in a fixed preamble so the model receives a Fix /
    /// Explain / Generate request with consistent phrasing.
    #[serde(default)]
    pub kind: ChatKind,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    /// Optional cap on tool-calling rounds for this turn (from the user's
    /// AI settings). Falls back to `DEFAULT_MAX_TOOL_ITERATIONS` when absent
    /// or out of the sane [1, 50] range.
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Optional cap on consecutive *identical* tool calls before the loop-guard
    /// stops the turn (from the user's AI settings). Falls back to
    /// `DEFAULT_MAX_REPEAT_CALLS` when absent or out of the sane [1, 50] range.
    #[serde(default)]
    pub max_repeat_calls: Option<u32>,
}

/// What the user is currently looking at. Informs the system-context blob —
/// if the user asks "what does this do?" we can answer from the focused
/// object instead of asking what "this" means.
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FocusHint {
    /// A query tab with some SQL in its buffer. `sql` is sent as-is — we
    /// don't pre-parse or trim; the model sees exactly what the user sees.
    Query { sql: String },
    /// A routine or view tab. The backend re-fetches the body via
    /// `describe_routine` so edits the user made but hasn't saved yet
    /// don't leak through.
    Routine {
        schema: String,
        name: String,
        kind: String,
    },
    /// A data / structure tab focused on a specific table. The schema-context
    /// already lists every table; this just marks which one is active so the
    /// model doesn't have to guess which table "this" refers to.
    Table { schema: String, name: String },
    /// A realtime pub/sub tab. `pattern` is the channel/glob the user has
    /// typed into the subscribe input (possibly empty). The adapter primer
    /// carries the syntactical rules (NOTIFY vs PUBLISH, wildcards, etc.).
    Realtime {
        pattern: String,
        #[serde(default)]
        is_running: bool,
        #[serde(default)]
        recent_channels: Vec<String>,
    },
}

impl FocusHint {
    /// Stable key used to decide whether the schema-context message needs to
    /// be re-injected. Tab switches within the same schema refresh the
    /// context so the model sees the new focus on the very next turn.
    fn cache_key(&self) -> String {
        match self {
            FocusHint::Query { sql } => {
                // Hash the buffer rather than storing it verbatim — the key
                // lives on the session struct, no need to keep a copy of the
                // whole editor buffer there.
                let mut h: u64 = 1469598103934665603;
                for b in sql.bytes() {
                    h = h.wrapping_mul(1099511628211).wrapping_add(b as u64);
                }
                format!("query:{h:x}")
            }
            FocusHint::Routine { schema, name, kind } => {
                format!("routine:{schema}.{name}:{kind}")
            }
            FocusHint::Table { schema, name } => format!("table:{schema}.{name}"),
            FocusHint::Realtime {
                pattern,
                is_running,
                ..
            } => {
                format!("realtime:{pattern}:{is_running}")
            }
        }
    }
}

fn assemble_user_turn(input: &ChatSendInput) -> String {
    match input.kind {
        ChatKind::Chat => input.content.clone(),
        ChatKind::Fix => {
            let sql = input.sql.as_deref().unwrap_or(&input.content);
            let err = input
                .error_message
                .as_deref()
                .unwrap_or("(no error message)");
            format!(
                "The following SQL failed with an error. Diagnose the cause and return a \
                corrected version in a single fenced ```sql block. Keep the fix minimal \
                and preserve the original intent.\n\n\
                Error:\n{err}\n\nSQL:\n```sql\n{sql}\n```"
            )
        }
        ChatKind::Explain => {
            let sql = input.sql.as_deref().unwrap_or(&input.content);
            format!(
                "Explain what this SQL does in plain English. Call out any joins, \
                filters, aggregations, or potential gotchas. Be concise.\n\n\
                ```sql\n{sql}\n```"
            )
        }
        ChatKind::Generate => {
            let schema_hint = input
                .schema
                .as_deref()
                .map(|s| format!(" The current database is `{s}`."))
                .unwrap_or_default();
            format!(
                "Generate SQL for this request.{schema_hint} Return a single fenced \
                ```sql block; add a brief one-line explanation above it if helpful.\n\n\
                Request: {}",
                input.content
            )
        }
    }
}

/// Append the user turn, stream tokens to the UI, append the assistant turn
/// when done. Events:
///   `ai://chat/chunk` — `{ request_id, delta }`
///   `ai://chat/done`  — `{ request_id, content, finish_reason }`
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat_send(
    input: ChatSendInput,
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
    mcp_slot: State<'_, crate::ai::mcp_bridge::McpBridgeSlot>,
) -> Result<(), AiError> {
    // Keep the MCP bridge pointed at the connection/schema the user is looking
    // at, so any DB tool a wrapped CLI calls runs against the right database.
    if let Some(bridge) = mcp_slot.read().await.as_ref() {
        bridge
            .set_context(
                input.connection_id.clone(),
                input.schema.clone(),
                Some(input.request_id.clone()),
            )
            .await;
    }
    let result = ai_chat_send_inner(input, app, slot, db_registry, approvals, auto_approvals).await;
    if let Err(e) = &result {
        crate::log_chat!("error", "{e}");
    }
    result
}

async fn ai_chat_send_inner(
    input: ChatSendInput,
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<(), AiError> {
    // Serialise sends per-session. Without this, a quick second send
    // can interleave a User message between an assistant-with-tool_calls
    // turn and its Tool replies, which the OpenAI wire format rejects
    // ("tool_call_ids did not have response messages") on every
    // subsequent call. The lock is per-session so different sessions
    // (rare today, but possible if the slot model grows) don't block
    // each other.
    let send_lock = {
        let guard = slot.read().await;
        let session = guard.as_ref().ok_or(AiError::NoActiveSession)?;
        session.send_lock.clone()
    };
    let _send_guard = send_lock.lock().await;

    // Schema context is (re-)injected whenever the user's focused
    // connection/schema/tab fingerprint changes. We key on
    // `"<conn_id>|<schema>|<focus>"` so switching tabs (even within the
    // same database) triggers a refresh, while staying on the same tab
    // skips the re-build (which is the hot path).
    let new_context_key: Option<String> = input.connection_id.as_deref().map(|cid| {
        let schema_part = input.schema.as_deref().unwrap_or("");
        let focus_part = input
            .focus
            .as_ref()
            .map(FocusHint::cache_key)
            .unwrap_or_default();
        format!("{cid}|{schema_part}|{focus_part}")
    });
    let needs_context = {
        let guard = slot.read().await;
        let Some(session) = guard.as_ref() else {
            return Err(AiError::NoActiveSession);
        };
        match (&session.last_context_key, &new_context_key) {
            (_, None) => false,           // no focus → nothing to inject
            (None, Some(_)) => true,      // first turn with a focus
            (Some(a), Some(b)) => a != b, // user switched tabs
        }
    };

    let system_context: Option<String> = if needs_context {
        match input.connection_id.as_deref() {
            Some(conn_id) => {
                match crate::ai::context::build(
                    db_registry.inner(),
                    conn_id,
                    input.schema.as_deref(),
                    input.focus.as_ref(),
                )
                .await
                {
                    Ok(text) => Some(text),
                    Err(e) => {
                        // Don't fail the chat over a context-build hiccup — the
                        // user can still have a conversation, just without
                        // auto-injected schema awareness.
                        crate::log_line!("ai_context", "failed to build schema context: {e}");
                        None
                    }
                }
            }
            None => None,
        }
    } else {
        None
    };

    let user_turn = assemble_user_turn(&input);

    // Transcript logging — one user line per turn. Assistant + tool turns
    // are logged from the paths that produce them below.
    crate::log_chat!("user", "{}", user_turn);

    // Append system (if needed) + user turn. Snapshot provider for the
    // tool-path decision.
    let (provider, tool_mode) = {
        let mut guard = slot.write().await;
        let Some(session) = guard.as_mut() else {
            return Err(AiError::NoActiveSession);
        };
        if let Some(ctx) = system_context {
            // If this is a *switch* rather than the first injection, frame it
            // explicitly so the model understands the focus has changed. The
            // older context stays in history — cheaper than rewriting and the
            // model handles this fine.
            let framed = if session.last_context_key.is_some() {
                format!("The user has switched to a new database view. Use this updated context going forward.\n\n{ctx}")
            } else {
                ctx
            };
            crate::log_chat!("system", "{}", framed.chars().take(400).collect::<String>());
            session
                .messages
                .push(ChatMessage::text(ChatRole::System, framed));
            session.last_context_key = new_context_key.clone();
        }
        session
            .messages
            .push(ChatMessage::text(ChatRole::User, user_turn));
        let tool_mode = session.provider.supports_tools() && input.connection_id.is_some();
        (session.provider.clone(), tool_mode)
    };

    if tool_mode {
        // Clamp the user-configured caps into a sane range; fall back to
        // defaults. The frontend uses `UNLIMITED` (1000) to mean "no practical
        // limit"; we accept up to that ceiling so the loop still has a hard
        // backstop against a genuinely runaway model.
        let max_iterations = input
            .max_iterations
            .filter(|n| (1..=1000).contains(n))
            .unwrap_or(DEFAULT_MAX_TOOL_ITERATIONS);
        let max_repeat_calls = input
            .max_repeat_calls
            .filter(|n| (1..=1000).contains(n))
            .unwrap_or(DEFAULT_MAX_REPEAT_CALLS);
        return run_tool_loop(
            app,
            slot,
            db_registry,
            approvals,
            auto_approvals,
            provider,
            input.request_id,
            input.connection_id.expect("checked above"),
            input.schema,
            max_iterations,
            max_repeat_calls,
        )
        .await;
    }

    // Legacy streaming path for providers without tool support (Anthropic,
    // Gemini, Echo) or sessions without a DB context.
    let history = {
        let guard = slot.read().await;
        let Some(session) = guard.as_ref() else {
            return Err(AiError::NoActiveSession);
        };
        with_system_prompt(
            &session.messages,
            session.provider_kind.as_str(),
            &session.model,
        )
    };

    let req = CompletionRequest {
        request_id: input.request_id.clone(),
        messages: history,
        max_tokens: Some(DEFAULT_AI_MAX_TOKENS),
        temperature: None,
        stop: None,
    };

    let mut stream = provider.complete(req).await?;
    let mut full = String::new();
    let mut finish: Option<crate::ai::FinishReason> = None;

    while let Some(chunk) = stream.next().await {
        full.push_str(&chunk.delta);
        if chunk.finish_reason.is_some() {
            finish = chunk.finish_reason;
        }
        // Fire-and-forget — UI failures shouldn't kill the stream.
        let _ = app.emit(
            "ai://chat/chunk",
            ChunkEvent {
                request_id: chunk.request_id,
                delta: chunk.delta,
            },
        );
    }

    crate::log_chat!("assistant", "{}", full);

    // Commit assistant turn back onto the session — but only if it's still
    // the same session that started the request. If the user ended the chat
    // mid-stream, the session slot is already empty; drop the reply silently.
    {
        let mut guard = slot.write().await;
        if let Some(session) = guard.as_mut() {
            session
                .messages
                .push(ChatMessage::text(ChatRole::Assistant, full.clone()));
        }
    }

    let _ = app.emit(
        "ai://chat/done",
        DoneEvent {
            request_id: input.request_id,
            content: full,
            finish_reason: finish.map(|f| match f {
                crate::ai::FinishReason::Stop => "stop",
                crate::ai::FinishReason::Length => "length",
                crate::ai::FinishReason::Canceled => "canceled",
                crate::ai::FinishReason::Error => "error",
            }),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_stop(request_id: String, slot: State<'_, SessionSlot>) -> Result<(), AiError> {
    let provider = session::require_provider(&slot).await?;
    provider.cancel(&request_id).await;
    Ok(())
}

/// One restored message for [`ai_restore_messages`].
#[derive(Debug, Deserialize)]
pub struct RestoreMessage {
    pub role: String,
    pub content: String,
}

/// Repopulate the backend session transcript from a saved conversation.
///
/// Loading a conversation in the UI only rebuilt the *frontend* bubbles — the
/// backend `session.messages` stayed empty, so the next turn was sent with ZERO
/// prior context. Every provider was affected, but it's most glaring on the
/// stateless CLIs (claude/codex/gemini/opencode), which get the whole transcript
/// flattened into one prompt: continuing a loaded chat made the model reply
/// "I don't see a prior attempt in this conversation."
///
/// We restore only user/assistant TEXT turns. Tool turns are intentionally
/// dropped: in-app tool calls carry provider-specific `tool_call_id` linkage
/// that would need exact reconstruction to stay wire-valid, and CLI tool calls
/// happen out-of-band over MCP (never in `session.messages` to begin with). The
/// text transcript is what gives the model conversational memory.
#[tauri::command]
pub async fn ai_restore_messages(
    messages: Vec<RestoreMessage>,
    slot: State<'_, SessionSlot>,
) -> Result<(), AiError> {
    let mut guard = slot.write().await;
    let Some(session) = guard.as_mut() else {
        return Err(AiError::NoActiveSession);
    };
    let restored: Vec<ChatMessage> = messages
        .into_iter()
        .filter_map(|m| {
            let role = match m.role.as_str() {
                "user" => ChatRole::User,
                "assistant" => ChatRole::Assistant,
                // Skip tool/system turns — see the doc comment.
                _ => return None,
            };
            if m.content.trim().is_empty() {
                return None;
            }
            Some(ChatMessage::text(role, m.content))
        })
        .collect();
    crate::log_line!("ai", "restored {} messages into session", restored.len());
    session.messages = restored;
    // Force a fresh schema-context injection on the next turn (the restored
    // transcript has no context fingerprint).
    session.last_context_key = None;
    Ok(())
}

#[derive(Serialize, Clone)]
pub(super) struct ChunkEvent {
    pub request_id: String,
    pub delta: String,
}

#[derive(Serialize, Clone)]
pub(super) struct DoneEvent {
    pub request_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<&'static str>,
}
