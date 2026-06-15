//! App + chat file logging, available in release builds.
//!
//! Logging is OFF by default and opt-in: the frontend toggles it via
//! `set_logging_enabled` (persisted in app-state and re-applied on launch). When
//! enabled, lines are appended to `<app-data>/logs/{app,chat}.log` as
//! `[ts] [tag] msg`. Each file is ring-capped at `MAX_LOG_BYTES` (5 MB): once it
//! would exceed the cap we drop the oldest whole lines so it holds roughly the
//! newest 5 MB.
//!
//! `log_line!(tag, "...")` writes operational lines to `app.log`; `log_chat!`
//! writes the AI conversation transcript to `chat.log`. The viewer highlights
//! problems by reading the message text (no severity token is stored).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// Per-file size cap. At 5 MB we trim the oldest lines (ring buffer).
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Runtime on/off. Default OFF; the frontend enables it from Settings. In debug
/// builds we default ON so local dev keeps its familiar `logs/` output.
static ENABLED: AtomicBool = AtomicBool::new(cfg!(debug_assertions));

/// The logs directory. In a packaged build this is `<app-data>/logs`, set once
/// at startup via [`set_log_dir`]. If never set (e.g. very early startup or a
/// unit test), we fall back to the source-tree `logs/` so dev behaviour is
/// unchanged.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Serialize writes so concurrent appends + ring-trims don't interleave.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Point file logging at the app-data logs directory. Call once at setup with
/// `app.path().app_data_dir()`. No-op (keeps the dev fallback) if called twice.
pub fn set_log_dir(app_data_dir: &std::path::Path) {
    let dir = app_data_dir.join("logs");
    let _ = LOG_DIR.set(dir);
}

/// Enable or disable file logging at runtime.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// Whether file logging is currently on.
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

fn logs_dir() -> PathBuf {
    if let Some(d) = LOG_DIR.get() {
        return d.clone();
    }
    // Dev fallback: source-tree `logs/` next to src-tauri.
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.push("logs");
    p
}

/// Absolute path to `app.log` (whether or not it exists yet).
pub fn log_file(name: &str) -> PathBuf {
    logs_dir().join(name)
}

/// Append a line to `<logs>/<file>`, creating the dir/file as needed and
/// ring-trimming to `MAX_LOG_BYTES`. Best-effort: any IO error is swallowed so
/// logging never breaks the app.
fn append(file: &str, line: &str) {
    if !is_enabled() {
        return;
    }
    let _guard = WRITE_LOCK.lock();
    let dir = logs_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(file);

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }

    // Ring-trim: if the file grew past the cap, drop the oldest whole lines so
    // it keeps roughly the newest MAX_LOG_BYTES. We aim a bit under the cap so
    // we don't trim on every single write once near the limit.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            trim_to_tail(&path, MAX_LOG_BYTES * 3 / 4);
        }
    }
}

/// Rewrite `path` keeping only its trailing `keep_bytes`, snapped to a line
/// boundary so we never leave a half line at the top.
fn trim_to_tail(path: &std::path::Path, keep_bytes: u64) {
    let Ok(data) = fs::read(path) else { return };
    if (data.len() as u64) <= keep_bytes {
        return;
    }
    let start = data.len() - keep_bytes as usize;
    // Advance to just past the next newline so the first retained line is whole.
    let cut = data[start..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    let _ = fs::write(path, &data[cut..]);
}

/// Append one line to `app.log` as `[ts] [tag] msg`. In debug builds it also
/// mirrors to stderr so local `tauri dev` keeps showing logs in the terminal.
pub fn write_line(tag: &str, msg: &str) {
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{ts}] [{tag}] {msg}\n");
    append("app.log", &line);
    #[cfg(debug_assertions)]
    eprint!("{line}");
}

/// Append one line to `chat.log` as `[ts] [role] msg`. The AI conversation
/// transcript (user/assistant/tool turns + chat-side errors) goes here, kept
/// separate from the operational `app.log`.
pub fn write_chat(role: &str, msg: &str) {
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{ts}] [{role}] {msg}\n");
    append("chat.log", &line);
}

/// Frontend → log bridge. The webview calls this so its diagnostics land in the
/// same `app.log` the user shares, interleaved with backend lines (shared
/// timestamp clock). Tagged `fe:<tag>` so frontend lines are greppable.
#[tauri::command]
pub fn frontend_log(tag: String, msg: String) {
    write_line(&format!("fe:{tag}"), &msg);
}

#[macro_export]
macro_rules! log_line {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::write_line($tag, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_chat {
    ($role:expr, $($arg:tt)*) => {
        $crate::log::write_chat($role, &format!($($arg)*))
    };
}
