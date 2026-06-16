//! Shared subprocess engine for the CLI-backed AI providers (Claude Code,
//! Codex, Gemini CLI, opencode).
//!
//! Each concrete provider supplies a [`CliSpec`] describing how to find its
//! binary, build the headless argv, and parse one line of its JSON/text output
//! into incremental assistant text. This module owns everything else: binary
//! resolution, spawning with `tokio::process`, streaming stdout line-by-line
//! into `TokenChunk`s, a per-request cancel map, and wall-clock / output-size
//! runaway guards.
//!
//! We never read or inject the CLI's credentials — the user authenticates the
//! CLI outside the app; we only spawn its documented non-interactive surface.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::{
    AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, FinishReason, ProviderKind,
    TokenChunk,
};

/// Hard caps so a wedged CLI can't hang the chat forever.
const MAX_WALL_CLOCK: Duration = Duration::from_secs(600);
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// What one parsed stdout line yields. A line may carry text, signal the end,
/// signal an error, or be ignorable (metadata/keepalive).
pub enum LineEvent {
    /// Append this incremental text to the assistant message.
    Delta(String),
    /// Terminal success — the run finished. Optional final text (for CLIs that
    /// only emit the whole answer at the end rather than deltas).
    Done(Option<String>),
    /// Terminal failure with a message to surface to the user.
    Failed(String),
    /// Nothing to emit (init events, usage stats, blank lines).
    Ignore,
}

/// Per-CLI behaviour. Pure functions + data so the engine stays generic.
pub trait CliSpec: Send + Sync + 'static {
    fn kind(&self) -> ProviderKind;
    /// Candidate absolute paths to probe in addition to PATH (npm global bins,
    /// native installers, etc.).
    fn extra_paths(&self) -> Vec<PathBuf>;
    /// The binary name to resolve on PATH (e.g. "claude").
    fn binary_name(&self) -> &'static str;
    /// Build the argv (excluding the binary) for a one-shot headless run.
    /// `prompt` is the flattened conversation; `model` the chosen model id;
    /// `mcp_config_path` is a JSON/config file exposing host DB tools when the
    /// CLI takes an MCP-config *flag* (Claude). File-based registrations
    /// (Codex/Gemini/opencode) are handled out-of-band and ignore this.
    fn build_args(&self, prompt: &str, model: &str, mcp_config_path: Option<&str>) -> Vec<String>;
    /// Whether the prompt is passed via stdin instead of argv. opencode/gemini
    /// differ here; defaults to false (argv).
    fn prompt_via_stdin(&self) -> bool {
        false
    }
    /// Extra env vars to set for the child (e.g. GEMINI_SYSTEM_MD).
    fn extra_env(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    /// Parse one line of stdout into an event.
    fn parse_line(&self, line: &str) -> LineEvent;
    /// Whether a non-zero process exit should be ignored when the CLI already
    /// produced output. Some CLIs (e.g. `agy`) exit non-zero even on a
    /// successful run, which would otherwise append a spurious "[CLI exited with
    /// an error]" after a perfectly good reply. Defaults to false.
    fn tolerate_nonzero_exit(&self) -> bool {
        false
    }
}

/// Resolve the CLI binary: PATH first (via `which`, cross-platform), then the
/// spec's known install locations.
pub fn resolve_binary(spec: &dyn CliSpec) -> Option<PathBuf> {
    if let Ok(p) = which::which(spec.binary_name()) {
        return Some(p);
    }
    for cand in spec.extra_paths() {
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Build the spawn `Command` for a resolved binary + args, cross-platform.
///
/// On Windows, npm-installed CLIs are `.cmd`/`.bat` batch shims, which the OS
/// `CreateProcess` (and thus `tokio::process`) cannot execute directly — they
/// must run through `cmd.exe /C`. Real `.exe` binaries spawn directly. On Unix
/// every CLI is a normal executable, so we spawn it directly.
pub(crate) fn build_command(bin: &std::path::Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let is_batch = bin
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let e = e.to_ascii_lowercase();
                // npm/installer shims come as .cmd, .bat, AND .ps1 — all of which
                // CreateProcess can't run directly. Route every non-.exe shim
                // through a shell. (.ps1 needs PowerShell, handled below.)
                e == "cmd" || e == "bat"
            })
            .unwrap_or(false);
        if is_batch {
            // SECURITY: the prompt arg is arbitrary user chat text and WILL
            // contain cmd.exe metacharacters (& | < > ^ ( ) %"). Passing it as a
            // normal arg lets cmd.exe re-parse them — a command-injection vector
            // and a parsing-breakage bug. We build the entire command line
            // ourselves with `raw_arg`, quoting the program and each arg and
            // caret-escaping cmd metacharacters so cmd treats them as literal.
            let mut cmd = Command::new("cmd");
            cmd.raw_arg("/C");
            cmd.raw_arg(format!(" {}", cmd_quote(&bin.to_string_lossy())));
            for a in args {
                cmd.raw_arg(format!(" {}", cmd_quote(a)));
            }
            no_window(&mut cmd);
            return cmd;
        }
    }
    let mut cmd = Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    no_window(&mut cmd);
    cmd
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Quote + caret-escape a single argument for safe passage through `cmd.exe /C`.
/// Wraps in double quotes (so spaces are one arg), doubles embedded quotes, then
/// caret-escapes the cmd metacharacters that are special even inside quotes
/// (`%` and `!` notably, plus the shell operators) so user text can't break out.
#[cfg(windows)]
fn cmd_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\"\""), // double up embedded quotes
            // Carets escape these for cmd's parser. Inside quotes most are inert,
            // but %VAR% and !VAR! expansion still fire, and being defensive about
            // the operators costs nothing.
            '%' | '!' | '^' | '&' | '|' | '<' | '>' | '(' | ')' => {
                out.push('^');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Prepend the CLI binary's own directory plus the common runtime dirs
/// (node managers, package managers, homebrew) to the child's `PATH`, then the
/// inherited PATH. Lets a Finder-launched app (minimal PATH) run node-based CLIs
/// that shell out to `node`/sibling tools. Deduped, order-preserving.
fn augment_path(cmd: &mut Command, bin: &std::path::Path) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    dirs.extend(crate::ai::cli_specs::runtime_path_dirs());
    dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    // Dedup while preserving first-seen order.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|p| seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(dirs) {
        cmd.env("PATH", joined);
    }
}

/// A generic CLI provider parameterized by a [`CliSpec`].
pub struct CliProvider {
    spec: Arc<dyn CliSpec>,
    bin: PathBuf,
    model: String,
    /// Path to a generated MCP config file exposing host DB tools (when used).
    mcp_config_path: Option<String>,
    inflight: Arc<Mutex<HashMap<String, Child>>>,
}

impl CliProvider {
    pub fn new(
        spec: Arc<dyn CliSpec>,
        bin: PathBuf,
        model: String,
        mcp_config_path: Option<String>,
    ) -> Self {
        Self {
            spec,
            bin,
            model,
            mcp_config_path,
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Flatten chat history into a single prompt string the CLIs accept. CLIs are
/// session/stateless headless tools — they don't take an OpenAI message array —
/// so we render the turns as a readable transcript and let the CLI answer the
/// final user turn.
fn flatten_prompt(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        let tag = match m.role {
            ChatRole::System => "System",
            ChatRole::User => "User",
            ChatRole::Assistant => "Assistant",
            ChatRole::Tool => "Tool",
        };
        if m.content.trim().is_empty() {
            continue;
        }
        out.push_str(tag);
        out.push_str(":\n");
        out.push_str(&m.content);
        out.push_str("\n\n");
    }
    out.push_str("Assistant:\n");
    out
}

#[async_trait]
impl AiProvider for CliProvider {
    fn name(&self) -> String {
        let label = match self.spec.kind() {
            ProviderKind::ClaudeCli => "Claude Code CLI",
            ProviderKind::CodexCli => "Codex CLI",
            ProviderKind::GeminiCli => "Gemini CLI",
            ProviderKind::Opencode => "opencode",
            ProviderKind::Kilo => "Kilo CLI",
            ProviderKind::Antigravity => "Antigravity CLI",
            _ => "CLI",
        };
        if self.model.is_empty() {
            label.to_string()
        } else {
            format!("{label} ({})", self.model)
        }
    }

    fn kind(&self) -> ProviderKind {
        self.spec.kind()
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        let prompt = flatten_prompt(&req.messages);
        let via_stdin = self.spec.prompt_via_stdin();
        let args = self.spec.build_args(
            if via_stdin { "" } else { &prompt },
            &self.model,
            self.mcp_config_path.as_deref(),
        );
        // Log the model + the non-prompt flags so it's verifiable that the
        // user's selected model actually reaches the CLI. We strip the (huge)
        // prompt arg from the logged args to keep the line readable.
        let flag_preview: Vec<&str> = args
            .iter()
            .map(|a| a.as_str())
            .filter(|a| a.len() < 80) // drop the flattened-prompt arg
            .collect();
        crate::log_line!(
            "cli",
            "{} complete: model={:?} bin={} msgs={} promptChars={} args={:?}",
            self.spec.binary_name(),
            if self.model.is_empty() { "<default>" } else { &self.model },
            self.bin.display(),
            req.messages.len(),
            prompt.len(),
            flag_preview,
        );

        let mut cmd = build_command(&self.bin, &args);
        cmd.stdin(if via_stdin { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Run from the user's home rather than inheriting the app's cwd. A
        // packaged .app launched from Finder has cwd `/`, which confuses some
        // CLIs (e.g. codex's git-repo trust check). Home is always present and
        // writable; we don't rely on the CLI's working directory for anything.
        if let Some(home) = crate::ai::cli_specs::home() {
            cmd.current_dir(home);
        }
        // Augment PATH with node-manager / package-manager dirs. A Finder-
        // launched app inherits a minimal PATH, so node-based CLIs like `claude`
        // (`#!/usr/bin/env node`) fail with "env: node: No such file or
        // directory" even when the CLI binary itself was located. Prepend the
        // common runtime locations (nvm/volta/fnm/homebrew/...) so `node` and any
        // sibling tools resolve.
        augment_path(&mut cmd, &self.bin);
        for (k, v) in self.spec.extra_env() {
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| AiError::Other(format!("failed to spawn {}: {e}", self.spec.binary_name())))?;

        // Feed the prompt over stdin when the CLI wants it that way.
        if via_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(prompt.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AiError::Other("child stdout unavailable".into()))?;
        // Capture stderr so a failed run can surface the CLI's own error text
        // (e.g. "run `claude login`") instead of a silent empty stream.
        let stderr = child.stderr.take();

        // Register for cancel. The inflight map is an Arc shared with the
        // stream, so cancel() (on the provider) and the stream's own cleanup
        // both reach the same child handle.
        let request_id = req.request_id.clone();
        self.inflight.lock().await.insert(request_id.clone(), child);

        let spec = self.spec.clone();
        let inflight_key = request_id.clone();
        let inflight = self.inflight.clone();

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        // Keep the stderr-reader handle so we can JOIN it before reading the
        // buffer at EOF — otherwise the buffer may still be empty (race) and a
        // real error (e.g. "run `claude login`") would be lost.
        let stderr_task = stderr.map(|stderr| {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let mut g = buf.lock().await;
                    if g.len() < 4096 {
                        g.push_str(&l);
                        g.push('\n');
                    }
                }
            })
        });

        let out = async_stream::stream! {
            let started = std::time::Instant::now();
            let mut reader = BufReader::new(stdout).lines();
            let mut bytes_seen = 0usize;
            let mut finished = false;
            let mut emitted_any = false;
            // Idle finish: once the model has produced output, a long silence
            // means the run is effectively done even if the process hasn't
            // closed stdout (a lingering child holding the pipe). Without this,
            // Codex/opencode — whose terminal events we Ignore in favour of EOF —
            // could hang to the 600s wall clock and then append a spurious
            // "[CLI timed out]". We only idle-finish AFTER real output, so a slow
            // first token (model still thinking / tool round-trip) never trips it.
            let mut idle_ticks = 0u32;
            const IDLE_TICK_SECS: u64 = 5;
            const IDLE_FINISH_AFTER_TICKS: u32 = 6; // 30s of silence post-output

            loop {
                // Wall-clock guard.
                if started.elapsed() > MAX_WALL_CLOCK {
                    yield TokenChunk { request_id: request_id.clone(), delta: "\n[CLI timed out]".into(), finish_reason: Some(FinishReason::Error) };
                    finished = true;
                    break;
                }
                let next = tokio::time::timeout(Duration::from_secs(IDLE_TICK_SECS), reader.next_line()).await;
                let line = match next {
                    Err(_) => {
                        // Idle tick. If we've already streamed output and the
                        // process has gone quiet for a while, treat the run as
                        // complete rather than waiting for EOF/wall-clock.
                        if emitted_any {
                            idle_ticks += 1;
                            if idle_ticks >= IDLE_FINISH_AFTER_TICKS {
                                yield TokenChunk { request_id: request_id.clone(), delta: String::new(), finish_reason: Some(FinishReason::Stop) };
                                finished = true;
                                break;
                            }
                        }
                        continue;
                    }
                    Ok(Ok(Some(l))) => l,
                    Ok(Ok(None)) => break, // EOF
                    Ok(Err(_)) => break,   // read error
                };
                idle_ticks = 0; // any line resets the idle counter
                bytes_seen += line.len() + 1;
                if bytes_seen > MAX_OUTPUT_BYTES {
                    yield TokenChunk { request_id: request_id.clone(), delta: "\n[CLI output too large — truncated]".into(), finish_reason: Some(FinishReason::Error) };
                    finished = true;
                    break;
                }
                match spec.parse_line(&line) {
                    LineEvent::Delta(text) => {
                        if !text.is_empty() {
                            emitted_any = true;
                            yield TokenChunk { request_id: request_id.clone(), delta: text, finish_reason: None };
                        }
                    }
                    LineEvent::Done(final_text) => {
                        if let Some(t) = final_text {
                            // Only emit if we haven't been streaming deltas
                            // (avoids double-printing the whole answer).
                            if !emitted_any && !t.is_empty() {
                                yield TokenChunk { request_id: request_id.clone(), delta: t, finish_reason: None };
                            }
                        }
                        yield TokenChunk { request_id: request_id.clone(), delta: String::new(), finish_reason: Some(FinishReason::Stop) };
                        finished = true;
                        break;
                    }
                    LineEvent::Failed(msg) => {
                        let detail = {
                            let g = stderr_buf.lock().await;
                            if g.trim().is_empty() { msg } else { format!("{msg}\n{}", g.trim()) }
                        };
                        yield TokenChunk { request_id: request_id.clone(), delta: detail, finish_reason: Some(FinishReason::Error) };
                        finished = true;
                        break;
                    }
                    LineEvent::Ignore => {}
                }
            }

            // Reap the child FIRST so we know its exit status, and join the
            // stderr reader so its buffer is complete before we inspect it.
            let exit_ok = {
                if let Some(mut child) = inflight.lock().await.remove(&inflight_key) {
                    let _ = child.start_kill();
                    match child.wait().await {
                        Ok(status) => status.success(),
                        Err(_) => false,
                    }
                } else {
                    // Already reaped by cancel() — treat as a clean stop.
                    true
                }
            };
            if let Some(t) = stderr_task {
                let _ = t.await;
            }
            let stderr_text = { stderr_buf.lock().await.trim().to_string() };

            // Stream ended without an explicit Done/Failed/Stop — decide based on
            // exit status, so a non-zero exit (even AFTER partial output) is
            // surfaced as an error instead of a silently-truncated "success".
            // Some CLIs exit non-zero even on success (agy). If this spec opts
            // in AND we already streamed a reply, don't treat the non-zero exit
            // as a failure — the user got their answer.
            let exit_ok = exit_ok || (spec.tolerate_nonzero_exit() && emitted_any);
            if !finished {
                if !exit_ok {
                    // Process failed. Show its stderr (the real reason) appended
                    // to whatever partial text already streamed.
                    let msg = if stderr_text.is_empty() {
                        "\n[CLI exited with an error]".to_string()
                    } else if emitted_any {
                        format!("\n[CLI error] {stderr_text}")
                    } else {
                        stderr_text.clone()
                    };
                    yield TokenChunk { request_id: request_id.clone(), delta: msg, finish_reason: Some(FinishReason::Error) };
                } else if !emitted_any {
                    // Clean exit (or tolerated non-zero) but we streamed nothing.
                    // Surface stderr if present, otherwise an explicit placeholder
                    // so an empty reply is visibly distinct from a real answer
                    // (a blank bubble reads as a hang/bug to the user).
                    if stderr_text.is_empty() {
                        yield TokenChunk { request_id: request_id.clone(), delta: "[no output from CLI]".into(), finish_reason: Some(FinishReason::Error) };
                    } else {
                        yield TokenChunk { request_id: request_id.clone(), delta: stderr_text, finish_reason: Some(FinishReason::Error) };
                    }
                } else {
                    yield TokenChunk { request_id: request_id.clone(), delta: String::new(), finish_reason: Some(FinishReason::Stop) };
                }
            }
        };

        Ok(out.boxed())
    }

    async fn cancel(&self, request_id: &str) {
        if let Some(mut child) = self.inflight.lock().await.remove(request_id) {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    async fn unload(&self) {
        // Kill any still-running children.
        let mut map = self.inflight.lock().await;
        for (_, mut child) in map.drain() {
            let _ = child.start_kill();
        }
    }
}
