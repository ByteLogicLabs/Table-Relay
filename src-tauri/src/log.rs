//! Simple file-based logger.
//!
//! Writes newline-delimited entries to `<workspace>/logs/app.log`. In debug
//! builds the workspace is the project root (determined via
//! `CARGO_MANIFEST_DIR/../logs`); in release we fall back to the app data
//! directory. Cheap enough that callers can log freely during debugging.
//!
//! Use the `log_line!` macro so the call site file/line is recorded.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

fn logs_dir() -> PathBuf {
    // In dev we know exactly where the project lives.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut p = PathBuf::from(manifest);
    p.pop(); // drop `src-tauri`
    p.push("logs");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn log_path() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut p = logs_dir();
        p.push("app.log");
        p
    })
}

fn chat_log_path() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut p = logs_dir();
        p.push("chat.log");
        p
    })
}

pub fn write_line(tag: &str, msg: &str) {
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{ts}] [{tag}] {msg}\n");
    // Best-effort: don't crash the app if the log write fails.
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = f.write_all(line.as_bytes());
    }
    // Also mirror to stderr so it shows up in `tauri dev` output.
    eprint!("{line}");
}

/// Dedicated chat transcript logger. Every user turn, assistant reply, and
/// tool round-trip goes here so the user can review what was said without
/// sifting through the main app log. Role is prefixed so the file reads top
/// to bottom like a conversation.
pub fn write_chat(role: &str, msg: &str) {
    let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{ts}] [{role}] {msg}\n");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(chat_log_path()) {
        let _ = f.write_all(line.as_bytes());
    }
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
