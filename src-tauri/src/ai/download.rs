//! GGUF model download manager. Streams to a `.part` file, resumes on
//! interruption via HTTP `Range`, verifies SHA256 at the end, renames to
//! the final path. Progress events are throttled to ~500ms cadence so we
//! don't flood the frontend with thousands of per-chunk updates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::http::{client, map_reqwest, map_status};
use super::models_catalog::{self, ModelEntry};
use super::AiError;

/// Where downloaded GGUF model weights live. Resolution order:
///   1. `DBTABLE_MODEL_DIR` env var (tests / CI / explicit override).
///   2. The OS app-data directory (`…/me.bytelogic.tablerelay/ai-models`) — the
///      correct, persistent, user-writable location for PACKAGED builds on
///      macOS / Windows / Linux. Models live beside the encrypted store and
///      survive app updates.
///   3. (DEBUG BUILDS ONLY) `<project_root>/ai-models/` so `tauri dev` doesn't
///      litter weights inside the OS app-data dir while iterating. Release
///      builds NEVER use this — a packaged app must not write into a project
///      tree (which may not exist, or may be read-only).
///   4. `<cwd>/ai-models/` as a last-resort fallback.
///
/// IMPORTANT: prod prefers app-data over project-root. The previous order had
/// these reversed, so a release app launched from a directory that merely
/// contained a `package.json` would scatter multi-GB weights there instead of
/// the proper app-data location.
pub fn models_dir() -> PathBuf {
    if let Ok(p) = std::env::var("DBTABLE_MODEL_DIR") {
        return PathBuf::from(p);
    }
    // Dev convenience: keep weights in the project tree during `tauri dev`.
    #[cfg(debug_assertions)]
    {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        if let Some(root) = find_project_root(&cwd) {
            return root.join("ai-models");
        }
    }
    if let Some(data) = os_app_data_dir() {
        return data.join("ai-models");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("ai-models")
}

/// Platform app-data dir for `me.bytelogic.tablerelay`, resolved from env without
/// pulling in the `dirs` crate. Mirrors Tauri's `app_data_dir()` layout so
/// models land beside the encrypted store:
///   macOS   → ~/Library/Application Support/me.bytelogic.tablerelay
///   Windows → %APPDATA%\me.bytelogic.tablerelay
///   Linux   → $XDG_DATA_HOME/me.bytelogic.tablerelay  (or ~/.local/share/…)
fn os_app_data_dir() -> Option<PathBuf> {
    const BUNDLE_ID: &str = "me.bytelogic.tablerelay";

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(BUNDLE_ID),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join(BUNDLE_ID))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg).join(BUNDLE_ID));
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(BUNDLE_ID),
        )
    }
}

#[cfg(debug_assertions)]
fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut cursor = start.to_path_buf();
    loop {
        // `src-tauri/` is the authoritative marker for this project.
        // `package.json` is a fallback in case the layout changes.
        if cursor.join("src-tauri").is_dir() || cursor.join("package.json").is_file() {
            return Some(cursor);
        }
        if !cursor.pop() {
            return None;
        }
    }
}

pub fn model_path(id: &str) -> PathBuf {
    models_dir().join(format!("{id}.gguf"))
}

fn partial_path(id: &str) -> PathBuf {
    models_dir().join(format!("{id}.gguf.part"))
}

/// Tracks in-flight downloads so `ai_cancel_download` can flip the flag.
#[derive(Default)]
pub struct DownloadRegistry {
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalModelInfo {
    #[serde(flatten)]
    pub entry: ModelEntry,
    pub downloaded: bool,
    pub downloaded_bytes: u64,
    pub has_partial: bool,
    pub partial_bytes: u64,
    /// False while the catalog entry's `sha256` is still `"TODO"` — the
    /// download will be hash-logged but not hash-verified. Surfaced to the
    /// UI so the user can see which entries still need pinning.
    pub hash_pinned: bool,
}

pub async fn list_local() -> Vec<LocalModelInfo> {
    let mut out = Vec::new();
    for entry in models_catalog::catalog() {
        let final_path = model_path(entry.id);
        let part_path = partial_path(entry.id);
        let (downloaded, downloaded_bytes) = match tokio::fs::metadata(&final_path).await {
            Ok(m) => (true, m.len()),
            Err(_) => (false, 0),
        };
        let (has_partial, partial_bytes) = match tokio::fs::metadata(&part_path).await {
            Ok(m) => (true, m.len()),
            Err(_) => (false, 0),
        };
        out.push(LocalModelInfo {
            entry: entry.clone(),
            downloaded,
            downloaded_bytes,
            has_partial,
            partial_bytes,
            hash_pinned: entry.sha256 != "TODO",
        });
    }
    out
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent<'a> {
    model_id: &'a str,
    downloaded: u64,
    total: u64,
    /// Moving average, bytes/sec.
    speed_bps: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent<'a> {
    model_id: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub async fn download(
    id: String,
    app: AppHandle,
    registry: Arc<DownloadRegistry>,
) -> Result<(), AiError> {
    download_inner(id, None, app, registry).await
}

/// Download a user-supplied GGUF by URL (not in the catalog). `id` becomes the
/// on-disk filename stem and the model id the user picks in the chat. No hash
/// verification (we have nothing to pin against) — the file is hash-logged only.
pub async fn download_url(
    id: String,
    url: String,
    app: AppHandle,
    registry: Arc<DownloadRegistry>,
) -> Result<(), AiError> {
    download_inner(id, Some(url), app, registry).await
}

async fn download_inner(
    id: String,
    custom_url: Option<String>,
    app: AppHandle,
    registry: Arc<DownloadRegistry>,
) -> Result<(), AiError> {
    // Resolve the source URL + verification policy + size hint either from the
    // built-in catalog (by id) or from a user-supplied URL (custom download).
    let (source_url, expected_sha, size_hint): (String, Option<String>, u64) = match &custom_url {
        Some(u) => {
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err(AiError::InvalidModel(
                    "model URL must start with http:// or https://".into(),
                ));
            }
            // No catalog entry → nothing to hash-verify against; size unknown.
            (u.clone(), None, 0)
        }
        None => {
            let entry = models_catalog::find(&id)
                .ok_or_else(|| AiError::InvalidModel(format!("unknown model id: {id}")))?;
            // `"TODO"` is the dev sentinel: we still hash the download and log the
            // result. Any non-`TODO` value is authoritative and a mismatch
            // hard-fails the install.
            let expected = if entry.sha256 == "TODO" { None } else { Some(entry.sha256.to_string()) };
            (entry.url.to_string(), expected, entry.size_bytes)
        }
    };

    let dir = models_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AiError::Other(format!("mkdir {}: {e}", dir.display())))?;

    let final_path = model_path(&id);
    let part_path = partial_path(&id);

    if final_path.exists() {
        // Already installed. Treat as no-op success so re-clicking Download
        // doesn't fail; the UI can short-circuit too.
        let _ = app.emit(
            "ai://download/done",
            DoneEvent { model_id: &id, status: "already_installed", message: None },
        );
        return Ok(());
    }

    // Set up cancel flag.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut reg = registry.cancels.lock().await;
        reg.insert(id.clone(), cancel.clone());
    }
    // Remove the cancel flag when we return, however we got here.
    let _cleanup = CancelCleanup { reg: registry.clone(), id: id.clone() };

    // If we have a partial file from a prior interrupted attempt, resume
    // from its current length. The server must support Range — we detect
    // that via HTTP 206.
    let start_offset = match tokio::fs::metadata(&part_path).await {
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    let mut req = client()?.get(&source_url);
    if start_offset > 0 {
        req = req.header("Range", format!("bytes={}-", start_offset));
    }
    let res = req.send().await.map_err(map_reqwest)?;
    let status = res.status();
    // HTTP 416 (Range Not Satisfiable) means the `.part` is ALREADY the full
    // file — a prior attempt downloaded everything but was killed (HMR/rebuild/
    // crash) before finalize, leaving a complete `.part` that looked "stuck" in
    // the UI. Skip straight to verify + rename instead of erroring.
    if status.as_u16() == 416 && start_offset > 0 {
        crate::log_line!("ai_download", "{id}: .part already complete ({start_offset} bytes), finalizing");
        return finalize_download(&id, &part_path, &final_path, expected_sha, &app).await;
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(map_status(status, &body));
    }

    // If we asked for a range and the server gave us a full 200, it doesn't
    // support Range — wipe the partial and restart from zero.
    let resumed = status.as_u16() == 206 && start_offset > 0;
    let total = res
        .content_length()
        .map(|n| n + if resumed { start_offset } else { 0 })
        .unwrap_or(size_hint);

    let mut file = if resumed {
        OpenOptions::new()
            .append(true)
            .create(true)
            .open(&part_path)
            .await
            .map_err(|e| AiError::Other(format!("open {}: {e}", part_path.display())))?
    } else {
        // Wipe any stale partial before starting fresh.
        let _ = tokio::fs::remove_file(&part_path).await;
        File::create(&part_path)
            .await
            .map_err(|e| AiError::Other(format!("create {}: {e}", part_path.display())))?
    };

    let mut downloaded: u64 = if resumed { start_offset } else { 0 };
    let mut last_emit = Instant::now();
    let mut last_emit_bytes = downloaded;
    let start_time = Instant::now();

    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "ai://download/done",
                DoneEvent { model_id: &id, status: "canceled", message: None },
            );
            return Err(AiError::Canceled);
        }
        let bytes = chunk.map_err(map_reqwest)?;
        file.write_all(&bytes)
            .await
            .map_err(|e| AiError::Other(format!("write: {e}")))?;
        downloaded += bytes.len() as u64;

        // Throttle emits. One update per 500ms is enough to animate a
        // progress bar without saturating the IPC bus.
        if last_emit.elapsed() >= Duration::from_millis(500) {
            let elapsed = start_time.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "ai://download/progress",
                ProgressEvent {
                    model_id: &id,
                    downloaded,
                    total,
                    speed_bps: ((downloaded.saturating_sub(start_offset)) as f64 / elapsed) as u64,
                },
            );
            last_emit = Instant::now();
            last_emit_bytes = downloaded;
        }
    }
    // Final progress emit so the bar hits 100% even if the last throttle
    // window swallowed the closing bytes.
    let _ = app.emit(
        "ai://download/progress",
        ProgressEvent {
            model_id: &id,
            downloaded,
            total,
            speed_bps: 0,
        },
    );
    let _ = last_emit_bytes;

    file.flush().await.ok();
    drop(file);

    finalize_download(&id, &part_path, &final_path, expected_sha, &app).await
}

/// Verify (if a hash is pinned) + rename `.part` → `.gguf` + emit the terminal
/// `done` event. Shared by the normal download path AND the
/// `.part`-already-complete recovery path. Emits a `verifying` status first so
/// the UI shows "Verifying…" during the (multi-second, multi-GB) hash instead of
/// sitting at a silent 100% that looks stuck.
async fn finalize_download(
    id: &str,
    part_path: &Path,
    final_path: &Path,
    expected_sha: Option<String>,
    app: &AppHandle,
) -> Result<(), AiError> {
    // Tell the UI we've left the download phase and are now verifying.
    let _ = app.emit(
        "ai://download/done",
        DoneEvent { model_id: id, status: "verifying", message: None },
    );

    // Compute SHA256. Streams read-only so memory stays constant for multi-GB
    // files.
    let actual = sha256_of(part_path).await?;

    if let Some(expected) = &expected_sha {
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(part_path).await;
            let msg = format!("sha256 mismatch for {id}: expected {expected} got {actual}");
            let _ = app.emit(
                "ai://download/done",
                DoneEvent { model_id: id, status: "error", message: Some(msg.clone()) },
            );
            return Err(AiError::Other(msg));
        }
    } else {
        crate::log_line!(
            "ai_download",
            "model {id} installed without hash verification. Pin this into models_catalog.rs: sha256 = \"{actual}\""
        );
    }

    tokio::fs::rename(part_path, final_path)
        .await
        .map_err(|e| AiError::Other(format!("rename: {e}")))?;
    let done_msg = if expected_sha.is_some() {
        None
    } else {
        Some(format!("installed without hash verification · sha256 {actual}"))
    };
    let _ = app.emit(
        "ai://download/done",
        DoneEvent { model_id: id, status: "ok", message: done_msg },
    );
    Ok(())
}

async fn sha256_of(path: &Path) -> Result<String, AiError> {
    let mut f = File::open(path)
        .await
        .map_err(|e| AiError::Other(format!("hash open: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .await
            .map_err(|e| AiError::Other(format!("hash read: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub async fn cancel(id: &str, registry: Arc<DownloadRegistry>) -> Result<(), AiError> {
    let reg = registry.cancels.lock().await;
    let Some(flag) = reg.get(id) else {
        return Err(AiError::InvalidModel(format!("no active download for {id}")));
    };
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

pub async fn delete_model(id: &str, session_active_model: Option<&str>) -> Result<(), AiError> {
    if session_active_model == Some(id) {
        return Err(AiError::Other(format!(
            "cannot delete {id}: it's the active session's model. End chat first.",
        )));
    }
    let final_path = model_path(id);
    let part_path = partial_path(id);
    let _ = tokio::fs::remove_file(&final_path).await;
    let _ = tokio::fs::remove_file(&part_path).await;
    Ok(())
}

/// RAII guard that clears the cancel-flag entry when the download future
/// finishes (success, cancel, or error).
struct CancelCleanup {
    reg: Arc<DownloadRegistry>,
    id: String,
}

impl Drop for CancelCleanup {
    fn drop(&mut self) {
        let reg = self.reg.clone();
        let id = self.id.clone();
        // Can't await in Drop; spawn a cheap task. If the runtime is gone
        // we're already tearing down — nothing to clean up.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut guard = reg.cancels.lock().await;
                guard.remove(&id);
            });
        }
    }
}
