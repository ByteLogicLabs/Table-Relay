// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    // When the wrapped coding CLIs spawn us as their MCP server
    // (`table-relay __mcp-server --port P --token T`), become a thin stdio↔TCP
    // relay into the running app's MCP bridge instead of launching the GUI.
    // This MUST run before Tauri so no webview/window is created.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if table_relay_lib::is_mcp_subcommand(&args) {
        return table_relay_lib::run_mcp_server(&args);
    }
    // touch v5: force tauri-dev relaunch so the webview reloads the fresh frontend
    table_relay_lib::run();
    ExitCode::SUCCESS
}
