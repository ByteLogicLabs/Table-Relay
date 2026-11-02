//! Chat-send command and the legacy streaming path. The tool-calling loop
//! lives in the sibling `tool_loop` module.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::ai::cancel::{CancelRegistry, CancelToken};
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
    /// Optional response token cap for this turn (from the effort preset).
    /// Falls back to `DEFAULT_AI_MAX_TOKENS` when absent or out of the sane
    /// [256, 200_000] range.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Optional reasoning/thinking effort for this turn (from the effort
    /// preset). Providers/models that don't support it ignore it.
    #[serde(default)]
    pub reasoning_effort: Option<crate::ai::ReasoningEffort>,
    /// Compact recent query-log for the focused connection (ok + errors),
    /// formatted by the frontend. Injected per-turn so the model can see what
    /// ran, diagnose failures, and offer a corrected query / retry.
    #[serde(default)]
    pub recent_query_log: Option<String>,
    /// Stream tokens live (true) or do one buffered round-trip and show the
    /// reply once complete (false). Defaults to true when absent so older
    /// callers keep the streaming behaviour.
    #[serde(default = "default_stream")]
    pub stream: bool,
    /// The panel keeps one transcript per connection but the backend session
    /// holds one. When the user sends from a different connection's chat than
    /// the previous turn, the frontend sends that chat's text history here and
    /// it replaces the session transcript before this turn runs — otherwise
    /// the model answered with another connection's conversation in mind.
    #[serde(default)]
    pub history: Option<Vec<RestoreMessage>>,
}

/// How long building the schema context may take before the turn goes ahead
/// without it (a slow or wedged server).
const CONTEXT_BUILD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Reply cap for the bundled llama-server (8k-token context).
const LLAMA_MAX_REPLY_TOKENS: u32 = 3_072;

fn default_stream() -> bool {
    true
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
    /// A trigger tab. The backend re-fetches the trigger's CREATE statement via
    /// `describe_trigger` so the model can read and edit the exact definition.
    Trigger { schema: String, name: String },
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
            FocusHint::Trigger { schema, name } => format!("trigger:{schema}.{name}"),
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
                "Explain what this SQL does in plain language. Call out any joins, \
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
    cancels: State<'_, Arc<CancelRegistry>>,
) -> Result<(), AiError> {
    // Stop for this turn trips `cancel`; the guard unregisters it however the
    // turn ends.
    let (cancel, _cancel_guard) = cancels.register(&input.request_id);
    let turn = ai_chat_send_inner(input, app, slot, db_registry, approvals, auto_approvals, mcp_slot, cancel);
    // Tauri doesn't catch panics in async commands: a panic left the
    // frontend's invoke pending forever and the chat spinning until its
    // watchdog gave up. Turn it into an ordinary error instead.
    let result = match AssertUnwindSafe(turn).catch_unwind().await {
        Ok(r) => r,
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            Err(AiError::Other(format!("internal error: {msg}")))
        }
    };
    if let Err(e) = &result {
        crate::log_chat!("error", "{e}");
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn ai_chat_send_inner(
    mut input: ChatSendInput,
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
    mcp_slot: State<'_, crate::ai::mcp_bridge::McpBridgeSlot>,
    cancel: CancelToken,
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
    // A turn stopped while still queued behind another never starts.
    let _send_guard = tokio::select! {
        guard = send_lock.lock() => guard,
        _ = cancel.cancelled() => {
            emit_done(&app, input.request_id, String::new(), "canceled");
            return Ok(());
        }
    };

    // Keep the MCP bridge pointed at the connection/schema the user is looking
    // at, so any DB tool a wrapped CLI calls runs against the right database.
    // Set only now that this turn owns the session — setting it before the lock
    // re-pointed a still-running turn's tool calls at the new connection.
    if let Some(bridge) = mcp_slot.read().await.as_ref() {
        bridge
            .set_context(
                input.connection_id.clone(),
                input.schema.clone(),
                Some(input.request_id.clone()),
                Some(cancel.clone()),
            )
            .await;
    }

    // A turn sent from another connection's chat brings that chat's history:
    // swap it in now that this turn owns the session (see `history`).
    if let Some(history) = input.history.take() {
        let mut guard = slot.write().await;
        let Some(session) = guard.as_mut() else {
            return Err(AiError::NoActiveSession);
        };
        session.messages = restored_messages(history);
        session.last_context_key = None;
        session.current_context = None;
        session.context_built_at = None;
        session.recent_activity = None;
    }

    // Can the model use the DB tools this turn? Natively in the tool loop, or —
    // for the wrapped CLIs — over the MCP bridge. The prompt and the context
    // only teach tools when it can.
    let (provider_kind, supports_tools) = {
        let guard = slot.read().await;
        let session = guard.as_ref().ok_or(AiError::NoActiveSession)?;
        (session.provider_kind, session.provider.supports_tools())
    };
    let tool_mode = supports_tools && input.connection_id.is_some();
    let tools_available = tool_mode
        || (input.connection_id.is_some()
            && provider_kind.is_cli()
            && mcp_slot.read().await.is_some());

    // Schema context is (re-)built whenever the fingerprint of what the user
    // is looking at changes: connection, its current database (Postgres
    // switches databases under the same connection id), schema, focused tab,
    // tool access, and a counter the AI's own DDL bumps. Staying on the same
    // tab skips the rebuild (the hot path) until the context is a few minutes
    // old.
    let active_database = match input.connection_id.as_deref() {
        Some(cid) => db_registry.profile(cid).await.ok().and_then(|p| p.database),
        None => None,
    };
    let new_context_key: Option<String> = input.connection_id.as_deref().map(|cid| {
        let schema_part = input.schema.as_deref().unwrap_or("");
        let focus_part = input
            .focus
            .as_ref()
            .map(FocusHint::cache_key)
            .unwrap_or_default();
        format!(
            "{cid}|{}|{schema_part}|{focus_part}|{tools_available}|{}",
            active_database.as_deref().unwrap_or(""),
            crate::ai::context::schema_epoch()
        )
    });
    let rebuild = {
        let guard = slot.read().await;
        let session = guard.as_ref().ok_or(AiError::NoActiveSession)?;
        let stale = session
            .context_built_at
            .map_or(true, |t| t.elapsed() > crate::ai::context::SCHEMA_CONTEXT_TTL);
        match (&session.last_context_key, &new_context_key) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(a), Some(b)) => a != b || stale,
        }
    };

    // `Some(new)` when the stored context changes this turn.
    let mut context_update: Option<Option<String>> = None;
    if new_context_key.is_none() {
        // No connection: don't keep answering against the last one's schema.
        context_update = Some(None);
    } else if rebuild {
        let conn_id = input.connection_id.as_deref().expect("key implies a connection");
        let build = crate::ai::context::build(
            db_registry.inner(),
            conn_id,
            input.schema.as_deref(),
            input.focus.as_ref(),
            tools_available,
        );
        let outcome = match cancel.run(tokio::time::timeout(CONTEXT_BUILD_TIMEOUT, build)).await {
            Some(r) => r,
            None => {
                emit_done(&app, input.request_id, String::new(), "canceled");
                return Ok(());
            }
        };
        // Don't fail the chat over a context-build hiccup — the user can still
        // have a conversation, just without auto-injected schema awareness. But
        // drop the old context: it described whatever was focused before.
        context_update = Some(match outcome {
            Ok(Ok(text)) => Some(text),
            Ok(Err(e)) => {
                crate::log_line!("ai_context", "failed to build schema context: {e}");
                None
            }
            Err(_) => {
                crate::log_line!("ai_context", "schema context timed out; continuing without it");
                None
            }
        });
    }

    let user_turn = assemble_user_turn(&input);

    // Transcript logging — one user line per turn. Assistant + tool turns
    // are logged from the paths that produce them below.
    crate::log_chat!("user", "{}", user_turn);

    // Store the context (if it changed) + append the user turn.
    let provider = {
        let mut guard = slot.write().await;
        let Some(session) = guard.as_mut() else {
            return Err(AiError::NoActiveSession);
        };
        match context_update.clone() {
            Some(Some(ctx)) => {
                // Store (don't push into history). `with_system_prompt` re-prepends
                // this every turn so the schema sits right next to the system prompt
                // + the latest user turn — weak local models ignored it when it was
                // buried thousands of tokens back in history.
                crate::log_chat!("system", "{}", ctx.chars().take(400).collect::<String>());
                session.current_context = Some(ctx);
                session.last_context_key = new_context_key.clone();
                session.context_built_at = Some(std::time::Instant::now());
            }
            // Cleared, or the build failed (retried next turn).
            Some(None) => {
                session.current_context = None;
                session.last_context_key = None;
                session.context_built_at = None;
            }
            None => {}
        }
        // Refresh the recent-activity block every turn (it grows as queries run).
        // Cleared when the frontend sends nothing so a stale log can't linger.
        session.recent_activity = input
            .recent_query_log
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        session
            .messages
            .push(ChatMessage::text(ChatRole::User, user_turn));
        session.provider.clone()
    };

    // Diagnostic: makes "the model has no DB context" debuggable. If
    // connection_id is None the chat is unscoped (no schema context, no tools) —
    // expected when chatting before focusing a database. tool_mode false on a
    // focused connection means the provider/model reported no tool support.
    crate::log_chat!(
        "ctx",
        "connection={} database={} schema={} context={} tool_mode={} tools={} effort={:?} max_tokens={:?} max_iter={:?} max_repeat={:?}",
        input.connection_id.as_deref().unwrap_or("<none>"),
        active_database.as_deref().unwrap_or("<none>"),
        input.schema.as_deref().unwrap_or("<none>"),
        match &context_update {
            Some(Some(_)) => "rebuilt",
            Some(None) => "none",
            None => "kept",
        },
        tool_mode,
        tools_available,
        input.reasoning_effort,
        input.max_tokens,
        input.max_iterations,
        input.max_repeat_calls,
    );

    // Effort-driven per-turn knobs, shared by both paths. `max_tokens` is
    // clamped to a sane range; `reasoning_effort` is passed through verbatim
    // (providers/models that don't support it ignore it).
    let mut max_tokens = input
        .max_tokens
        .filter(|n| (256..=200_000).contains(n))
        .unwrap_or(DEFAULT_AI_MAX_TOKENS);
    if provider_kind == crate::ai::ProviderKind::LlamaLocal {
        // llama-server runs an 8k-token window shared by prompt and reply;
        // asking for 16k of output can't be honoured.
        max_tokens = max_tokens.min(LLAMA_MAX_REPLY_TOKENS);
    }
    let turn_opts = crate::ai::TurnOptions {
        max_tokens: Some(max_tokens),
        reasoning_effort: input.reasoning_effort,
        stream: input.stream,
        sql_fence_fallback: matches!(input.kind, ChatKind::Chat),
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
            turn_opts,
            cancel,
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
            session.provider_kind,
            &session.model,
            session.current_context.as_deref(),
            session.recent_activity.as_deref(),
            tools_available,
        )
    };

    let req = CompletionRequest {
        request_id: input.request_id.clone(),
        messages: history,
        max_tokens: Some(max_tokens),
        temperature: None,
        stop: None,
        reasoning_effort: input.reasoning_effort,
    };

    let mut stream = tokio::select! {
        s = provider.complete(req) => s?,
        _ = cancel.cancelled() => {
            emit_done(&app, input.request_id, String::new(), "canceled");
            return Ok(());
        }
    };
    let mut full = String::new();
    let mut finish: Option<crate::ai::FinishReason> = None;

    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.cancelled() => {
                // Dropping the stream closes the connection (or the CLI's
                // pipe), which stops generation.
                finish = Some(crate::ai::FinishReason::Canceled);
                break;
            }
        };
        let Some(chunk) = chunk else { break };
        full.push_str(&chunk.delta);
        if chunk.finish_reason.is_some() {
            finish = chunk.finish_reason;
        }
        // With stream mode off we still drive the provider's stream internally
        // (it's the only entry point) but withhold the per-token chunks — the
        // assembled reply is delivered once in the `done` event below.
        if input.stream {
            // Fire-and-forget — UI failures shouldn't kill the stream.
            let _ = app.emit(
                "ai://chat/chunk",
                ChunkEvent {
                    request_id: chunk.request_id,
                    delta: chunk.delta,
                },
            );
        }
    }

    drop(stream);
    crate::log_chat!("assistant", "{}", full);

    // Commit assistant turn back onto the session — but only if it's still
    // the same session that started the request. If the user ended the chat
    // mid-stream, the session slot is already empty; drop the reply silently.
    // An empty reply isn't committed: Anthropic and Gemini reject empty
    // non-final messages, so one empty turn failed every later request. A
    // failed reply isn't either — it ends with the error notice, which the
    // model shouldn't read back as something it said.
    let failed = matches!(finish, Some(crate::ai::FinishReason::Error));
    if !failed && !full.trim().is_empty() {
        let mut guard = slot.write().await;
        if let Some(session) = guard.as_mut() {
            session
                .messages
                .push(ChatMessage::text(ChatRole::Assistant, full.clone()));
        }
    }

    let reason = match finish {
        Some(crate::ai::FinishReason::Length) => "length",
        Some(crate::ai::FinishReason::Canceled) => "canceled",
        Some(crate::ai::FinishReason::Error) => "error",
        Some(crate::ai::FinishReason::Stop) | None => "stop",
    };
    emit_done(&app, input.request_id, full, reason);
    Ok(())
}

/// Emit the terminal `ai://chat/done` event for a turn.
pub(super) fn emit_done(app: &tauri::AppHandle, request_id: String, content: String, finish_reason: &'static str) {
    let _ = app.emit(
        "ai://chat/done",
        DoneEvent { request_id, content, finish_reason: Some(finish_reason) },
    );
}

#[tauri::command]
pub async fn ai_chat_stop(
    request_id: String,
    slot: State<'_, SessionSlot>,
    cancels: State<'_, Arc<CancelRegistry>>,
) -> Result<(), AiError> {
    // Ends the turn's stream, tool loop and approval waits, and releases the
    // send lock so the next message isn't stuck behind it.
    cancels.cancel(&request_id);
    // Provider-level cancel too (kills a CLI child process). No session left
    // is fine — there is nothing to stop.
    if let Ok(provider) = session::require_provider(&slot).await {
        provider.cancel(&request_id).await;
    }
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
) -> Result<bool, AiError> {
    // Returns whether the transcript was replaced: `false` while a turn is
    // still running — the UI's next send then carries this history instead.
    let Some(_turn) = session::settle_turn(&slot).await? else {
        return Ok(false);
    };
    let mut guard = slot.write().await;
    let Some(session) = guard.as_mut() else {
        return Err(AiError::NoActiveSession);
    };
    let restored = restored_messages(messages);
    crate::log_line!("ai", "restored {} messages into session", restored.len());
    session.messages = restored;
    // Force a fresh schema-context injection on the next turn (the restored
    // transcript has no context fingerprint).
    session.last_context_key = None;
    session.current_context = None;
    session.context_built_at = None;
    session.recent_activity = None;
    Ok(true)
}

/// The user/assistant text turns of a saved or client-side transcript, as
/// session messages. Tool/system turns are dropped (see
/// [`ai_restore_messages`]), and so are empty ones — Anthropic and Gemini
/// reject an empty message.
fn restored_messages(messages: Vec<RestoreMessage>) -> Vec<ChatMessage> {
    messages
        .into_iter()
        .filter_map(|m| {
            let role = match m.role.as_str() {
                "user" => ChatRole::User,
                "assistant" => ChatRole::Assistant,
                _ => return None,
            };
            if m.content.trim().is_empty() {
                return None;
            }
            Some(ChatMessage::text(role, m.content))
        })
        .collect()
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
