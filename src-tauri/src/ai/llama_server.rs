//! Local GGUF runtime via `llama-server` subprocess.
//!
//! Rationale: the `llama-cpp-2` crate's README is explicit about UB risk and
//! needing hundreds of lines of careful code to sample tokens safely. The
//! upstream `llama.cpp` project ships a first-class `llama-server` binary
//! that exposes the OpenAI `/v1/chat/completions` shape — so we spawn it,
//! wait for `/health` to go green, and point our existing `OpenAiProvider`
//! at `http://127.0.0.1:<port>/v1`. Zero unsafe Rust, zero duplicated
//! sampler logic.
//!
//! Lifetime: one server per active chat session. `end()` sends SIGTERM so
//! the Metal context is torn down and RSS drops back. If the app crashes,
//! the spawned `llama-server` becomes an orphan and the OS reaps it on
//! next login — not elegant, but safe.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::AiError;

/// Returns the `llama-server` binary path. Order of resolution:
///   1. `DBTABLE_LLAMA_SERVER` env var — explicit override for dev.
///   2. `which llama-server` on `PATH` (Homebrew / apt / winget installs).
///   3. A small set of common install locations on macOS / Linux / Windows.
pub fn find_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DBTABLE_LLAMA_SERVER") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(path) = which::which("llama-server") {
        return Some(path);
    }
    for candidate in [
        "/opt/homebrew/bin/llama-server", // Apple Silicon Homebrew
        "/usr/local/bin/llama-server",    // Intel Homebrew + Linux
        "/usr/bin/llama-server",          // system package
    ] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// One live server. Dropping this struct calls `unload()` implicitly via
/// `kill_on_drop(true)` in the Command builder.
pub struct LlamaServer {
    child: Arc<Mutex<Option<Child>>>,
    pub base_url: String,
}

impl LlamaServer {
    /// Spawn `llama-server`, wait for `/health` to respond OK, return the
    /// base URL the frontend / OpenAiProvider can hit.
    pub async fn spawn(model_path: &Path) -> Result<Self, AiError> {
        let binary = find_binary().ok_or_else(|| {
            // Shouldn't normally reach here — the UI checks availability via
            // `ai_check_llama_server` before Start — but keep a clear message
            // in case someone calls the command directly (tests, devtools).
            AiError::Other(
                "llama-server not found on this machine. Install it first \
                 (macOS: `brew install llama.cpp`)."
                    .into(),
            )
        })?;
        if !model_path.is_file() {
            return Err(AiError::InvalidModel(format!(
                "model file not found: {}",
                model_path.display()
            )));
        }

        let port = pick_free_port().await?;
        let host = "127.0.0.1";

        let mut cmd = Command::new(&binary);
        cmd.arg("--model").arg(model_path)
            .arg("--host").arg(host)
            .arg("--port").arg(port.to_string())
            // 8k context: schema context (~3k tokens on real DBs) + tool
            // results (describe_table on a wide table is 500-1500 tokens)
            // + a couple of chat turns exceeded 4k in practice. Qwen 2.5
            // supports up to 32k so 8k leaves plenty of headroom without
            // the KV cache bloat of going wider.
            .arg("--ctx-size").arg("8192")
            // Let it fall back gracefully if Metal isn't available.
            .arg("--n-gpu-layers").arg("999")
            // --jinja enables the model's own chat template (Qwen / Llama 3.1 /
            // Mistral etc. all ship Jinja templates that include proper
            // tool-call formatting). Without this flag llama-server falls back
            // to a generic template that strips tool-call tokens, so the
            // model ends up printing `{"name": "..."}` as plain text instead
            // of going through the structured `tool_calls` channel.
            .arg("--jinja")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        crate::log_line!(
            "ai_llama",
            "spawning {} --model {} --port {}",
            binary.display(),
            model_path.display(),
            port,
        );

        let mut child = cmd.spawn().map_err(|e| {
            AiError::Other(format!("failed to spawn llama-server: {e}"))
        })?;

        // Drain stdout / stderr into our log file so the user can tail it
        // if a start fails — otherwise the process's diagnostics vanish
        // into a dropped pipe.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(drain_log("stdout", stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_log("stderr", stderr));
        }

        let base_url = format!("http://{host}:{port}/v1");
        let health_url = format!("http://{host}:{port}/health");

        // Poll /health for up to 90s. The first start on a cold model can
        // take a while — mmap + Metal KV cache allocation.
        let deadline = Instant::now() + Duration::from_secs(90);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| AiError::Other(format!("health client: {e}")))?;

        loop {
            if Instant::now() >= deadline {
                let _ = child.start_kill();
                return Err(AiError::Other(format!(
                    "llama-server at {health_url} did not respond within 90s"
                )));
            }
            // If the process has already exited, bail loudly — polling a
            // dead server forever would leave the user staring at a spinner.
            if let Ok(Some(status)) = child.try_wait() {
                return Err(AiError::Other(format!(
                    "llama-server exited during startup (status: {status}). Check the log for details."
                )));
            }
            match client.get(&health_url).send().await {
                Ok(res) if res.status().is_success() => break,
                _ => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }

        crate::log_line!("ai_llama", "  server ready at {base_url}");

        Ok(Self {
            child: Arc::new(Mutex::new(Some(child))),
            base_url,
        })
    }

    /// Signal the child to terminate and await its exit. Called from the
    /// provider's `unload()` on End Chat.
    pub async fn shutdown(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            // Best-effort wait so the Metal context actually tears down
            // before we return — caller wants RSS to drop by the time
            // End Chat resolves.
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
    }
}

async fn drain_log<R>(tag: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        crate::log_line!("ai_llama", "  [{tag}] {line}");
    }
}

/// Bind to `127.0.0.1:0`, read back the assigned port, drop the listener.
/// Classic "pick a free port" trick — technically racy (another process
/// could grab the port between our close and llama-server's bind) but in
/// practice it's reliable enough for this use case.
async fn pick_free_port() -> Result<u16, AiError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AiError::Other(format!("pick_free_port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AiError::Other(format!("local_addr: {e}")))?
        .port();
    Ok(port)
}
