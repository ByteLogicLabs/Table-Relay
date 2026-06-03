//! Tauri commands for the AI session. The session itself lives behind a
//! `SessionSlot` managed on `AppState`; these commands only marshal between
//! the frontend and that slot.

use std::sync::Arc;
use std::time::Instant;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::ai::anthropic::AnthropicProvider;
use crate::ai::download::{self, DownloadRegistry, LocalModelInfo};
use crate::ai::echo::EchoProvider;
use crate::ai::gemini::GeminiProvider;
use crate::ai::llama::LlamaLocalProvider;
use crate::ai::openai::OpenAiProvider;
use crate::ai::session::{self, AiSession, SessionSlot};
use crate::ai::{AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, ProviderKind};

const DEFAULT_AI_MAX_TOKENS: u32 = 16_384;

#[derive(Debug, Serialize)]
pub struct AiStatus {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct StartInput {
    pub kind: ProviderKind,
    /// Hosted providers only. Persisted plaintext to store.db on successful
    /// start (matches the rest of the store; encryption deferred).
    #[serde(default)]
    pub api_key: Option<String>,
    /// OpenAI-compatible only (Ollama, Groq, etc.). Consumed by M8.2.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Model id. For `Echo` this is cosmetic; for hosted it's the API model;
    /// for local it's the file stem under `.ai-models/`.
    pub model: String,
    /// Free-form JSON blob of per-provider preferences (temperature,
    /// max_tokens, custom headers, …). Round-tripped through `ai_settings`
    /// so the StartScreen can stash whatever knobs it exposes.
    #[serde(default)]
    pub options_json: Option<String>,
}

#[tauri::command]
pub async fn ai_status(slot: State<'_, SessionSlot>) -> Result<AiStatus, AiError> {
    let guard = slot.read().await;
    Ok(match guard.as_ref() {
        None => AiStatus {
            active: false,
            provider_kind: None,
            model: None,
            message_count: None,
        },
        Some(s) => AiStatus {
            active: true,
            provider_kind: Some(s.provider_kind.as_str().to_string()),
            model: Some(s.model.clone()),
            message_count: Some(s.messages.len()),
        },
    })
}

#[tauri::command]
pub async fn ai_start(
    input: StartInput,
    slot: State<'_, SessionSlot>,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<AiStatus, AiError> {
    // Build + probe the provider. On failure we drop the provider here, which
    // in turn zeroes the API key via the `Zeroizing<String>` wrapper — the
    // key never reaches `AppState`.
    let provider: Arc<dyn AiProvider> = match input.kind {
        ProviderKind::Echo => Arc::new(EchoProvider::new()),
        ProviderKind::LlamaLocal => {
            // Resolve the GGUF path under `ai-models/`. The download command
            // writes `<id>.gguf` on success, so the id the user picked in the
            // UI maps directly to the file on disk.
            let model_path = download::model_path(&input.model);
            if !model_path.is_file() {
                return Err(AiError::InvalidModel(format!(
                    "model file not found at {}. Download it first from the chat panel.",
                    model_path.display()
                )));
            }
            let p = LlamaLocalProvider::start(input.model.clone(), model_path).await?;
            Arc::new(p)
        }
        ProviderKind::Openai => {
            let key = require_key(&input.api_key)?;
            let p = OpenAiProvider::openai(key, input.model.clone());
            p.probe().await?;
            Arc::new(p)
        }
        ProviderKind::Anthropic => {
            let key = require_key(&input.api_key)?;
            let p = AnthropicProvider::new(key, input.model.clone());
            p.probe().await?;
            Arc::new(p)
        }
        ProviderKind::Gemini => {
            let key = require_key(&input.api_key)?;
            let p = GeminiProvider::new(key, input.model.clone());
            p.probe().await?;
            Arc::new(p)
        }
        ProviderKind::OpenaiCompatible => {
            let key = input.api_key.clone().unwrap_or_default();
            let base = input.base_url.clone().ok_or_else(|| {
                AiError::InvalidModel("base_url is required for openai_compatible".into())
            })?;
            let p = OpenAiProvider::compatible(base, key, input.model.clone());
            p.probe().await?;
            Arc::new(p)
        }
    };

    let session = AiSession {
        provider,
        provider_kind: input.kind,
        model: input.model.clone(),
        messages: Vec::new(),
        started_at: Instant::now(),
        last_context_key: None,
        send_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    session::install(&slot, session).await?;

    // Persist the just-verified settings so the next launch prefills them.
    // Write-through is best-effort — a DB hiccup must never break the active
    // session (they can still chat, they just won't get the prefill next time).
    {
        let input_clone = crate::store::repo_ai::AiSettingsInput {
            kind: input.kind.as_str().to_string(),
            api_key: input.api_key.clone(),
            base_url: input.base_url.clone(),
            model: Some(input.model.clone()),
            options_json: input.options_json.clone(),
        };
        if let Err(e) = store.with_conn(true, |guard| {
            crate::store::repo_ai::upsert(guard, input_clone).map(|_| ())
        }) {
            crate::log_line!("ai_settings", "persist failed: {e}");
        }
    }

    Ok(AiStatus {
        active: true,
        provider_kind: Some(input.kind.as_str().to_string()),
        model: Some(input.model),
        message_count: Some(0),
    })
}

#[tauri::command]
pub async fn ai_end(slot: State<'_, SessionSlot>) -> Result<(), AiError> {
    session::end(&slot).await
}

/// Reset the conversation transcript in place — session stays active, provider
/// + model unchanged, but `messages` and the cached context fingerprint are
/// cleared. Used by the "New chat" button. Cheap: no allocation, no network.
#[tauri::command]
pub async fn ai_new_chat(slot: State<'_, SessionSlot>) -> Result<(), AiError> {
    let mut guard = slot.write().await;
    let Some(session) = guard.as_mut() else {
        return Err(AiError::NoActiveSession);
    };
    session.messages.clear();
    // Clearing the key forces the next `ai_chat_send` to re-inject the
    // schema context as though it were the first turn.
    session.last_context_key = None;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ListModelsInput {
    pub kind: ProviderKind,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Fetch the model catalogue for a provider without starting a session.
/// Hosted providers hit their own `/models` endpoint; Echo and LlamaLocal
/// return a fixed list.
#[tauri::command]
pub async fn ai_list_models(input: ListModelsInput) -> Result<Vec<String>, AiError> {
    match input.kind {
        ProviderKind::Echo => Ok(vec!["echo".into()]),
        ProviderKind::LlamaLocal => Ok(Vec::new()),
        ProviderKind::Openai => {
            let key = input.api_key.as_deref().unwrap_or_default();
            if key.is_empty() {
                return Err(AiError::Unauthorized(
                    "API key is required to list models".into(),
                ));
            }
            OpenAiProvider::list_models("https://api.openai.com/v1", Some(key)).await
        }
        ProviderKind::Anthropic => {
            let key = input.api_key.as_deref().unwrap_or_default();
            if key.is_empty() {
                return Err(AiError::Unauthorized(
                    "API key is required to list models".into(),
                ));
            }
            AnthropicProvider::list_models(key).await
        }
        ProviderKind::Gemini => {
            let key = input.api_key.as_deref().unwrap_or_default();
            if key.is_empty() {
                return Err(AiError::Unauthorized(
                    "API key is required to list models".into(),
                ));
            }
            GeminiProvider::list_models(key).await
        }
        ProviderKind::OpenaiCompatible => {
            let base = input
                .base_url
                .as_deref()
                .ok_or_else(|| AiError::InvalidModel("base_url is required".into()))?;
            OpenAiProvider::list_models(base, input.api_key.as_deref()).await
        }
    }
}

/// List every model in the local catalog, flagged with whether it's already
/// downloaded / partially downloaded.
#[tauri::command]
pub async fn ai_list_local_models() -> Result<Vec<LocalModelInfo>, AiError> {
    Ok(download::list_local().await)
}

/// Kick off a download. Runs in the background; progress is reported via
/// `ai://download/progress` events. The command returns as soon as the
/// download completes (successful, canceled, or errored) so the frontend
/// can await it for hooking up UI spinners.
#[tauri::command]
pub async fn ai_download_model(
    id: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), AiError> {
    download::download(id, app, registry.inner().clone()).await
}

#[tauri::command]
pub async fn ai_cancel_download(
    id: String,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), AiError> {
    download::cancel(&id, registry.inner().clone()).await
}

#[tauri::command]
pub async fn ai_delete_model(id: String, slot: State<'_, SessionSlot>) -> Result<(), AiError> {
    // Refuse if the active session is using this exact model, so we don't
    // yank weights out from under a live provider.
    let active = {
        let guard = slot.read().await;
        guard
            .as_ref()
            .filter(|s| s.provider_kind == ProviderKind::LlamaLocal)
            .map(|s| s.model.clone())
    };
    download::delete_model(&id, active.as_deref()).await
}

// -----------------------------------------------------------------------------
// Local-runtime availability probe. The UI hits this every time the user picks
// "Local Llama" so it can show the right state (installed / not installed /
// install-in-progress) without blindly trying to spawn the server.
// -----------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LlamaRuntimeStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Platform id so the UI can pick the right install instructions.
    pub platform: &'static str,
    /// Pre-canned install command for this platform (copy-paste friendly).
    pub install_command: &'static str,
}

#[tauri::command]
pub async fn ai_check_llama_server() -> Result<LlamaRuntimeStatus, AiError> {
    let path = crate::ai::llama_server::find_binary();
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    let install_command = match platform {
        "macos" => "brew install llama.cpp",
        "linux" => "# Ubuntu/Debian:\nsudo apt install llama.cpp\n# or build from source: https://github.com/ggerganov/llama.cpp",
        "windows" => "winget install llama.cpp",
        _ => "See https://github.com/ggerganov/llama.cpp",
    };
    Ok(LlamaRuntimeStatus {
        installed: path.is_some(),
        path: path.map(|p| p.display().to_string()),
        platform,
        install_command,
    })
}

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
pub async fn ai_chat_send(
    input: ChatSendInput,
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<(), AiError> {
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
        // Clamp the user-configured cap into a sane range; fall back to default.
        let max_iterations = input
            .max_iterations
            .filter(|n| (1..=50).contains(n))
            .unwrap_or(DEFAULT_MAX_TOOL_ITERATIONS);
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
        with_system_prompt(&session.messages)
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

/// Tool-loop path. Non-streaming: we round-trip with `complete_once`,
/// execute any tool calls the model asks for, and loop until the model
/// returns a plain-text reply. Once we have that reply, we emit it as one
/// chunk + done so the frontend's existing streaming code picks it up.
#[allow(clippy::too_many_arguments)]
/// Default tool-calling round cap when the user hasn't set one. Capable
/// agentic models legitimately chain several reads → a query → a summary, so
/// 12 leaves headroom; the repeat-guard below stops genuine loops far sooner.
pub const DEFAULT_MAX_TOOL_ITERATIONS: u32 = 12;

#[allow(clippy::too_many_arguments)]
async fn run_tool_loop(
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
) -> Result<(), AiError> {
    use crate::ai::tools;
    let tools_catalog = tools::catalog();
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
    const MAX_REPEAT_CALLS: u32 = 3;
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
            let approvals_arc = approvals.inner().clone();
            let auto_arc = auto_approvals.inner().clone();
            let db_arc = db_registry.inner().clone();
            let result = tools::dispatch(
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
            let errored = result.content.contains("\"error\"");
            let sig = format!("{}::{}", tc.name, tc.arguments);
            if last_call_sig.as_deref() == Some(sig.as_str()) {
                repeat_calls += 1;
            } else {
                last_call_sig = Some(sig);
                repeat_calls = 1;
            }
            if repeat_calls >= MAX_REPEAT_CALLS {
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

// Approval command — the UI calls this with approve/deny after showing the
// user the SQL that `call_query` wants to execute.
#[derive(Debug, Deserialize)]
pub struct ApprovalInput {
    pub tool_call_id: String,
    pub decision: crate::ai::tools::ApprovalDecision,
}

#[tauri::command]
pub async fn ai_approve_tool_call(
    input: ApprovalInput,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
) -> Result<(), AiError> {
    let ok = approvals.resolve(&input.tool_call_id, input.decision).await;
    if !ok {
        return Err(AiError::Other(format!(
            "no pending tool call with id {}",
            input.tool_call_id
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_get_auto_approvals(
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<crate::ai::tools::AutoApprovalFlags, AiError> {
    Ok(auto_approvals.get().await)
}

#[tauri::command]
pub async fn ai_set_auto_approvals(
    flags: crate::ai::tools::AutoApprovalFlags,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<(), AiError> {
    auto_approvals.set(flags).await;
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_stop(request_id: String, slot: State<'_, SessionSlot>) -> Result<(), AiError> {
    let provider = session::require_provider(&slot).await?;
    provider.cancel(&request_id).await;
    Ok(())
}

fn require_key(key: &Option<String>) -> Result<String, AiError> {
    match key {
        Some(k) if !k.trim().is_empty() => Ok(k.clone()),
        _ => Err(AiError::Unauthorized("API key is required".into())),
    }
}

/// Prepend the static system prompt in front of the session's message
/// history. The prompt itself is not persisted in `session.messages` —
/// re-injecting it on every turn via this helper keeps the stored
/// transcript clean (no ~1KB of rules per user turn in the chat log) and
/// always ships the latest rules to the model even if we tweak them.
fn with_system_prompt(history: &[ChatMessage]) -> Vec<ChatMessage> {
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

// ---- Conversation persistence ----

use crate::store::repo_ai_conv as conv_repo;

#[tauri::command]
pub async fn ai_conversation_list(
    store: State<'_, Arc<crate::store::Store>>,
    limit: Option<i64>,
) -> Result<Vec<conv_repo::Conversation>, AiError> {
    store
        .with_conn(false, |db| conv_repo::list(db, limit))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_get(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
) -> Result<Option<conv_repo::Conversation>, AiError> {
    store
        .with_conn(false, |db| conv_repo::get(db, &id))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_create(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
    connection_id: Option<String>,
    provider_kind: Option<String>,
    model: Option<String>,
) -> Result<conv_repo::Conversation, AiError> {
    store
        .with_conn(true, |db| {
            conv_repo::create(
                db,
                conv_repo::CreateConversationInput {
                    id,
                    connection_id,
                    provider_kind,
                    model,
                },
            )
        })
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_delete(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::delete(db, &id))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_update_title(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
    title: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::update_title(db, &id, &title))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_save_message(
    store: State<'_, Arc<crate::store::Store>>,
    conversation_id: String,
    msg_id: String,
    role: String,
    content: String,
    tool_calls_json: Option<String>,
    tool_call_id: Option<String>,
    kind: Option<String>,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| {
            conv_repo::add_message(
                db,
                &conversation_id,
                &msg_id,
                &role,
                &content,
                tool_calls_json.as_deref(),
                tool_call_id.as_deref(),
                kind.as_deref(),
            )
        })
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_clear_messages(
    store: State<'_, Arc<crate::store::Store>>,
    conversation_id: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::clear_messages(db, &conversation_id))
        .map_err(|e| AiError::Other(e.to_string()))
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

#[derive(Serialize, Clone)]
struct ChunkEvent {
    request_id: String,
    delta: String,
}

#[derive(Serialize, Clone)]
struct DoneEvent {
    request_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    finish_reason: Option<&'static str>,
}
