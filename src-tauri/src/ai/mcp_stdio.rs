//! The `table-relay __mcp-server` subprocess entrypoint: a thin stdio↔TCP MCP
//! relay.
//!
//! The wrapped CLIs (Claude Code, Codex, Gemini, opencode) launch an MCP server
//! as a child process and speak JSON-RPC to it over that child's stdio. Our DB
//! tools live in the running GUI app, not here, so this subprocess does no DB
//! work at all — it connects to the app's loopback MCP bridge
//! ([`crate::ai::mcp_bridge`]) on `--port`, authenticates with `--token`, then
//! pumps newline-delimited JSON-RPC frames in both directions:
//!
//! ```text
//!   CLI ──stdin──▶ [this relay] ──TCP──▶ app bridge ──▶ dispatch()
//!   CLI ◀─stdout── [this relay] ◀─TCP── app bridge ◀── tool result
//! ```
//!
//! It is invoked by `main.rs` *before* Tauri starts, so it never spins up the
//! webview/GUI. On any connection failure it exits non-zero; the CLI surfaces
//! that as "MCP server unavailable", which is the right signal (the app isn't
//! running, or the user started the CLI session before the bridge bound).

use std::process::ExitCode;

/// Parse `--port`/`--token` out of the argv tail and run the relay to
/// completion. Returns a process exit code. Blocks on its own tokio runtime so
/// it doesn't depend on Tauri's.
pub fn run(args: &[String]) -> ExitCode {
    let mut port: Option<u16> = None;
    let mut token: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => port = it.next().and_then(|v| v.parse().ok()),
            "--token" => token = it.next().cloned(),
            _ => {}
        }
    }
    let (Some(port), Some(token)) = (port, token) else {
        eprintln!("__mcp-server: missing --port/--token");
        return ExitCode::from(2);
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("__mcp-server: runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    match rt.block_on(relay(port, &token)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("__mcp-server: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn relay(port: u16, token: &str) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;

    let mut sock = TcpStream::connect(("127.0.0.1", port)).await?;
    // Auth frame first — the bridge drops the connection on a bad/absent token.
    let auth = format!("{{\"token\":\"{token}\"}}\n");
    sock.write_all(auth.as_bytes()).await?;
    sock.flush().await?;

    let (sock_read, mut sock_write) = sock.into_split();

    // stdin (from the CLI) → TCP (to the app).
    let to_app = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = stdin.next_line().await {
            if sock_write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if sock_write.write_all(b"\n").await.is_err() {
                break;
            }
            if sock_write.flush().await.is_err() {
                break;
            }
        }
    });

    // TCP (from the app) → stdout (to the CLI).
    let from_app = tokio::spawn(async move {
        let mut lines = BufReader::new(sock_read).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    // The relay lives as long as either direction is open. When the CLI closes
    // stdin or the app closes the socket, both tasks wind down.
    let _ = tokio::try_join!(to_app, from_app);
    Ok(())
}

/// Whether this process was launched as the MCP-server subcommand. `main.rs`
/// checks this before starting Tauri.
pub fn is_mcp_subcommand(args: &[String]) -> bool {
    args.iter().any(|a| a == "__mcp-server")
}
