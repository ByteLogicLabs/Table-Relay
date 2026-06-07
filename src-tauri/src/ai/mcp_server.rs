//! Stdio MCP server exposing Table Relay's DB tools to the wrapped CLIs.
//!
//! The CLIs (Claude Code, Codex, Gemini, opencode) run their own agent loop and
//! call host tools over the Model Context Protocol. We expose `run_query` &
//! friends by launching a tiny MCP server **as a subcommand of our own binary**
//! (`table-relay __mcp-server`) and registering it with each CLI (via that
//! CLI's MCP config mechanism). The CLI spawns this subcommand; it speaks
//! JSON-RPC 2.0 over stdio and bridges tool calls back into our DB dispatch.
//!
//! NOTE (phased): this module currently provides the registration-config
//! plumbing + the server entrypoint scaffold. The bridge into `dispatch.rs`
//! requires a running app/session context that a standalone subprocess does not
//! have on its own (it must call back into the app over local IPC). That
//! callback transport is Phase 2; until it's wired, none of this is referenced
//! yet — hence the module-wide dead-code allow.
use serde_json::{json, Value};

/// Server identity advertised in MCP `initialize` and used as the tool prefix
/// (`mcp__tablerelay__<tool>`).
pub const MCP_SERVER_NAME: &str = "tablerelay";

/// The DB tools we advertise to CLIs over MCP. Names + schemas mirror the
/// in-app tool dispatch ([`crate::ai::tools::dispatch`]) so the bridge forwards
/// 1:1 — and so the same approval popup + cross-database guards apply. This is
/// "full parity": reads, the gated `call_query`, plus the tab/realtime actions.
/// Every mutating call still routes through the in-app approval UI.
pub fn advertised_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "list_schemas",
            "description": "List every schema/database the current connection can see. Disabled when cross-database access is off.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "list_tables",
            "description": "List tables and views in a schema (defaults to the active schema).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "schema": { "type": "string", "description": "Schema name; defaults to the active schema." }
                }
            }
        }),
        json!({
            "name": "describe_table",
            "description": "Describe a table: columns, primary key, foreign keys, indexes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "table": { "type": "string", "description": "Table name." },
                    "schema": { "type": "string", "description": "Schema name; defaults to the active schema." }
                },
                "required": ["table"]
            }
        }),
        json!({
            "name": "call_query",
            "description": "Execute SQL against the active connection. The user is shown an approval popup before any non-auto-approved statement runs. Returns up to 25 rows as JSON.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "The SQL to execute." }
                },
                "required": ["sql"]
            }
        }),
        json!({
            "name": "write_query_tab",
            "description": "Open the user's query editor with SQL pre-filled for them to review/run. Does not execute.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string" },
                    "mode": { "type": "string", "enum": ["new", "replace"], "description": "Open a new tab or replace the active one." },
                    "title": { "type": "string" }
                },
                "required": ["sql"]
            }
        }),
        json!({
            "name": "open_object_tab",
            "description": "Open the table or trigger editor for the user, optionally pre-filled.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "object": { "type": "string", "enum": ["table", "trigger"] },
                    "name": { "type": "string" },
                    "schema": { "type": "string" },
                    "sql": { "type": "string" }
                },
                "required": ["object"]
            }
        }),
        json!({
            "name": "publish_notify",
            "description": "Publish a message to a realtime channel (NOTIFY / PUBLISH). Gated by an approval popup.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string" },
                    "payload": { "type": "string" }
                },
                "required": ["channel"]
            }
        }),
        json!({
            "name": "subscribe_channel",
            "description": "Start a realtime subscription on the user's realtime tab. Gated by an approval popup.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string" }
                },
                "required": ["channel"]
            }
        }),
    ]
}

/// Write the Claude `--mcp-config` JSON to a temp file and return its path.
/// Non-invasive: Claude reads this per-invocation via the flag, so we never
/// touch the user's global Claude config. The file carries the loopback port +
/// token; it's recreated each session (the port changes per app launch).
pub fn write_claude_mcp_config(exe: &str, port: u16, token: &str) -> std::io::Result<String> {
    let cfg = claude_mcp_config(exe, port, token);
    let path = std::env::temp_dir().join(format!("tablerelay-mcp-{port}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&cfg)?)?;
    Ok(path.display().to_string())
}

/// Merge our MCP server into a CLI's JSON config file (used for Gemini's
/// `settings.json` and opencode's `opencode.json`). Reads the existing file (if
/// any), inserts/overwrites our entry under `top_key`, and writes it back. Other
/// user settings are preserved. Best-effort: returns an error the caller can log
/// without failing the session.
fn merge_json_config(
    path: &std::path::Path,
    top_key: &str,
    name: &str,
    entry: Value,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut root: Value = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    };
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let bucket = obj
        .entry(top_key.to_string())
        .or_insert_with(|| json!({}));
    if !bucket.is_object() {
        *bucket = json!({});
    }
    bucket
        .as_object_mut()
        .unwrap()
        .insert(name.to_string(), entry);
    std::fs::write(path, serde_json::to_vec_pretty(&root)?)?;
    Ok(())
}

/// Register the MCP server into Gemini's `~/.gemini/settings.json` (idempotent).
pub fn register_gemini(home: &std::path::Path, exe: &str, port: u16, token: &str) -> std::io::Result<()> {
    let path = home.join(".gemini/settings.json");
    let entry = gemini_mcp_fragment(exe, port, token)
        .get(MCP_SERVER_NAME)
        .cloned()
        .unwrap_or(json!({}));
    merge_json_config(&path, "mcpServers", MCP_SERVER_NAME, entry)
}

/// Register the MCP server into opencode's config JSON. opencode follows XDG:
/// `$XDG_CONFIG_HOME/opencode/opencode.json`, falling back to
/// `~/.config/opencode/...` on Unix and `%APPDATA%\opencode\...` on Windows.
pub fn register_opencode(home: &std::path::Path, exe: &str, port: u16, token: &str) -> std::io::Result<()> {
    let base = config_home(home);
    let path = base.join("opencode").join("opencode.json");
    let entry = opencode_mcp_fragment(exe, port, token)
        .get(MCP_SERVER_NAME)
        .cloned()
        .unwrap_or(json!({}));
    merge_json_config(&path, "mcp", MCP_SERVER_NAME, entry)
}

/// The XDG-style config base dir: `$XDG_CONFIG_HOME` if set, else `~/.config`
/// on Unix and `%APPDATA%` on Windows.
fn config_home(home: &std::path::Path) -> std::path::PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        return std::path::PathBuf::from(xdg);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return std::path::PathBuf::from(appdata);
        }
    }
    home.join(".config")
}

/// Register the MCP server into Codex's `~/.codex/config.toml`. Codex uses TOML;
/// we append our `[mcp_servers.tablerelay]` block if it isn't already present.
/// Idempotent on the block header so repeated sessions don't duplicate it.
pub fn register_codex(home: &std::path::Path, exe: &str, port: u16, token: &str) -> std::io::Result<()> {
    let path = home.join(".codex/config.toml");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let header = format!("[mcp_servers.{MCP_SERVER_NAME}]");
    let block = codex_mcp_toml(exe, port, token);
    let next = if let Some(start) = existing.find(&header) {
        // Replace the existing block (up to the next table header or EOF) so a
        // stale port/token from a previous launch is overwritten.
        let after = &existing[start + header.len()..];
        let end = after
            .find("\n[")
            .map(|i| start + header.len() + i + 1)
            .unwrap_or(existing.len());
        format!("{}{}{}", &existing[..start], block, &existing[end..])
    } else {
        let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        format!("{existing}{sep}{block}")
    };
    std::fs::write(&path, next)
}

/// Build the inline MCP-config JSON Claude Code accepts via `--mcp-config`.
/// Spawns our own binary in MCP-server mode. `exe` is the current executable
/// path; `port`/`token` let the subprocess connect back to the running app.
pub fn claude_mcp_config(exe: &str, port: u16, token: &str) -> Value {
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": exe,
                "args": ["__mcp-server", "--port", port.to_string(), "--token", token],
            }
        }
    })
}

/// opencode.json `mcp` fragment (type:"local").
pub fn opencode_mcp_fragment(exe: &str, port: u16, token: &str) -> Value {
    json!({
        MCP_SERVER_NAME: {
            "type": "local",
            "command": [exe, "__mcp-server", "--port", port.to_string(), "--token", token],
            "enabled": true
        }
    })
}

/// Gemini settings.json `mcpServers` fragment.
pub fn gemini_mcp_fragment(exe: &str, port: u16, token: &str) -> Value {
    json!({
        MCP_SERVER_NAME: {
            "command": exe,
            "args": ["__mcp-server", "--port", port.to_string(), "--token", token]
        }
    })
}

/// Codex config.toml `[mcp_servers.tablerelay]` block as a string.
pub fn codex_mcp_toml(exe: &str, port: u16, token: &str) -> String {
    format!(
        "[mcp_servers.{name}]\ncommand = {exe:?}\nargs = [\"__mcp-server\", \"--port\", \"{port}\", \"--token\", \"{token}\"]\n",
        name = MCP_SERVER_NAME,
        exe = exe,
        port = port,
        token = token,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_tools_cover_dispatch_surface() {
        let names: Vec<String> = advertised_tools()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        for expected in [
            "list_schemas",
            "list_tables",
            "describe_table",
            "call_query",
            "write_query_tab",
            "open_object_tab",
            "publish_notify",
            "subscribe_channel",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn merge_json_config_preserves_other_keys() {
        let dir = std::env::temp_dir().join(format!("tr-mcp-test-{}", random_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, br#"{"theme":"dark","mcpServers":{"other":{"x":1}}}"#).unwrap();

        merge_json_config(&path, "mcpServers", "tablerelay", json!({"command":"exe"})).unwrap();

        let root: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(root["theme"], "dark"); // untouched
        assert_eq!(root["mcpServers"]["other"]["x"], 1); // sibling server kept
        assert_eq!(root["mcpServers"]["tablerelay"]["command"], "exe");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_register_replaces_existing_block_not_duplicates() {
        let home = std::env::temp_dir().join(format!("tr-codex-test-{}", random_suffix()));
        let cfg = home.join(".codex/config.toml");
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        std::fs::write(&cfg, "[other]\nfoo = 1\n").unwrap();

        register_codex(&home, "exe", 1111, "tok1").unwrap();
        register_codex(&home, "exe", 2222, "tok2").unwrap();

        let body = std::fs::read_to_string(&cfg).unwrap();
        // Exactly one tablerelay block, carrying the latest port, and the
        // unrelated [other] table preserved.
        assert_eq!(body.matches("[mcp_servers.tablerelay]").count(), 1);
        assert!(body.contains("2222"));
        assert!(!body.contains("1111"));
        assert!(body.contains("[other]"));
        std::fs::remove_dir_all(&home).ok();
    }

    // Date/random helpers are unavailable in some sandboxes; derive a unique-ish
    // suffix from the current thread id + a process-unique counter instead.
    fn random_suffix() -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }
}
