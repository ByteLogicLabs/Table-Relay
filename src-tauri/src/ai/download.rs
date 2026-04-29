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

/// Where downloads live. Resolution order:
///   1. `DBTABLE_MODEL_DIR` env var (useful for tests / CI / packaged apps).
///   2. `<project_root>/ai-models/` where `project_root` is the first
///      ancestor of `cwd` containing a `src-tauri/` or `package.json`.
///      This matters in Tauri dev mode, where `cwd` is `<project>/src-tauri/`
///      — without this we'd litter weights inside `src-tauri/ai-models/`.
///   3. `<cwd>/ai-models/` as a last-resort fallback.
pub fn models_dir() -> PathBuf {
    if let Ok(p) = std::env::var("DBTABLE_MODEL_DIR") {
        return PathBuf::from(p);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = find_project_root(&cwd) {
        return root.join("ai-models");
    }
    cwd.join("ai-models")
}

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
    let entry = models_catalog::find(&id)
        .ok_or_else(|| AiError::InvalidModel(format!("unknown model id: {id}")))?;

    // `"TODO"` is the dev sentinel: we still hash the download and log the
    // result, so the operator can paste the verified hash back into the
    // catalog. Any non-`TODO` value is treated as authoritative and any
    // mismatch hard-fails the install.
    let verify_hash = entry.sha256 != "TODO";

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

    let mut req = client()?.get(entry.url);
    if start_offset > 0 {
        req = req.header("Range", format!("bytes={}-", start_offset));
    }
    let res = req.send().await.map_err(map_reqwest)?;
    let status = res.status();
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
        .unwrap_or(entry.size_bytes);

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

    // Compute SHA256 in every case. Streams the partial read-only through
    // the hasher so memory stays constant for multi-GB files.
    let actual = sha256_of(&part_path).await?;

    if verify_hash {
        if !actual.eq_ignore_ascii_case(entry.sha256) {
            let _ = tokio::fs::remove_file(&part_path).await;
            let msg = format!(
                "sha256 mismatch for {id}: expected {} got {actual}",
                entry.sha256
            );
            let _ = app.emit(
                "ai://download/done",
                DoneEvent { model_id: &id, status: "error", message: Some(msg.clone()) },
            );
            return Err(AiError::Other(msg));
        }
    } else {
        // No pinned hash yet. Log the computed value so the operator can
        // paste it back into `models_catalog.rs` to lock it down for future
        // users. This is the one case where we install an unverified blob —
        // a deliberate dev escape hatch.
        crate::log_line!(
            "ai_download",
            "model {id} installed without hash verification. Pin this into models_catalog.rs: sha256 = \"{actual}\""
        );
    }

    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| AiError::Other(format!("rename: {e}")))?;
    let done_msg = if verify_hash {
        None
    } else {
        // Surface the hash to the UI too — shows up in the "done" toast so
        // you don't have to tail the log to see it.
        Some(format!("installed without hash verification · sha256 {actual}"))
    };
    let _ = app.emit(
        "ai://download/done",
        DoneEvent { model_id: &id, status: "ok", message: done_msg },
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
