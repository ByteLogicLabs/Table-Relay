//! Shared subprocess engine for the CLI-backed AI providers (Claude Code,
//! Codex, Gemini CLI, opencode, Kilo, Antigravity). A CLI that only writes to
//! a console runs under a pseudo console on Windows (see `conpty`).
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

/// See [`CliSpec::stalls_on_stderr_errors`].
const STALL_AFTER: Duration = Duration::from_secs(90);

/// Stderr kept for error reports: the most recent part, since the reason a run
/// failed is usually logged last.
const STDERR_KEEP: usize = 6_000;
/// Per stderr line. The end is kept: some CLIs log whole request bodies and
/// put the provider's error message at the end of the line.
const STDERR_LINE_KEEP: usize = 1_500;
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
    /// Whether stdout is a single JSON document that may be pretty-printed
    /// across lines. The engine then hands `parse_line` the document gathered
    /// so far (from its first `{` line) instead of each line on its own —
    /// line-by-line, a pretty-printed reply never parsed and the run ended as
    /// "[no output from CLI]". Defaults to false (one event per line).
    fn whole_output_json(&self) -> bool {
        false
    }
    /// Whether the CLI writes its answer to a console only, never to a
    /// redirected stdout (`agy` on Windows). It then runs under a pseudo
    /// console. Windows only; ignored elsewhere.
    fn needs_console(&self) -> bool {
        false
    }
    /// Whether a run that has printed nothing on stdout for
    /// [`STALL_AFTER`] while logging errors on stderr is stuck rather than
    /// slow. opencode/kilo retry a failing provider forever without a word on
    /// stdout — the chat sat on "thinking" for ~9 minutes before failing with
    /// no reason. Only for CLIs that print events as soon as the model starts.
    fn stalls_on_stderr_errors(&self) -> bool {
        false
    }
    /// Whether a non-zero process exit should be ignored when the CLI already
    /// produced output. Some CLIs (e.g. `agy`) exit non-zero even on a
    /// successful run, which would otherwise append a spurious "[CLI exited with
    /// an error]" after a perfectly good reply. Defaults to false.
    fn tolerate_nonzero_exit(&self) -> bool {
        false
    }
    /// If this CLI can't run headless (no machine-readable stdout), return a
    /// user-facing reason; the engine surfaces it instead of spawning. Default
    /// `None` (works headless).
    fn unsupported_reason(&self) -> Option<String> {
        None
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
/// On Windows, npm CLI shims run through `cmd.exe`, whose 8191-char command line
/// the large prompt+schema overflows ("The command line is too long."). So we
/// first run the shim's underlying `node <script>` directly (no shell, ~32767
/// limit), falling back to `cmd /C` only when the shim can't be parsed. Real
/// `.exe`s and all Unix binaries spawn directly.
pub(crate) fn build_command(bin: &std::path::Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        if let Some((node, script)) = node_target_from_npm_shim(bin) {
            let mut cmd = Command::new(node);
            cmd.arg(script);
            cmd.args(args);
            no_window(&mut cmd);
            return cmd;
        }
        let is_batch = bin
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let e = e.to_ascii_lowercase();
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

/// If `bin` is an npm `.cmd`/`.bat`/`.ps1` shim, extract the `(node.exe, script)`
/// it execs so the caller can run it directly and skip `cmd.exe`. The shims embed
/// the entry as a quoted path containing `node_modules`, rooted at the shim's dir
/// (`%dp0%`/`$basedir`). Returns `None` for real `.exe`s or any unparseable shim.
#[cfg(windows)]
fn node_target_from_npm_shim(bin: &std::path::Path) -> Option<(PathBuf, PathBuf)> {
    let ext = bin
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("cmd") | Some("bat") | Some("ps1")) {
        return None;
    }
    let content = std::fs::read_to_string(bin).ok()?;
    let dir = bin.parent()?;

    let raw = content
        .split('"')
        .find(|seg| seg.contains("node_modules"))?;
    let rel = raw
        .replace("%~dp0", "")
        .replace("%dp0%", "")
        .replace("$basedir", "")
        .replace('/', "\\");
    let script = dir.join(rel.trim_start_matches('\\'));
    if !script.is_file() {
        return None;
    }

    let local_node = dir.join("node.exe");
    let node = if local_node.is_file() {
        local_node
    } else {
        which::which("node").ok()?
    };
    Some((node, script))
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
    if let Some(path) = augmented_path(bin) {
        cmd.env("PATH", path);
    }
}

/// `PATH` for a spawned CLI: its own dir, the runtime dirs, then the
/// inherited entries (deduped, first wins).
pub(crate) fn augmented_path(bin: &std::path::Path) -> Option<std::ffi::OsString> {
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
    std::env::join_paths(dirs).ok()
}

/// Where a running CLI's output lines come from.
enum LineSource {
    Pipe(tokio::io::Lines<BufReader<tokio::process::ChildStdout>>),
    #[cfg(windows)]
    Console(tokio::sync::mpsc::UnboundedReceiver<String>),
}

impl LineSource {
    /// Next line; cancel-safe (the stream polls it under a timeout).
    async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        match self {
            LineSource::Pipe(lines) => lines.next_line().await,
            #[cfg(windows)]
            LineSource::Console(rx) => Ok(rx.recv().await),
        }
    }
}

/// A started CLI process.
enum Running {
    Pipe(Child),
    #[cfg(windows)]
    Console(crate::ai::conpty::PtyProcess),
}

impl Running {
    fn start_kill(&mut self) {
        match self {
            Running::Pipe(child) => {
                let _ = child.start_kill();
            }
            #[cfg(windows)]
            Running::Console(p) => p.kill(),
        }
    }

    /// Wait for exit; whether it succeeded.
    async fn wait_success(&mut self) -> bool {
        match self {
            Running::Pipe(child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
            #[cfg(windows)]
            Running::Console(p) => p.wait().await == Some(0),
        }
    }
}

/// A short reason from a CLI's stderr: the provider's own message when one is
/// embedded in the last error line (`"message":"…"`), else that line clipped.
fn stderr_reason(stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.to_ascii_lowercase().contains("error"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))?;
    // The message may sit in JSON embedded as a string (escaped quotes) or in
    // plain JSON; the last occurrence is the innermost / most recent.
    for pat in ["\"message\":\"", "\\\"message\\\":\\\""] {
        if let Some(start) = line.rfind(pat) {
            let rest = &line[start + pat.len()..];
            let end = rest.find(['"', '\\']).unwrap_or(rest.len());
            let msg = rest[..end].trim();
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    let line = line.trim();
    let clipped = if line.len() > 300 {
        let mut start = line.len() - 300;
        while !line.is_char_boundary(start) {
            start += 1;
        }
        format!("…{}", &line[start..])
    } else {
        line.to_string()
    };
    Some(clipped)
}

/// A generic CLI provider parameterized by a [`CliSpec`].
pub struct CliProvider {
    spec: Arc<dyn CliSpec>,
    bin: PathBuf,
    model: String,
    /// Path to a generated MCP config file exposing host DB tools (when used).
    mcp_config_path: Option<String>,
    inflight: Arc<Mutex<HashMap<String, Running>>>,
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

impl CliProvider {
    /// Start the CLI: piped stdio normally, under a pseudo console for a CLI
    /// that only writes to a console (see [`CliSpec::needs_console`]).
    async fn start(
        &self,
        args: &[String],
        stdin_prompt: Option<&str>,
    ) -> Result<(LineSource, Running, Option<tokio::process::ChildStderr>), AiError> {
        let spawn_err = |e: std::io::Error| AiError::Other(format!("failed to spawn {}: {e}", self.spec.binary_name()));
        // Run from the user's home rather than inheriting the app's cwd. A
        // packaged .app launched from Finder has cwd `/`, which confuses some
        // CLIs (e.g. codex's git-repo trust check). Home is always present and
        // writable; we don't rely on the CLI's working directory for anything.
        let home = crate::ai::cli_specs::home();

        #[cfg(windows)]
        if self.spec.needs_console() {
            let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = self
                .spec
                .extra_env()
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect();
            if let Some(path) = augmented_path(&self.bin) {
                env.push(("PATH".into(), path));
            }
            let spawned = crate::ai::conpty::spawn(&self.bin, args, home.as_deref(), &env).map_err(spawn_err)?;
            return Ok((LineSource::Console(spawned.lines), Running::Console(spawned.process), None));
        }

        let mut cmd = build_command(&self.bin, args);
        cmd.stdin(if stdin_prompt.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = home {
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

        let mut child = cmd.spawn().map_err(spawn_err)?;

        // Feed the prompt over stdin when the CLI wants it that way.
        if let Some(prompt) = stdin_prompt {
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
        Ok((LineSource::Pipe(BufReader::new(stdout).lines()), Running::Pipe(child), stderr))
    }
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
        // CLIs with no headless stdout mode (e.g. `agy` on Windows) would only
        // yield "[no output from CLI]"; surface their reason as the reply instead.
        if let Some(reason) = self.spec.unsupported_reason() {
            let request_id = req.request_id.clone();
            crate::log_line!(
                "cli",
                "{} unsupported headless: surfacing message",
                self.spec.binary_name()
            );
            let out = async_stream::stream! {
                yield TokenChunk {
                    request_id,
                    delta: reason,
                    finish_reason: Some(FinishReason::Error),
                };
            };
            return Ok(out.boxed());
        }

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

        let (reader, running, stderr) =
            self.start(&args, via_stdin.then_some(prompt.as_str())).await?;

        // Register for cancel. The inflight map is an Arc shared with the
        // stream, so cancel() (on the provider) and the stream's own cleanup
        // both reach the same child handle.
        let request_id = req.request_id.clone();
        self.inflight.lock().await.insert(request_id.clone(), running);

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
                    let mut kept = l.as_str();
                    if kept.len() > STDERR_LINE_KEEP {
                        let mut start = kept.len() - STDERR_LINE_KEEP;
                        while !kept.is_char_boundary(start) {
                            start += 1;
                        }
                        kept = &kept[start..];
                    }
                    let mut g = buf.lock().await;
                    g.push_str(kept);
                    g.push('\n');
                    if g.len() > STDERR_KEEP {
                        let mut cut = g.len() - STDERR_KEEP;
                        while !g.is_char_boundary(cut) {
                            cut += 1;
                        }
                        g.drain(..cut);
                    }
                }
            })
        });

        let out = async_stream::stream! {
            let started = std::time::Instant::now();
            let mut reader = reader;
            let mut last_line_at = std::time::Instant::now();
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
            // The JSON document so far, for `whole_output_json` CLIs.
            let mut doc_buf = String::new();
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
                        //
                        // Silence while one of our MCP tools runs — or waits for
                        // the user's approval, which can take minutes — is the
                        // agent working, not finished: cutting the run there
                        // threw away the final answer and left the approval card
                        // live with nothing waiting on it.
                        if crate::ai::mcp_bridge::tool_activity_within(Duration::from_secs(IDLE_TICK_SECS)) {
                            idle_ticks = 0;
                            last_line_at = std::time::Instant::now();
                        } else if !emitted_any
                            && spec.stalls_on_stderr_errors()
                            && last_line_at.elapsed() >= STALL_AFTER
                        {
                            let reason = stderr_reason(&stderr_buf.lock().await);
                            if let Some(reason) = reason {
                                let msg = format!(
                                    "{} has produced no reply for {}s and keeps logging errors, so it was stopped. Last error: {reason}",
                                    spec.binary_name(),
                                    STALL_AFTER.as_secs()
                                );
                                yield TokenChunk { request_id: request_id.clone(), delta: msg, finish_reason: Some(FinishReason::Error) };
                                finished = true;
                                break;
                            }
                        } else if emitted_any {
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
                last_line_at = std::time::Instant::now();
                bytes_seen += line.len() + 1;
                if bytes_seen > MAX_OUTPUT_BYTES {
                    yield TokenChunk { request_id: request_id.clone(), delta: "\n[CLI output too large — truncated]".into(), finish_reason: Some(FinishReason::Error) };
                    finished = true;
                    break;
                }
                let event = if !spec.whole_output_json() {
                    spec.parse_line(&line)
                } else if doc_buf.is_empty() && !line.trim_start().starts_with('{') {
                    // Banner/warning text printed before the document.
                    LineEvent::Ignore
                } else {
                    doc_buf.push_str(&line);
                    doc_buf.push('\n');
                    if line.trim_end().ends_with('}') {
                        spec.parse_line(&doc_buf)
                    } else {
                        LineEvent::Ignore
                    }
                };
                match event {
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
                        let detail = match stderr_reason(&stderr_buf.lock().await) {
                            Some(reason)
                                if msg.len() < 40 && !msg.contains(&reason) && !reason.contains(&msg) =>
                            {
                                format!("{msg}\n{reason}")
                            }
                            _ => msg,
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
                    child.start_kill();
                    child.wait_success().await
                } else {
                    // Already reaped by cancel() — treat as a clean stop.
                    true
                }
            };
            if let Some(t) = stderr_task {
                let _ = t.await;
            }
            let stderr_text = stderr_reason(&stderr_buf.lock().await).unwrap_or_default();

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
            child.start_kill();
            let _ = child.wait_success().await;
        }
    }

    async fn unload(&self) {
        // Kill any still-running children.
        let mut map = self.inflight.lock().await;
        for (_, mut child) in map.drain() {
            child.start_kill();
        }
    }
}

#[cfg(all(test, windows))]
mod windows_shim_tests {
    use super::*;
    use std::fs;

    // Locks the npm-shim parser that every node-based CLI (claude, codex, kilo,
    // opencode, gemini) relies on to bypass cmd.exe's 8191-char limit.
    #[test]
    fn parses_npm_cmd_shim_to_node_target() {
        let base = std::env::temp_dir().join(format!("tr-shim-cmd-{}", std::process::id()));
        let bindir = base
            .join("node_modules")
            .join("@scope")
            .join("pkg")
            .join("bin");
        fs::create_dir_all(&bindir).unwrap();
        fs::write(bindir.join("tool"), "// entry").unwrap();
        fs::write(base.join("node.exe"), "fake").unwrap();
        let shim = base.join("tool.cmd");
        fs::write(
            &shim,
            "@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & \"%_prog%\"  \
             \"%dp0%\\node_modules\\@scope\\pkg\\bin\\tool\" %*\r\n",
        )
        .unwrap();

        let (node, script) = node_target_from_npm_shim(&shim).expect("cmd shim should parse");
        assert_eq!(node, base.join("node.exe")); // prefers sibling node.exe
        assert_eq!(script, bindir.join("tool"));

        fs::remove_dir_all(&base).ok();
    }

    // .ps1 shims use $basedir + forward slashes; same extraction must hold.
    #[test]
    fn parses_npm_ps1_shim_to_node_target() {
        let base = std::env::temp_dir().join(format!("tr-shim-ps1-{}", std::process::id()));
        let bindir = base.join("node_modules").join("pkg").join("bin");
        fs::create_dir_all(&bindir).unwrap();
        fs::write(bindir.join("tool"), "// entry").unwrap();
        fs::write(base.join("node.exe"), "fake").unwrap();
        let shim = base.join("tool.ps1");
        fs::write(&shim, "& \"node$exe\"  \"$basedir/node_modules/pkg/bin/tool\" $args\r\n").unwrap();

        let (_, script) = node_target_from_npm_shim(&shim).expect("ps1 shim should parse");
        assert_eq!(script, bindir.join("tool"));

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn real_exe_is_not_treated_as_a_shim() {
        assert!(node_target_from_npm_shim(std::path::Path::new("C:\\x\\claude.exe")).is_none());
    }
}
