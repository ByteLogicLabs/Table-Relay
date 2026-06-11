//! Per-CLI [`CliSpec`] implementations: argv + stdout parsing for each coding
//! CLI we wrap. Flags/JSON shapes verified against current (2025/2026) docs:
//!
//!   • Claude Code: `claude -p <prompt> --output-format stream-json --verbose
//!     --include-partial-messages [--model M] [--mcp-config FILE]`
//!     deltas = stream_event/.event.delta.text; done = type:"result".
//!   • Codex: `codex exec --json [-m M] <prompt>`; final =
//!     item.completed/agent_message/.item.text; done = turn.completed.
//!   • Gemini: `gemini -p <prompt> --output-format json [-m M]` (single JSON
//!     object with `.response`); MCP via ~/.gemini/settings.json (out-of-band).
//!   • opencode: `opencode run --format json [-m M] <prompt>`; text events
//!     carry `.part.text`; done = step_finish.

use std::path::PathBuf;

use serde_json::Value;

use super::cli_provider::{CliSpec, LineEvent};
use super::ProviderKind;

/// The user's home directory, cross-platform. Unix uses `$HOME`; Windows uses
/// `%USERPROFILE%` (with `%HOMEDRIVE%%HOMEPATH%` as a fallback).
pub(crate) fn home() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut p = PathBuf::from(drive);
                p.push(path);
                Some(p)
            })
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Common npm-global / native install locations to probe when a CLI isn't on
/// PATH. This matters a lot for GUI apps: an app launched from Finder/Dock (or
/// the Windows Start menu) inherits a minimal PATH with no nvm/bun/homebrew
/// shims, so `which` alone misses CLIs that resolve fine in a terminal. These
/// fallbacks fill that gap on macOS, Linux, and Windows.
fn npm_global_candidates(bin: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let h = home();

    if cfg!(windows) {
        // npm global installs land a `<bin>.cmd` shim in %APPDATA%\npm; bun uses
        // %USERPROFILE%\.bun\bin. `which::which` honours PATHEXT so probing the
        // bare name AND the .cmd/.exe variants covers both shims and real exes.
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            for name in win_names(bin) {
                out.push(appdata.join("npm").join(&name));
            }
        }
        if let Some(h) = &h {
            for sub in [".bun/bin", ".local/bin", "bin"] {
                for name in win_names(bin) {
                    out.push(h.join(sub).join(&name));
                }
            }
            for dir in nvm_version_bins(h) {
                for name in win_names(bin) {
                    out.push(dir.join(&name));
                }
            }
        }
        // nvm-windows symlinks the active version here.
        if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            for name in win_names(bin) {
                out.push(pf.join("nodejs").join(&name));
            }
        }
    } else {
        if let Some(h) = &h {
            out.push(h.join(".npm-global/bin").join(bin));
            out.push(h.join(".local/bin").join(bin));
            out.push(h.join("node_modules/.bin").join(bin));
            out.push(h.join(".bun/bin").join(bin)); // bun global installs
            out.push(h.join("bin").join(bin)); // ~/bin
            // nvm keeps node bins under versioned dirs — probe every installed
            // version's bin so an nvm-managed CLI still resolves without a shell.
            for dir in nvm_version_bins(h) {
                out.push(dir.join(bin));
            }
        }
        // Homebrew (Apple Silicon + Intel) and the standard Unix bins.
        out.push(PathBuf::from(format!("/opt/homebrew/bin/{bin}")));
        out.push(PathBuf::from(format!("/usr/local/bin/{bin}")));
        out.push(PathBuf::from(format!("/usr/bin/{bin}")));
    }
    out
}

/// Windows executable name variants to probe for a bare command name: the name
/// as-is (in case it already has an extension) plus the common shim/exe forms.
#[cfg(windows)]
fn win_names(bin: &str) -> Vec<String> {
    vec![
        format!("{bin}.cmd"),
        format!("{bin}.exe"),
        format!("{bin}.ps1"),
        bin.to_string(),
    ]
}

/// On non-Windows this is unused; keep a stub so call sites compile uniformly.
#[cfg(not(windows))]
#[allow(dead_code)]
fn win_names(bin: &str) -> Vec<String> {
    vec![bin.to_string()]
}

/// Probe a CLI's native-installer location under the home dir. `rel_dir` is the
/// install subdirectory (e.g. `.opencode/bin`); we push the bare binary on Unix
/// and the `.cmd`/`.exe`/bare variants on Windows.
fn native_install_candidates(home: &std::path::Path, rel_dir: &str, bin: &str) -> Vec<PathBuf> {
    let dir = home.join(rel_dir);
    if cfg!(windows) {
        win_names(bin).into_iter().map(|n| dir.join(n)).collect()
    } else {
        vec![dir.join(bin)]
    }
}

/// Enumerate nvm's per-version node bin directories (best-effort). On Unix nvm
/// uses `~/.nvm/versions/node/*/bin`; nvm-windows installs under
/// `%APPDATA%\nvm\*` with the binaries directly in the version dir. Empty if
/// nvm isn't installed or the dir can't be read.
fn nvm_version_bins(home: &std::path::Path) -> Vec<PathBuf> {
    let base = if cfg!(windows) {
        match std::env::var_os("APPDATA") {
            Some(appdata) => PathBuf::from(appdata).join("nvm"),
            None => return Vec::new(),
        }
    } else {
        home.join(".nvm/versions/node")
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| {
            // Unix: `<version>/bin`. nvm-windows: binaries live in `<version>`.
            if cfg!(windows) {
                e.path()
            } else {
                e.path().join("bin")
            }
        })
        .filter(|p| p.is_dir())
        .collect()
}

// ── Claude Code ──────────────────────────────────────────────────────────────

pub struct ClaudeCliSpec;

impl CliSpec for ClaudeCliSpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCli
    }
    fn binary_name(&self) -> &'static str {
        "claude"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        let mut v = npm_global_candidates("claude");
        if let Some(h) = home() {
            // Claude's native installer location.
            v.extend(native_install_candidates(&h, ".claude/local", "claude"));
        }
        v
    }
    fn build_args(&self, prompt: &str, model: &str, mcp_config_path: Option<&str>) -> Vec<String> {
        let mut a = vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];
        if !model.is_empty() {
            a.push("--model".into());
            a.push(model.into());
        }
        if let Some(cfg) = mcp_config_path {
            a.push("--mcp-config".into());
            a.push(cfg.into());
            // Auto-approve our own MCP tools so the headless run isn't blocked.
            a.push("--allowedTools".into());
            a.push("mcp__tablerelay".into());
        }
        a
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => return LineEvent::Ignore,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Token deltas (with --include-partial-messages).
            Some("stream_event") => {
                let delta = v
                    .get("event")
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| {
                        if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            d.get("text").and_then(|t| t.as_str())
                        } else {
                            None
                        }
                    });
                match delta {
                    Some(t) => LineEvent::Delta(t.to_string()),
                    None => LineEvent::Ignore,
                }
            }
            Some("result") => {
                let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                if is_error {
                    let msg = v
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("Claude Code reported an error")
                        .to_string();
                    LineEvent::Failed(msg)
                } else {
                    // `.result` holds the full final text; the engine only emits
                    // it if no deltas streamed.
                    let final_text = v.get("result").and_then(|r| r.as_str()).map(String::from);
                    LineEvent::Done(final_text)
                }
            }
            _ => LineEvent::Ignore,
        }
    }
}

// ── Codex ────────────────────────────────────────────────────────────────────

pub struct CodexCliSpec;

impl CliSpec for CodexCliSpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::CodexCli
    }
    fn binary_name(&self) -> &'static str {
        "codex"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        let mut v = npm_global_candidates("codex");
        if let Some(h) = home() {
            v.extend(native_install_candidates(&h, ".codex/bin", "codex"));
        }
        v
    }
    fn build_args(&self, prompt: &str, model: &str, _mcp: Option<&str>) -> Vec<String> {
        // MCP for Codex is config.toml-based (registered out-of-band), so no flag.
        let mut a = vec!["exec".into(), "--json".into()];
        if !model.is_empty() {
            a.push("-m".into());
            a.push(model.into());
        }
        a.push(prompt.into());
        a
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => return LineEvent::Ignore,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("item.completed") => {
                let item = v.get("item");
                let item_type = item.and_then(|i| i.get("type")).and_then(|t| t.as_str());
                match item_type {
                    Some("agent_message") => {
                        let text = item
                            .and_then(|i| i.get("text"))
                            .and_then(|t| t.as_str())
                            .unwrap_or_default()
                            .to_string();
                        // Codex emits each assistant message whole (no token
                        // deltas). Stream it as one delta. We do NOT end the run
                        // here — with MCP tools Codex produces several turns and
                        // the final answer arrives in a LATER `agent_message`.
                        // Ending on the first `turn.completed` cut the stream off
                        // before the tool-informed answer. `codex exec` is
                        // one-shot, so EOF is the real end.
                        LineEvent::Delta(text)
                    }
                    // Codex reports some failures as a NESTED error item (not a
                    // top-level `type:"error"`). But it ALSO emits non-fatal
                    // warnings this way (e.g. the `web_search` deprecation notice
                    // before a perfectly good answer). Treating every nested error
                    // as fatal would kill successful runs. So we IGNORE nested
                    // errors during streaming and rely on the engine's
                    // exit-status + stderr surfacing for genuine failures (a real
                    // fatal error makes codex exit non-zero / produce no answer).
                    Some("error") => LineEvent::Ignore,
                    _ => LineEvent::Ignore,
                }
            }
            // `turn.completed` fires once PER turn — including the intermediate
            // turns that only requested a tool. Treat it as a no-op and let the
            // process's EOF (handled by the engine) finish the run, so multi-turn
            // tool use streams its final answer instead of being truncated.
            Some("turn.completed") => LineEvent::Ignore,
            // Some Codex builds emit a terminal `thread.completed` / `session.…`
            // wrapper when the whole exec finishes. Honour that as the end.
            Some("thread.completed") | Some("session.completed") => LineEvent::Done(None),
            Some("error") => {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Codex reported an error")
                    .to_string();
                LineEvent::Failed(msg)
            }
            _ => LineEvent::Ignore,
        }
    }
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────

pub struct GeminiCliSpec {
    /// Path to a generated system-prompt file, exposed via GEMINI_SYSTEM_MD.
    pub system_md: Option<String>,
}

impl CliSpec for GeminiCliSpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GeminiCli
    }
    fn binary_name(&self) -> &'static str {
        "gemini"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        npm_global_candidates("gemini")
    }
    fn extra_env(&self) -> Vec<(String, String)> {
        match &self.system_md {
            Some(p) => vec![
                ("GEMINI_SYSTEM_MD".into(), p.clone()),
                ("GEMINI_CLI_TRUST_WORKSPACE".into(), "true".into()),
            ],
            // Always set the trust env var, even without a system-prompt file —
            // it's the fallback for builds that don't accept `--skip-trust`.
            None => vec![("GEMINI_CLI_TRUST_WORKSPACE".into(), "true".into())],
        }
    }
    fn build_args(&self, prompt: &str, model: &str, _mcp: Option<&str>) -> Vec<String> {
        // Gemini reads MCP from ~/.gemini/settings.json (out-of-band). Single
        // JSON object output (no token stream) → one Done with the final text.
        let mut a = vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "json".into(),
            // Gemini CLI refuses to run headless in an "untrusted" workspace and
            // errors out. We invoke it programmatically (not interactively) and
            // never let it touch the workspace, so skip the trust gate. (The env
            // var GEMINI_CLI_TRUST_WORKSPACE=true is also set in extra_env as a
            // fallback for older builds that lack this flag.)
            "--skip-trust".into(),
        ];
        if !model.is_empty() {
            a.push("-m".into());
            a.push(model.into());
        }
        a
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        // `--output-format json` prints a single object (possibly across lines).
        // Try to parse the line as the full object; ignore until it parses.
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => return LineEvent::Ignore,
        };
        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Gemini CLI reported an error")
                .to_string();
            return LineEvent::Failed(msg);
        }
        if let Some(resp) = v.get("response").and_then(|r| r.as_str()) {
            return LineEvent::Done(Some(resp.to_string()));
        }
        LineEvent::Ignore
    }
}

// ── opencode ─────────────────────────────────────────────────────────────────

pub struct OpencodeSpec;

impl CliSpec for OpencodeSpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Opencode
    }
    fn binary_name(&self) -> &'static str {
        "opencode"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        let mut v = npm_global_candidates("opencode");
        if let Some(h) = home() {
            // opencode's own install script drops the binary here — it is NOT on
            // a Finder/Start-menu-launched app's PATH, so probe it explicitly.
            v.extend(native_install_candidates(&h, ".opencode/bin", "opencode"));
        }
        v
    }
    fn build_args(&self, prompt: &str, model: &str, _mcp: Option<&str>) -> Vec<String> {
        // opencode reads MCP from opencode.json (out-of-band). JSONL events;
        // `text` parts carry the assistant text, `step_finish` ends the run.
        let mut a = vec!["run".into(), "--format".into(), "json".into()];
        if !model.is_empty() {
            a.push("-m".into());
            a.push(model.into());
        }
        a.push(prompt.into());
        a
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        let v: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => return LineEvent::Ignore,
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = v
                    .get("part")
                    .and_then(|p| p.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or_default();
                if text.is_empty() {
                    LineEvent::Ignore
                } else {
                    LineEvent::Delta(text.to_string())
                }
            }
            // `step_finish` ends a single step — but a tool-using run has many
            // steps, and the final answer comes after the tool steps. Ending on
            // the first one truncated the reply to an empty bubble. `opencode
            // run` is one-shot, so let EOF finish the stream instead.
            Some("step_finish") => LineEvent::Ignore,
            Some("session_idle") | Some("session.idle") => LineEvent::Done(None),
            Some("error") => {
                let msg = v
                    .get("error")
                    .and_then(|e| e.get("data"))
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("opencode reported an error")
                    .to_string();
                LineEvent::Failed(msg)
            }
            _ => LineEvent::Ignore,
        }
    }
}

// ── kilo ───────────────────────────────────────────────────────────────────
// Kilo is an opencode-compatible agent CLI: `kilo run --format json [-m M] <p>`
// emits the same JSONL event shapes (text parts, step_finish, session.idle,
// error). MCP is read from kilo's config (out-of-band), like opencode.

pub struct KiloSpec;

impl CliSpec for KiloSpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Kilo
    }
    fn binary_name(&self) -> &'static str {
        "kilo"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        let mut v = npm_global_candidates("kilo");
        if let Some(h) = home() {
            // kilo's installer drops the binary here (not on a Finder/Start-menu
            // app's PATH), so probe it explicitly.
            v.extend(native_install_candidates(&h, ".kilo/bin", "kilo"));
        }
        v
    }
    fn build_args(&self, prompt: &str, model: &str, _mcp: Option<&str>) -> Vec<String> {
        let mut a = vec!["run".into(), "--format".into(), "json".into()];
        if !model.is_empty() {
            a.push("-m".into());
            a.push(model.into());
        }
        a.push(prompt.into());
        a
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        // Identical event shapes to opencode (kilo is a fork).
        OpencodeSpec.parse_line(line)
    }
}

// ── antigravity (agy) ────────────────────────────────────────────────────────
// Google Antigravity's headless agent CLI: `agy -p <prompt> [--model M]` runs a
// single prompt non-interactively and prints the response as PLAIN TEXT (no JSON
// stream). We stream stdout lines straight through as deltas. MCP/tools are not
// wired (agy exposes tools via its own plugin system, not an MCP-config flag).

pub struct AgySpec;

impl CliSpec for AgySpec {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Antigravity
    }
    fn binary_name(&self) -> &'static str {
        "agy"
    }
    fn extra_paths(&self) -> Vec<PathBuf> {
        let mut v = npm_global_candidates("agy");
        if let Some(h) = home() {
            // `agy install` drops the binary in ~/.local/bin.
            v.extend(native_install_candidates(&h, ".local/bin", "agy"));
        }
        v
    }
    fn build_args(&self, prompt: &str, model: &str, _mcp: Option<&str>) -> Vec<String> {
        // `-p`/`--print` takes the prompt as its value and prints the response.
        let mut a: Vec<String> = Vec::new();
        if !model.is_empty() {
            a.push("--model".into());
            a.push(model.into());
        }
        a.push("-p".into());
        a.push(prompt.into());
        a
    }
    fn tolerate_nonzero_exit(&self) -> bool {
        // `agy` exits non-zero even on a successful run (observed on `agy models`
        // and chat). Once we've streamed output, don't surface that as an error.
        true
    }
    fn parse_line(&self, line: &str) -> LineEvent {
        // Plain-text output: every stdout line is part of the answer. Keep the
        // newline so multi-line responses survive (the engine reads lines with
        // the terminator stripped). EOF ends the stream.
        LineEvent::Delta(format!("{line}\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_delta(e: &LineEvent, expect: &str) -> bool {
        matches!(e, LineEvent::Delta(t) if t == expect)
    }
    fn is_ignore(e: &LineEvent) -> bool {
        matches!(e, LineEvent::Ignore)
    }
    fn is_done(e: &LineEvent) -> bool {
        matches!(e, LineEvent::Done(_))
    }

    #[test]
    fn codex_does_not_finish_on_intermediate_turn_completed() {
        let s = CodexCliSpec;
        // A tool-using run: agent_message (asking for tool) → turn.completed
        // (intermediate) → agent_message (final answer). The intermediate
        // turn.completed must NOT end the stream, or the final answer is lost.
        assert!(is_delta(
            &s.parse_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"let me check"}}"#),
            "let me check"
        ));
        assert!(is_ignore(&s.parse_line(r#"{"type":"turn.completed"}"#)));
        assert!(is_delta(
            &s.parse_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"there are 10"}}"#),
            "there are 10"
        ));
    }

    #[test]
    fn codex_finishes_on_thread_completed() {
        let s = CodexCliSpec;
        assert!(is_done(&s.parse_line(r#"{"type":"thread.completed"}"#)));
    }

    #[test]
    fn codex_nested_error_warning_does_not_kill_run() {
        // Real output: codex emits a non-fatal deprecation warning as a nested
        // error item, THEN a successful agent_message. The warning must be
        // ignored (not Failed) so the good answer still streams.
        let s = CodexCliSpec;
        assert!(is_ignore(&s.parse_line(
            r#"{"type":"item.completed","item":{"type":"error","message":"`[features].web_search` is deprecated"}}"#
        )));
        assert!(is_delta(
            &s.parse_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hi there friend"}}"#),
            "Hi there friend"
        ));
    }

    #[test]
    fn opencode_does_not_finish_on_intermediate_step_finish() {
        let s = OpencodeSpec;
        assert!(is_delta(
            &s.parse_line(r#"{"type":"text","part":{"text":"working"}}"#),
            "working"
        ));
        assert!(is_ignore(&s.parse_line(r#"{"type":"step_finish"}"#)));
        assert!(is_delta(
            &s.parse_line(r#"{"type":"text","part":{"text":"done answer"}}"#),
            "done answer"
        ));
    }
}
