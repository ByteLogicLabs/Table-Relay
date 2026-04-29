//! Tiny logging indirection so adapter crates don't need to know about the
//! host's log file. The host calls `set_writer` at startup; adapters call
//! `write_line` (or the `log_line!` macro) and their lines go to the same
//! destination.
//!
//! If no writer is installed, lines go to stderr — useful for adapter unit
//! tests that don't boot the full host.

use std::sync::OnceLock;

type LogFn = fn(&str, &str);

static WRITER: OnceLock<LogFn> = OnceLock::new();

/// Host-side entry point. Call once at startup with a function that forwards
/// to your log pipeline. Idempotent — subsequent calls are ignored.
pub fn set_writer(f: LogFn) {
    let _ = WRITER.set(f);
}

/// Adapter-facing entry point. Prefer the `log_line!` macro which captures
/// the call site.
pub fn write_line(tag: &str, msg: &str) {
    if let Some(f) = WRITER.get() {
        f(tag, msg);
    } else {
        eprintln!("[{tag}] {msg}");
    }
}

/// Convenience macro. Same shape as the host's `log_line!`.
#[macro_export]
macro_rules! log_line {
    ($tag:expr, $($arg:tt)*) => {
        $crate::log::write_line($tag, &format!($($arg)*))
    };
}
