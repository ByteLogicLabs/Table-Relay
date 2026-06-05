//! Tauri commands for the AI session. The session itself lives behind a
//! `SessionSlot` managed on `AppState`; these commands only marshal between
//! the frontend and that slot.
//!
//! The command surface is split across focused submodules; everything is
//! re-exported from this module root so the `tauri::generate_handler!`
//! registration paths (`commands::ai::*`) stay valid.

mod chat;
mod conversation;
mod tool_loop;

// Glob re-exports so the hidden `__cmd__*` macros that `#[tauri::command]`
// generates alongside each command function are also brought into this module
// root — `tauri::generate_handler!` resolves commands by that macro path
// (`commands::ai::__cmd__<name>`), which a name-by-name `pub use` of just the
// functions would not satisfy.
pub use chat::*;
pub use conversation::*;

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::anthropic::AnthropicProvider;
use crate::ai::download::{self, DownloadRegistry, LocalModelInfo};
use crate::ai::echo::EchoProvider;
use crate::ai::gemini::GeminiProvider;
use crate::ai::llama::LlamaLocalProvider;
use crate::ai::openai::OpenAiProvider;
use crate::ai::session::{self, AiSession, SessionSlot};
use crate::ai::{AiError, AiProvider, ProviderKind};

pub(super) const DEFAULT_AI_MAX_TOKENS: u32 = 16_384;

/// Default tool-calling round cap when the user hasn't set one. Capable
/// agentic models legitimately chain several reads → a query → a summary, so
/// 12 leaves headroom; the repeat-guard below stops genuine loops far sooner.
pub const DEFAULT_MAX_TOOL_ITERATIONS: u32 = 50;
/// Default cap on consecutive identical tool calls before the loop-guard stops
/// the turn. Overridable per-turn via the user's AI settings.
pub const DEFAULT_MAX_REPEAT_CALLS: u32 = 50;

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

fn require_key(key: &Option<String>) -> Result<String, AiError> {
    match key {
        Some(k) if !k.trim().is_empty() => Ok(k.clone()),
        _ => Err(AiError::Unauthorized("API key is required".into())),
    }
}
