//! Tauri commands backing the Settings → Logs panel: toggle file logging, read
//! the current log contents for the in-app viewer, clear them, and reveal the
//! logs folder. Logging state is persisted in app-state so it survives restarts.

use std::sync::Arc;

use tauri::State;

use crate::store::repo_app_state;
use crate::store::{Store, StoreError};

type SResult<T> = Result<T, StoreError>;

/// app-state key that persists whether file logging is enabled.
pub const LOGGING_ENABLED_KEY: &str = "logging_enabled";

/// Apply the persisted logging preference at startup. Defaults to the build
/// default (off in release, on in debug) when no preference is stored yet.
pub fn apply_persisted_logging(store: &Store) {
    let stored = store
        .with_conn(false, |c| {
            Ok(repo_app_state::get(c, LOGGING_ENABLED_KEY).ok().flatten())
        })
        .ok()
        .flatten();
    if let Some(entry) = stored {
        crate::log::set_enabled(entry.value_json == "true");
    }
}

#[tauri::command]
pub fn logging_get_enabled() -> bool {
    crate::log::is_enabled()
}

#[tauri::command]
pub fn logging_set_enabled(store: State<'_, Arc<Store>>, enabled: bool) -> SResult<()> {
    crate::log::set_enabled(enabled);
    store.with_conn(true, |c| {
        repo_app_state::set(c, LOGGING_ENABLED_KEY, if enabled { "true" } else { "false" })
    })?;
    crate::log::write_line("logs", &format!("file logging {}", if enabled { "enabled" } else { "disabled" }));
    Ok(())
}

/// A log file's contents for the viewer. `name` is "app" or "chat".
#[derive(serde::Serialize)]
pub struct LogContents {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    /// Tail of the file (whole thing if under the cap). Empty if missing.
    pub text: String,
}

fn read_log(file: &str, label: &str, max_chars: usize) -> LogContents {
    let path = crate::log::log_file(file);
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    // Cap what we ship to the webview so a near-5MB file doesn't choke the UI;
    // keep the tail (most recent lines).
    if text.len() > max_chars {
        let start = text.len() - max_chars;
        let cut = text[start..]
            .find('\n')
            .map(|i| start + i + 1)
            .unwrap_or(start);
        text = text[cut..].to_string();
    }
    LogContents {
        name: label.to_string(),
        path: path.display().to_string(),
        bytes,
        text,
    }
}

/// Read both logs for the viewer. `max_chars` caps the returned tail per file.
#[tauri::command]
pub fn logging_read(max_chars: Option<usize>) -> Vec<LogContents> {
    let cap = max_chars.unwrap_or(200_000);
    vec![
        read_log("app.log", "app", cap),
        read_log("chat.log", "chat", cap),
    ]
}

/// Clear one ("app"/"chat") or both (None) log files.
#[tauri::command]
pub fn logging_clear(which: Option<String>) -> Result<(), String> {
    let targets: &[&str] = match which.as_deref() {
        Some("app") => &["app.log"],
        Some("chat") => &["chat.log"],
        _ => &["app.log", "chat.log"],
    };
    for f in targets {
        let path = crate::log::log_file(f);
        if path.exists() {
            std::fs::write(&path, b"").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reveal the logs directory in the OS file manager.
#[tauri::command]
pub fn logging_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // The logs dir is the parent of app.log; ensure it exists first.
    let dir = crate::log::log_file("app.log");
    let dir = dir.parent().map(|p| p.to_path_buf()).unwrap_or(dir);
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
