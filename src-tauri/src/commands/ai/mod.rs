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
use crate::ai::cli_provider::{resolve_binary, CliProvider, CliSpec};
use crate::ai::cli_specs::{ClaudeCliSpec, CodexCliSpec, GeminiCliSpec, OpencodeSpec};
use crate::ai::download::{self, DownloadRegistry, LocalModelInfo};
use crate::ai::echo::EchoProvider;
use crate::ai::gemini::GeminiProvider;
use crate::ai::llama::LlamaLocalProvider;
use crate::ai::openai::OpenAiProvider;
use crate::ai::session::{self, AiSession, SessionSlot};
use crate::ai::{AiError, AiProvider, ProviderKind};

pub(super) const DEFAULT_AI_MAX_TOKENS: u32 = 16_384;

/// Default tool-calling round cap when the user hasn't set one. Capable
/// agentic models legitimately chain many steps — "analyze this DB, create
/// several tables, seed dummy data" is dozens of describe→create→insert calls.
/// The per-tool repeat-guards (identical `call_query` capped at 4, shape tools
/// at 6) stop genuine loops far sooner, so a high round ceiling is safe and
/// lets big multi-step tasks finish instead of being cut off mid-way.
pub const DEFAULT_MAX_TOOL_ITERATIONS: u32 = 100;
/// Default cap on consecutive identical tool calls before the loop-guard stops
/// the turn. Overridable per-turn via the user's AI settings. (Per-tool caps in
/// the loop are tighter; this is the generic backstop.)
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
#[allow(clippy::too_many_arguments)]
pub async fn ai_start(
    input: StartInput,
    app: tauri::AppHandle,
    slot: State<'_, SessionSlot>,
    store: State<'_, Arc<crate::store::Store>>,
    db_registry: State<'_, Arc<crate::db::registry::Registry>>,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
    mcp_slot: State<'_, crate::ai::mcp_bridge::McpBridgeSlot>,
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
        ProviderKind::ClaudeCli
        | ProviderKind::CodexCli
        | ProviderKind::GeminiCli
        | ProviderKind::Opencode => {
            // Lazily bind the MCP bridge so the CLI can call our DB tools, then
            // register it with this CLI. Bridge/registration failures are
            // non-fatal — the CLI still runs as a chat provider without tools.
            let bridge = ensure_bridge(
                &mcp_slot,
                db_registry.inner().clone(),
                approvals.inner().clone(),
                auto_approvals.inner().clone(),
                app.clone(),
            )
            .await;
            let mcp_config_path = match &bridge {
                Some(b) => register_cli_mcp(input.kind, b),
                None => None,
            };
            build_cli_provider(input.kind, input.model.clone(), mcp_config_path)?
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
        // CLI providers: no network model listing. Return a small curated list
        // so the picker isn't empty. The UI's picker also accepts a typed custom
        // id (allowCustom), so a model newer than this list is still reachable.
        // Claude takes aliases (`sonnet`/`opus`/`haiku`) or full ids.
        ProviderKind::ClaudeCli => Ok(vec![
            "sonnet".into(),
            "opus".into(),
            "haiku".into(),
        ]),
        ProviderKind::CodexCli => Ok(vec![
            "gpt-5-codex".into(),
            "gpt-5".into(),
            "o4-mini".into(),
        ]),
        ProviderKind::GeminiCli => Ok(vec![
            "gemini-2.5-pro".into(),
            "gemini-2.5-flash".into(),
        ]),
        // opencode knows its own catalog (`opencode models`, provider/model
        // strings). Ask the binary so the picker reflects what's actually
        // configured/authed; fall back to empty (= let opencode pick) on error.
        ProviderKind::Opencode => Ok(opencode_models().await.unwrap_or_default()),
    }
}

/// Run `opencode models` and return its `provider/model` lines. Best-effort:
/// returns `None` if the binary can't be found or run. Logs the reason on
/// failure so an empty picker isn't a silent mystery.
async fn opencode_models() -> Option<Vec<String>> {
    let spec = cli_spec_for(ProviderKind::Opencode);
    let Some(bin) = resolve_binary(spec.as_ref()) else {
        crate::log_line!("cli", "opencode_models: binary not resolved");
        return None;
    };
    // Route through the cross-platform builder so a Windows `.cmd` shim runs via
    // `cmd /C` instead of failing with ERROR_BAD_EXE_FORMAT. A GUI app launched
    // from Finder/Dock has a minimal PATH, so we give the child an augmented PATH
    // (binary's own dir + the same fallback dirs we probe) — otherwise opencode
    // can fail to locate its own runtime/helpers.
    let mut cmd = crate::ai::cli_provider::build_command(&bin, &["models".to_string()]);
    cmd.stdin(std::process::Stdio::null());
    augment_path_env(&mut cmd, &bin);
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            crate::log_line!("cli", "opencode_models: spawn failed: {e}");
            return None;
        }
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        crate::log_line!(
            "cli",
            "opencode_models: exit {} stderr: {}",
            output.status,
            err.chars().take(300).collect::<String>()
        );
        return None;
    }
    // Keep only lines shaped like `provider/model` (skip any banner/footer the
    // CLI might print). This is the only validation — we never hardcode the list.
    let list: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l.contains('/') && !l.contains(' '))
        .collect();
    crate::log_line!("cli", "opencode_models: {} models parsed", list.len());
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Augment a child command's `PATH` with the resolved binary's own directory plus
/// the common install dirs, so a Finder/Dock-launched app (minimal inherited
/// PATH) can still run CLIs that shell out to sibling tools.
fn augment_path_env(cmd: &mut tokio::process::Command, bin: &std::path::Path) {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    if let Some(home) = crate::ai::cli_specs::home() {
        dirs.push(home.join(".opencode/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".local/bin"));
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(std::path::PathBuf::from(p));
    }
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut all: Vec<std::path::PathBuf> = dirs;
    all.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(all) {
        cmd.env("PATH", joined);
    }
}

/// Availability check for a CLI provider: is the binary resolvable, and where?
/// Used by the start screen to show "✓ found at …" / "✗ not installed".
#[tauri::command]
pub async fn ai_cli_available(kind: ProviderKind) -> Result<Option<String>, AiError> {
    if !kind.is_cli() {
        return Ok(None);
    }
    let spec = cli_spec_for(kind);
    Ok(resolve_binary(spec.as_ref()).map(|p| p.display().to_string()))
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

/// Download a user-supplied GGUF model by URL (not in the built-in catalog).
/// `id` is the chosen on-disk/model id; `url` is a direct .gguf download link.
#[tauri::command]
pub async fn ai_download_model_url(
    id: String,
    url: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<DownloadRegistry>>,
) -> Result<(), AiError> {
    // Sanitize the id into a safe filename stem (no path separators / spaces).
    let safe_id: String = id
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if safe_id.is_empty() {
        return Err(AiError::InvalidModel("model id cannot be empty".into()));
    }
    download::download_url(safe_id, url, app, registry.inner().clone()).await
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

/// Build the right [`CliSpec`] for a CLI provider kind.
fn cli_spec_for(kind: ProviderKind) -> Arc<dyn CliSpec> {
    match kind {
        ProviderKind::ClaudeCli => Arc::new(ClaudeCliSpec),
        ProviderKind::CodexCli => Arc::new(CodexCliSpec),
        ProviderKind::GeminiCli => Arc::new(GeminiCliSpec { system_md: None }),
        ProviderKind::Opencode => Arc::new(OpencodeSpec),
        _ => unreachable!("cli_spec_for called with non-CLI kind"),
    }
}

/// Resolve + construct a subprocess CLI provider, or a clear "not installed"
/// error pointing the user at the install/login step. `mcp_config_path` is the
/// Claude `--mcp-config` file path when MCP is wired (the other CLIs register
/// out-of-band and ignore it).
fn build_cli_provider(
    kind: ProviderKind,
    model: String,
    mcp_config_path: Option<String>,
) -> Result<Arc<dyn AiProvider>, AiError> {
    let spec = cli_spec_for(kind);
    let bin = resolve_binary(spec.as_ref()).ok_or_else(|| {
        AiError::InvalidModel(format!(
            "{} not found on PATH. Install it and run it once to log in, then try again.",
            spec.binary_name()
        ))
    })?;
    Ok(Arc::new(CliProvider::new(spec, bin, model, mcp_config_path)))
}

/// Get the already-bound MCP bridge or lazily bind it. Returns `None` if binding
/// fails (loopback unavailable) — the caller then runs the CLI tool-less.
async fn ensure_bridge(
    mcp_slot: &crate::ai::mcp_bridge::McpBridgeSlot,
    db_registry: Arc<crate::db::registry::Registry>,
    approvals: Arc<crate::ai::tools::ApprovalRegistry>,
    auto_approvals: Arc<crate::ai::tools::AutoApprovals>,
    app: tauri::AppHandle,
) -> Option<Arc<crate::ai::mcp_bridge::McpBridge>> {
    {
        let guard = mcp_slot.read().await;
        if let Some(b) = guard.as_ref() {
            return Some(b.clone());
        }
    }
    match crate::ai::mcp_bridge::McpBridge::start(db_registry, approvals, auto_approvals, app).await {
        Ok(b) => {
            *mcp_slot.write().await = Some(b.clone());
            Some(b)
        }
        Err(e) => {
            crate::log_line!("mcp", "bridge bind failed: {e}");
            None
        }
    }
}

/// Register the bridge with one CLI so it can call our DB tools. Claude takes a
/// per-invocation `--mcp-config` file (returned here); the others register via
/// their config files (side effects, returns `None`). All failures are logged
/// and swallowed — MCP is best-effort on top of plain chat.
fn register_cli_mcp(
    kind: ProviderKind,
    bridge: &crate::ai::mcp_bridge::McpBridge,
) -> Option<String> {
    use crate::ai::mcp_server;
    let exe = match std::env::current_exe() {
        Ok(p) => p.display().to_string(),
        Err(e) => {
            crate::log_line!("mcp", "current_exe failed: {e}");
            return None;
        }
    };
    let (port, token) = (bridge.port, bridge.token.as_str());
    // Cross-platform home (USERPROFILE on Windows, HOME elsewhere).
    let home = crate::ai::cli_specs::home();
    match kind {
        ProviderKind::ClaudeCli => {
            match mcp_server::write_claude_mcp_config(&exe, port, token) {
                Ok(path) => Some(path),
                Err(e) => {
                    crate::log_line!("mcp", "claude config write failed: {e}");
                    None
                }
            }
        }
        ProviderKind::GeminiCli => {
            if let Some(h) = &home {
                if let Err(e) = mcp_server::register_gemini(h, &exe, port, token) {
                    crate::log_line!("mcp", "gemini register failed: {e}");
                }
            }
            None
        }
        ProviderKind::Opencode => {
            if let Some(h) = &home {
                if let Err(e) = mcp_server::register_opencode(h, &exe, port, token) {
                    crate::log_line!("mcp", "opencode register failed: {e}");
                }
            }
            None
        }
        ProviderKind::CodexCli => {
            if let Some(h) = &home {
                if let Err(e) = mcp_server::register_codex(h, &exe, port, token) {
                    crate::log_line!("mcp", "codex register failed: {e}");
                }
            }
            None
        }
        _ => None,
    }
}
