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
use crate::ai::cli_specs::{AgySpec, ClaudeCliSpec, CodexCliSpec, GeminiCliSpec, KiloSpec, OpencodeSpec};
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
        // Hosted providers: we DON'T block session start on a network probe.
        // The probe only validates key/model, and waiting on a round-trip made
        // "Start" feel slow. We open the session optimistically; the first
        // `ai_chat_send` hits the API and surfaces any auth/model error then.
        ProviderKind::Openai => {
            let key = require_key(&input.api_key)?;
            Arc::new(OpenAiProvider::openai(key, input.model.clone()))
        }
        ProviderKind::Anthropic => {
            let key = require_key(&input.api_key)?;
            Arc::new(AnthropicProvider::new(key, input.model.clone()))
        }
        ProviderKind::Gemini => {
            let key = require_key(&input.api_key)?;
            Arc::new(GeminiProvider::new(key, input.model.clone()))
        }
        ProviderKind::OpenaiCompatible => {
            let key = input.api_key.clone().unwrap_or_default();
            let base = input.base_url.clone().ok_or_else(|| {
                AiError::InvalidModel("base_url is required for openai_compatible".into())
            })?;
            Arc::new(OpenAiProvider::compatible(base, key, input.model.clone()))
        }
        ProviderKind::ClaudeCli
        | ProviderKind::CodexCli
        | ProviderKind::GeminiCli
        | ProviderKind::Opencode
        | ProviderKind::Kilo
        | ProviderKind::Antigravity => {
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
        current_context: None,
        recent_activity: None,
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
        // Codex has no `models` subcommand, but it maintains a refreshed catalog
        // at `~/.codex/models_cache.json` (the `slug`s are exactly what `-m`
        // takes). Read that instead of hardcoding; the picker's free-text entry
        // covers the case where the cache hasn't been written yet.
        ProviderKind::CodexCli => Ok(codex_models().await.unwrap_or_default()),
        ProviderKind::GeminiCli => Ok(vec![
            "gemini-2.5-pro".into(),
            "gemini-2.5-flash".into(),
        ]),
        // opencode knows its own catalog (`opencode models`, provider/model
        // strings). Ask the binary so the picker reflects what's actually
        // configured/authed; fall back to empty (= let opencode pick) on error.
        ProviderKind::Opencode => Ok(cli_models(ProviderKind::Opencode).await.unwrap_or_default()),
        // Kilo is opencode-compatible — `kilo models` prints provider/model ids.
        ProviderKind::Kilo => Ok(cli_models(ProviderKind::Kilo).await.unwrap_or_default()),
        // Antigravity's `agy models` lists its model ids.
        ProviderKind::Antigravity => {
            Ok(cli_models(ProviderKind::Antigravity).await.unwrap_or_default())
        }
    }
}

/// Ask Codex for its model catalog via the documented `codex debug models`
/// command ("Render the raw model catalog as JSON"). Returns the selectable
/// model `slug`s — exactly what `codex -m` accepts. No hardcoding; returns
/// `None` if the command is unavailable/unparseable, in which case the picker
/// falls back to free-text entry.
async fn codex_models() -> Option<Vec<String>> {
    let spec = cli_spec_for(ProviderKind::CodexCli);
    let bin = resolve_binary(spec.as_ref())?;
    let mut cmd = crate::ai::cli_provider::build_command(
        &bin,
        &["debug".to_string(), "models".to_string()],
    );
    cmd.stdin(std::process::Stdio::null());
    augment_path_env(&mut cmd, &bin);
    // Run from home (not the app's cwd `/` in a Finder-launched build) to match
    // the chat spawn and avoid any cwd-sensitive CLI behaviour.
    if let Some(h) = crate::ai::cli_specs::home() {
        cmd.current_dir(h);
    }
    let output = match tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            crate::log_line!("cli", "codex_models: spawn failed: {e}");
            return None;
        }
        Err(_) => {
            crate::log_line!("cli", "codex_models: timed out after 20s");
            return None;
        }
    };
    // The catalog is JSON on stdout; tolerate any leading log line by slicing
    // from the first `{`.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = stdout.get(stdout.find('{').unwrap_or(0)..).unwrap_or(&stdout);
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let list: Vec<String> = v
        .get("models")?
        .as_array()?
        .iter()
        // Keep models the user can actually pick (`visibility == "list"`, or no
        // visibility field). Drops internal/hidden entries like auto-review.
        .filter(|m| {
            m.get("visibility")
                .and_then(|x| x.as_str())
                .map(|s| s == "list")
                .unwrap_or(true)
        })
        .filter_map(|m| m.get("slug").and_then(|s| s.as_str()))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Run `<cli> models` and return its `provider/model` lines. Works for any CLI
/// whose `models` subcommand prints one id per line (opencode, kilo, agy).
/// Best-effort: returns `None` if the binary can't be found or run. Logs the
/// reason on failure so an empty picker isn't a silent mystery.
async fn cli_models(kind: ProviderKind) -> Option<Vec<String>> {
    let spec = cli_spec_for(kind);
    let name = kind.as_str();
    let Some(bin) = resolve_binary(spec.as_ref()) else {
        crate::log_line!("cli", "{name}_models: binary not resolved");
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
    if let Some(h) = crate::ai::cli_specs::home() {
        cmd.current_dir(h);
    }
    // `opencode`/`kilo models` fetch a REMOTE catalog — bound the wait so a slow
    // or unreachable network can't hang the model picker forever (the frontend
    // shows "Loading…" until this resolves). On timeout we return None and the
    // picker falls back to free-text entry.
    let output = match tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            crate::log_line!("cli", "{name}_models: spawn failed: {e}");
            return None;
        }
        Err(_) => {
            crate::log_line!("cli", "{name}_models: timed out after 20s");
            return None;
        }
    };
    // Don't early-return on a non-zero exit: some CLIs (agy) print a usable
    // model list to stdout yet exit non-zero. Parse stdout regardless; only
    // treat it as a failure if nothing usable comes back.
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Per-CLI line shape:
    //   • opencode / kilo → `provider/model` ids (single token, has a
    //     separator) so we can skip ASCII banners/footers.
    //   • antigravity (agy) → free-form display names with spaces, e.g.
    //     "Gemini 3.5 Flash (Medium)", which is exactly what `--model` accepts.
    let keep = |l: &str| -> bool {
        if l.is_empty() || !l.chars().any(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
        match kind {
            ProviderKind::Antigravity => true,
            _ => {
                !l.chars().any(char::is_whitespace)
                    && l.chars().any(|c| c == '/' || c == '-' || c == '.')
            }
        }
    };
    let list: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| keep(l))
        .collect();
    if list.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        crate::log_line!(
            "cli",
            "{name}_models: no models parsed (exit {}) stderr: {}",
            output.status,
            err.chars().take(300).collect::<String>()
        );
        return None;
    }
    crate::log_line!("cli", "{name}_models: {} models parsed", list.len());
    Some(list)
}

/// Augment a child command's `PATH` with the resolved binary's own directory plus
/// the common install dirs, so a Finder/Dock-launched app (minimal inherited
/// PATH) can still run CLIs that shell out to sibling tools.
fn augment_path_env(cmd: &mut tokio::process::Command, bin: &std::path::Path) {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    // Shared runtime locations (node managers, package managers, homebrew) so a
    // node-based CLI can resolve `node`. Same set used by the chat-spawn path.
    dirs.extend(crate::ai::cli_specs::runtime_path_dirs());
    let existing = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&existing));
    // Dedup while preserving first-seen order.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|p| seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(dirs) {
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
        ProviderKind::Kilo => Arc::new(KiloSpec),
        ProviderKind::Antigravity => Arc::new(AgySpec),
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
/// The path the wrapped CLIs should spawn to reach our MCP relay
/// (`<exe> __mcp-server ...`). In a packaged macOS build the real executable
/// lives at `/Applications/Table Relay.app/Contents/MacOS/table-relay` — a path
/// with a SPACE. Several MCP clients (codex among them) word-split or otherwise
/// mishandle a spaced `command`, so the relay never starts and every DB tool
/// fails in the .app while working fine in `cargo`/dev (whose path has no
/// spaces). To sidestep all quoting/splitting issues we expose a space-free
/// symlink to the real binary under `~/.tablerelay/bin` and register THAT path.
///
/// Falls back to the real path if the home dir itself has a space or the
/// symlink can't be created (the consumer may still handle quoting correctly).
fn mcp_command_path(real_exe: &std::path::Path) -> String {
    let real = real_exe.display().to_string();

    // AppImage: `current_exe()` is a per-run `/tmp/.mount_XXXX/...` path that is
    // GONE after the app exits. Writing it into the CLIs' persistent config files
    // would poison the user's standalone `codex`/`gemini`/... with a dead MCP
    // server entry. $APPIMAGE points at the stable .AppImage file; re-exec it
    // with the MCP args via a tiny wrapper under ~/.tablerelay/bin so the
    // recorded command survives across launches.
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        if let Some(home) = crate::ai::cli_specs::home() {
            let bin_dir = home.join(".tablerelay").join("bin");
            let wrapper = bin_dir.join("table-relay-mcp");
            let appimage = std::path::PathBuf::from(&appimage);
            let script = format!(
                "#!/bin/sh\nexec {:?} \"$@\"\n",
                appimage.display().to_string()
            );
            if std::fs::create_dir_all(&bin_dir).is_ok()
                && std::fs::write(&wrapper, script).is_ok()
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &wrapper,
                    std::fs::Permissions::from_mode(0o755),
                );
                if !wrapper.display().to_string().contains(' ') {
                    return wrapper.display().to_string();
                }
            }
            crate::log_line!("mcp", "AppImage wrapper write failed, using mount path");
        }
    }

    // No space → nothing to work around.
    if !real.contains(' ') {
        return real;
    }
    let Some(home) = crate::ai::cli_specs::home() else {
        return real;
    };
    let bin_dir = home.join(".tablerelay").join("bin");
    // If even this path has a space (unusual home dir), give up on the link.
    if bin_dir.display().to_string().contains(' ') {
        return real;
    }
    // Windows binaries need the .exe extension to be spawnable by name.
    let link_name = if cfg!(windows) { "table-relay.exe" } else { "table-relay" };
    let link = bin_dir.join(link_name);
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        crate::log_line!("mcp", "mcp link dir create failed: {e}");
        return real;
    }
    // Re-create each time so it tracks app moves/updates. Ignore a remove error
    // when it doesn't exist yet.
    let _ = std::fs::remove_file(&link);

    // Prefer a symlink (cheap, tracks the source). On Windows symlink_file needs
    // admin/Developer Mode — most users have neither — so fall back to a HARD
    // link (no privilege needed, same volume), then to a copy. Without this, the
    // Windows fallback returned the raw spaced path and re-broke MCP for clients
    // that word-split `command`.
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(real_exe, &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(real_exe, &link).is_ok()
        || std::fs::hard_link(real_exe, &link).is_ok()
        || std::fs::copy(real_exe, &link).is_ok();
    #[cfg(not(any(unix, windows)))]
    let linked = std::fs::hard_link(real_exe, &link).is_ok()
        || std::fs::copy(real_exe, &link).is_ok();

    if linked {
        link.display().to_string()
    } else {
        crate::log_line!("mcp", "mcp link create failed, using real path");
        real
    }
}

fn register_cli_mcp(
    kind: ProviderKind,
    bridge: &crate::ai::mcp_bridge::McpBridge,
) -> Option<String> {
    use crate::ai::mcp_server;
    let exe = match std::env::current_exe() {
        Ok(p) => mcp_command_path(&p),
        Err(e) => {
            crate::log_line!("mcp", "current_exe failed: {e}");
            return None;
        }
    };
    let (port, token) = (bridge.port, bridge.token.as_str());
    // Cross-platform home (USERPROFILE on Windows, HOME elsewhere).
    let home = crate::ai::cli_specs::home();
    if home.is_none() && !matches!(kind, ProviderKind::ClaudeCli) {
        // Every file-based CLI registration needs HOME; without it they all
        // silently no-op and the CLI runs with no DB tools. Make it visible.
        crate::log_line!(
            "mcp",
            "HOME/USERPROFILE not resolved — cannot register MCP for {}; DB tools will be unavailable",
            kind.as_str()
        );
    }
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
        // Kilo is opencode-compatible — same MCP config shape, written to
        // kilo's own config file.
        ProviderKind::Kilo => {
            if let Some(h) = &home {
                if let Err(e) = mcp_server::register_kilo(h, &exe, port, token) {
                    crate::log_line!("mcp", "kilo register failed: {e}");
                }
            }
            None
        }
        // Antigravity (agy) reads MCP servers from ~/.gemini/config/mcp_config.json.
        ProviderKind::Antigravity => {
            if let Some(h) = &home {
                if let Err(e) = mcp_server::register_antigravity(h, &exe, port, token) {
                    crate::log_line!("mcp", "antigravity register failed: {e}");
                }
            }
            None
        }
        _ => None,
    }
}
