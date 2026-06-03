// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // touch v5: force tauri-dev relaunch so the webview reloads the fresh frontend
    table_relay_lib::run()
}
