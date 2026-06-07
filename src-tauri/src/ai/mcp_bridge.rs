//! App-side MCP bridge: a loopback TCP server that exposes Table Relay's DB
//! tools to the wrapped coding CLIs over the Model Context Protocol.
//!
//! ## Why a TCP loopback (not direct calls)
//!
//! The CLIs (Claude Code, Codex, Gemini, opencode) run their *own* agent loop
//! and call host tools by spawning an MCP **server subprocess** and talking
//! JSON-RPC to it over that subprocess's stdio. Our DB tools, however, live in
//! the running Tauri app — [`crate::ai::tools::dispatch`] needs the live
//! [`Registry`], [`ApprovalRegistry`], [`AutoApprovals`] and the [`AppHandle`]
//! (for the approval popup). A standalone subprocess has none of those.
//!
//! So we split it: this module runs a tiny **TCP server inside the app** bound
//! to `127.0.0.1:<port>` and guarded by a random per-app token. The MCP
//! subprocess (`table-relay __mcp-server --port P --token T`, see
//! [`crate::ai::mcp_stdio`]) is a thin relay — it pipes JSON-RPC lines between
//! the CLI's stdio and this TCP socket. Tool calls therefore land back in the
//! same `dispatch()` the in-app AI uses, which means MCP tool calls get the
//! **same approval UI and cross-database guards** for free.
//!
//! ## Wire protocol
//!
//! Newline-delimited JSON-RPC 2.0. The first line a client sends MUST be an
//! auth frame: `{"token":"<token>"}`. After that, standard MCP methods:
//! `initialize`, `tools/list`, `tools/call`. We implement just enough of the
//! spec for the four CLIs to discover + invoke our tools.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

use crate::ai::tools::{self, ToolContext};
use crate::db::registry::Registry;

use super::mcp_server::{advertised_tools, MCP_SERVER_NAME};

/// Mutable per-turn routing context. The CLI provider has no idea which DB
/// connection the user is looking at — that arrives per `ai_chat_send`. We
/// stash the latest focus here so a tool call coming in over MCP dispatches
/// against the connection the user currently has in front of them.
#[derive(Default, Clone)]
struct BridgeContext {
    connection_id: Option<String>,
    schema: Option<String>,
    /// The request id of the chat turn currently in flight. MCP tool calls ride
    /// on it so the frontend attaches the tool bubble + approval popup to the
    /// running assistant message (same UX as in-app tool calls).
    request_id: Option<String>,
}

/// App-lifetime MCP bridge. Created once (lazily, on the first CLI session) and
/// kept on `AppState`. Holds the managed-state handles `dispatch()` needs plus
/// the loopback listener's `port`/`token` so CLI registration can point at it.
pub struct McpBridge {
    pub port: u16,
    pub token: String,
    db_registry: Arc<Registry>,
    approvals: Arc<tools::ApprovalRegistry>,
    auto_approvals: Arc<tools::AutoApprovals>,
    app: tauri::AppHandle,
    ctx: Arc<RwLock<BridgeContext>>,
}

/// App-managed slot holding the lazily-bound bridge. `None` until the first CLI
/// session creates it; reused for every CLI session after that (the port/token
/// are stable for the app's lifetime).
pub type McpBridgeSlot = Arc<RwLock<Option<Arc<McpBridge>>>>;

impl McpBridge {
    /// Bind the loopback listener and spawn the accept loop. Returns the bridge
    /// (carrying `port`/`token`) so the caller can register it with the CLIs.
    pub async fn start(
        db_registry: Arc<Registry>,
        approvals: Arc<tools::ApprovalRegistry>,
        auto_approvals: Arc<tools::AutoApprovals>,
        app: tauri::AppHandle,
    ) -> std::io::Result<Arc<Self>> {
        // Bind to an OS-assigned port on loopback only — never reachable off the
        // machine. `127.0.0.1:0` lets the kernel pick a free port.
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let token = random_token();

        let bridge = Arc::new(Self {
            port,
            token,
            db_registry,
            approvals,
            auto_approvals,
            app,
            ctx: Arc::new(RwLock::new(BridgeContext::default())),
        });

        let accept_bridge = bridge.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let b = accept_bridge.clone();
                        tokio::spawn(async move {
                            if let Err(e) = b.handle_client(stream).await {
                                crate::log_line!("mcp", "client closed: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        crate::log_line!("mcp", "accept failed: {e}");
                        break;
                    }
                }
            }
        });

        crate::log_line!("mcp", "bridge listening on 127.0.0.1:{port}");
        Ok(bridge)
    }

    /// Update the routing context for tool calls. Called from `ai_chat_send`
    /// every turn so MCP tool calls hit the connection the user is focused on
    /// and ride on the in-flight chat turn's request id.
    pub async fn set_context(
        &self,
        connection_id: Option<String>,
        schema: Option<String>,
        request_id: Option<String>,
    ) {
        let mut c = self.ctx.write().await;
        c.connection_id = connection_id;
        c.schema = schema;
        c.request_id = request_id;
    }

    /// Serve one client connection: auth handshake, then JSON-RPC request loop.
    async fn handle_client(&self, stream: TcpStream) -> std::io::Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut lines = BufReader::new(read_half).lines();

        // First line must authenticate. A wrong/absent token closes the socket
        // immediately — defense in depth even though we're loopback-only.
        let auth_line = match lines.next_line().await? {
            Some(l) => l,
            None => return Ok(()),
        };
        let authed = serde_json::from_str::<Value>(&auth_line)
            .ok()
            .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(str::to_string))
            .map(|t| t == self.token)
            .unwrap_or(false);
        if !authed {
            crate::log_line!("mcp", "rejected client: bad/missing token");
            let _ = write_half
                .write_all(b"{\"error\":\"unauthorized\"}\n")
                .await;
            return Ok(());
        }

        while let Some(line) = lines.next_line().await? {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let req: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // ignore malformed frames
            };
            // Notifications (no `id`) get no response per JSON-RPC.
            let id = req.get("id").cloned();
            let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

            let response = self.handle_method(method, &req, id.clone()).await;
            if let (Some(resp), Some(_)) = (response, id) {
                let mut buf = serde_json::to_vec(&resp).unwrap_or_default();
                buf.push(b'\n');
                write_half.write_all(&buf).await?;
                write_half.flush().await?;
            }
        }
        Ok(())
    }

    /// Route one JSON-RPC method. Returns `Some(response)` for requests that
    /// carry an `id`; `None` for notifications.
    async fn handle_method(&self, method: &str, req: &Value, id: Option<Value>) -> Option<Value> {
        match method {
            "initialize" => Some(rpc_ok(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
                }),
            )),
            // Acknowledge the post-init notification; no response expected.
            "notifications/initialized" => None,
            "tools/list" => Some(rpc_ok(id, json!({ "tools": advertised_tools() }))),
            "tools/call" => Some(self.handle_tool_call(req, id).await),
            "ping" => Some(rpc_ok(id, json!({}))),
            other => Some(rpc_err(
                id,
                -32601,
                format!("method not found: {other}"),
            )),
        }
    }

    /// Execute `tools/call` by forwarding into the shared `dispatch()`. The
    /// result is wrapped in MCP's `{content:[{type:"text",text}]}` envelope.
    async fn handle_tool_call(&self, req: &Value, id: Option<Value>) -> Value {
        let params = req.get("params").cloned().unwrap_or(json!({}));
        let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        // MCP passes tool args under `arguments` as an object; dispatch() wants
        // them as a JSON *string*.
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or(json!({}))
            .to_string();

        let (connection_id, schema, request_id) = {
            let c = self.ctx.read().await;
            (
                c.connection_id.clone(),
                c.schema.clone(),
                c.request_id.clone(),
            )
        };
        let Some(connection_id) = connection_id else {
            return tool_text_result(
                id,
                true,
                "No active database connection. Open a connection in Table Relay first.",
            );
        };

        let ctx = ToolContext {
            connection_id: connection_id.clone(),
            default_schema: schema,
        };
        // Synthesize a tool_call_id. The frontend keys the tool bubble +
        // approval popup off this id, so dispatch()'s approval_request (which
        // reuses the same id) lands on the bubble we announce below.
        let call_id = format!("mcp-{}", random_token());

        use tauri::Emitter;
        // Announce the tool call so the UI renders a tool bubble attached to the
        // in-flight assistant turn — exactly like an in-app tool call. Without a
        // bubble, dispatch()'s approval popup has nothing to attach to and the
        // call would silently block until the 5-minute approval timeout.
        if let Some(rid) = &request_id {
            let _ = self.app.emit(
                "ai://tool/call_started",
                json!({
                    "request_id": rid,
                    "tool_call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                    "source": "mcp",
                }),
            );
        }

        let result = tools::dispatch(
            &self.db_registry,
            &self.approvals,
            &self.auto_approvals,
            &self.app,
            &ctx,
            &call_id,
            name,
            &arguments,
        )
        .await;

        if let Some(rid) = &request_id {
            let _ = self.app.emit(
                "ai://tool/call_finished",
                json!({
                    "request_id": rid,
                    "tool_call_id": call_id,
                    "result": result.content,
                }),
            );
        }

        // Use dispatch()'s explicit error flag — NOT a substring scan of the
        // content, which false-positived on legitimate result rows containing
        // the word "error" (a status column, a log table) and made good queries
        // look like failed tool calls to the CLI.
        tool_text_result(id, result.is_error, &result.content)
    }
}

/// Build the MCP `content` envelope around `dispatch()`'s string result.
fn tool_text_result(id: Option<Value>, is_error: bool, text: &str) -> Value {
    rpc_ok(
        id,
        json!({
            "content": [ { "type": "text", "text": text } ],
            "isError": is_error
        }),
    )
}

fn rpc_ok(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn rpc_err(id: Option<Value>, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "error": { "code": code, "message": message } })
}

/// 32 hex chars of randomness for the per-app bridge token + per-call ids. Uses
/// the `rand` crate already in the dependency tree.
fn random_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_ok_shapes_jsonrpc_envelope() {
        let v = rpc_ok(Some(json!(7)), json!({"x":1}));
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["x"], 1);
    }

    #[test]
    fn rpc_err_carries_code_and_message() {
        let v = rpc_err(Some(json!("a")), -32601, "nope".into());
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["error"]["message"], "nope");
    }

    #[test]
    fn tool_result_wraps_in_content_envelope() {
        let v = tool_text_result(Some(json!(1)), false, "hello");
        assert_eq!(v["result"]["content"][0]["type"], "text");
        assert_eq!(v["result"]["content"][0]["text"], "hello");
        assert_eq!(v["result"]["isError"], false);
    }

    #[test]
    fn token_is_32_hex_chars() {
        let t = random_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
