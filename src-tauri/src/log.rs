pub fn write_line(tag: &str, msg: &str) {
    #[cfg(debug_assertions)]
    {
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::path::PathBuf;
        use std::sync::OnceLock;

        fn log_path() -> &'static PathBuf {
            static PATH: OnceLock<PathBuf> = OnceLock::new();
            PATH.get_or_init(|| {
                let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                p.pop();
                p.push("logs");
                let _ = std::fs::create_dir_all(&p);
                p.push("app.log");
                p
            })
        }

        let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{ts}] [{tag}] {msg}\n");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
            let _ = f.write_all(line.as_bytes());
        }
        eprint!("{line}");
    }
    #[cfg(not(debug_assertions))]
    let _ = (tag, msg);
}

pub fn write_chat(role: &str, msg: &str) {
    #[cfg(debug_assertions)]
    {
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::path::PathBuf;
        use std::sync::OnceLock;

        fn chat_log_path() -> &'static PathBuf {
            static PATH: OnceLock<PathBuf> = OnceLock::new();
            PATH.get_or_init(|| {
                let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                p.pop();
                p.push("logs");
                let _ = std::fs::create_dir_all(&p);
                p.push("chat.log");
                p
            })
        }

        let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{ts}] [{role}] {msg}\n");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(chat_log_path()) {
            let _ = f.write_all(line.as_bytes());
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (role, msg);
}

/// Frontend → log bridge. The webview calls this so its diagnostics land in the
/// same `logs/app.log` the user already shares, interleaved with backend lines
/// (shared timestamp clock) — invaluable for tracing where a chat turn breaks
/// across the JS/Rust boundary. Tagged `fe:<tag>` so frontend lines are greppable.
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
