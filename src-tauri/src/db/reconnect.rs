//! Transparent reconnect layer for active connections.
//!
//! Wraps every adapter call. If the call fails with a transient-looking
//! error (pool timeout, TCP reset, SSH tunnel teardown, …) we rebuild
//! the underlying adapter up to `MAX_RETRIES` times with exponential
//! backoff, emitting lifecycle events along the way so the UI can show
//! a "reconnecting" badge and a final toast when we give up.
//!
//! Design choices:
//!   - Reactive, not proactive: no heartbeat. A dead connection is
//!     discovered when the *next* command fails, and the retry runs
//!     transparently in the same command's future. Covers server
//!     restarts, SSH timeouts, laptop sleep.
//!   - Per-connection serialization: if two commands both notice the
//!     same drop, only one rebuild runs. The other waits on the
//!     reconnect mutex and then re-issues its op on the fresh adapter.
//!   - Auth failures are *not* retried. Rebuilding won't fix a wrong
//!     password and we'd just spam the server.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use adapter_api::{Adapter, AdapterError};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::registry::{ConnectionMeta, Registry};
use crate::store::repo::ConnectionProfile;

const MAX_RETRIES: u32 = 3;

/// Backoff between attempts. Index 0 is the wait *before* retry 1, etc.
const BACKOFF_MS: [u64; MAX_RETRIES as usize] = [1_000, 3_000, 9_000];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReconnectEvent {
    connection_id: String,
    /// 1-based attempt index for reconnecting events, 0 for reconnected/lost.
    attempt: u32,
    max_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit(app: &AppHandle, event: &str, payload: ReconnectEvent) {
    if let Err(e) = app.emit(event, payload) {
        crate::log_line!("reconnect", "emit {event}: {e}");
    }
}

/// Is this the kind of error that a reconnect could plausibly fix?
///
/// `Authentication` / `NotFound` / `Syntax` / `Unsupported` aren't —
/// they'd produce the same error on a fresh adapter. `Connection` /
/// `Timeout` / `Io` / `SshTunnel` look transient and are worth retrying.
fn is_transient(err: &AdapterError) -> bool {
    err.is_transient() || is_transient_other(err)
}

/// sqlx collapses TCP resets + pool acquire failures into the catch-all
/// `Other` variant after the `From<sqlx::Error>` impl. Peek at the
/// message to recover the transient subset.
fn is_transient_other(err: &AdapterError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("connection reset")
        || msg.contains("broken pipe")
        || msg.contains("pool timed out")
        || msg.contains("connection refused")
        || msg.contains("connection closed")
        || msg.contains("unexpected eof")
        // sqlx's message for a stale/dropped connection (e.g. MySQL closing an
        // idle pooled socket via wait_timeout): "expected to read N bytes, got
        // 0 bytes at EOF". Distinct wording from "unexpected eof", so match it
        // explicitly — otherwise it surfaces raw instead of retrying on a fresh
        // connection, which the reconnect supervisor is designed to do.
        || msg.contains("bytes at eof")
        || msg.contains("no route to host")
}

/// Run `op(adapter)` against the current adapter for `id`. If it
/// returns a transient error, rebuild the adapter via the factory and
/// try again, up to `MAX_RETRIES` times. Permanent errors (auth,
/// syntax, etc.) short-circuit without rebuilding.
pub async fn with_retry<T, F, Fut>(
    app: &AppHandle,
    registry: &Arc<Registry>,
    factories: &Arc<FactoryRegistry>,
    id: &str,
    mut op: F,
) -> Result<T, AdapterError>
where
    F: FnMut(Arc<dyn Adapter>) -> Fut,
    Fut: Future<Output = Result<T, AdapterError>>,
{
    let mut last_err: AdapterError = AdapterError::Other("no attempt ran".into());
    for attempt in 0..=MAX_RETRIES {
        let adapter = registry.get(id).await?;
        match op(adapter).await {
            Ok(v) => {
                // The op worked. If a "Reconnecting…" toast was left showing
                // for this connection (a prior retry round announced it, then
                // the supervisor gave up but the connection actually
                // recovered), clear it now — otherwise it stays stuck forever.
                if registry.take_reconnecting(id).await {
                    crate::log_line!("reconnect", "{id}: recovered (op succeeded after a reconnecting toast)");
                    emit(
                        app,
                        "connection:reconnected",
                        ReconnectEvent {
                            connection_id: id.to_string(),
                            attempt: 0,
                            max_attempts: MAX_RETRIES,
                            error: None,
                        },
                    );
                }
                return Ok(v);
            }
            Err(e) => {
                if !is_transient(&e) || attempt == MAX_RETRIES {
                    if attempt > 0 && is_transient(&e) {
                        crate::log_line!("reconnect", "{id}: giving up after {attempt} retries, connection lost: {e}");
                        registry.take_reconnecting(id).await;
                        emit(
                            app,
                            "connection:lost",
                            ReconnectEvent {
                                connection_id: id.to_string(),
                                attempt: 0,
                                max_attempts: MAX_RETRIES,
                                error: Some(e.to_string()),
                            },
                        );
                    }
                    return Err(e);
                }
                crate::log_line!("reconnect", "{id}: transient error on attempt {attempt}, entering recovery: {e}");
                last_err = e;
            }
        }

        // Serialize reconnect attempts: if two commands both tripped
        // the retry path at the same time, only one rebuilds. The other
        // waits, then re-runs its op on the now-fresh adapter on the
        // next loop iteration.
        let lock = registry.reconnect_lock(id).await;
        let _guard = lock.lock().await;

        // Someone else may have already rebuilt while we were waiting.
        // Re-try the op once before committing to a rebuild.
        if let Ok(adapter) = registry.get(id).await {
            if let Ok(v) = op(adapter).await {
                crate::log_line!("reconnect", "{id}: silent recovery (op succeeded on pool re-draw, no rebuild)");
                if registry.take_reconnecting(id).await {
                    emit(
                        app,
                        "connection:reconnected",
                        ReconnectEvent {
                            connection_id: id.to_string(),
                            attempt: 0,
                            max_attempts: MAX_RETRIES,
                            error: None,
                        },
                    );
                }
                return Ok(v);
            }
            // The op failed, but is the POOL actually dead, or did we just
            // draw one corpse connection (server killed an idle socket)? Ping
            // the existing pool — a fresh ping opens a new connection. If it
            // succeeds the pool is healthy; rebuilding would be pointless and
            // (under a flapping server whose fresh handshakes EOF) spawns a
            // storm of orphaned pools that exhausts the server. Skip the
            // rebuild and let the next loop iteration re-issue the op on the
            // pool we already have.
            if let Ok(adapter) = registry.get(id).await {
                if adapter.ping().await.is_ok() {
                    crate::log_line!("reconnect", "{id}: silent recovery (existing pool pinged healthy, skipping rebuild)");
                    if registry.take_reconnecting(id).await {
                        emit(
                            app,
                            "connection:reconnected",
                            ReconnectEvent {
                                connection_id: id.to_string(),
                                attempt: 0,
                                max_attempts: MAX_RETRIES,
                                error: None,
                            },
                        );
                    }
                    // Drop the lock and retry the op on the healthy pool.
                    drop(_guard);
                    continue;
                }
            }
        }

        let next_attempt = attempt + 1;
        crate::log_line!("reconnect", "{id}: pool dead, rebuilding (attempt {next_attempt}/{MAX_RETRIES}): {last_err}");
        registry.set_reconnecting(id).await;
        emit(
            app,
            "connection:reconnecting",
            ReconnectEvent {
                connection_id: id.to_string(),
                attempt: next_attempt,
                max_attempts: MAX_RETRIES,
                error: Some(last_err.to_string()),
            },
        );
        tokio::time::sleep(Duration::from_millis(BACKOFF_MS[attempt as usize])).await;

        let profile = registry.profile(id).await?;
        match rebuild(factories, &profile).await {
            Ok((adapter, meta)) => {
                if let Err(e) = registry.replace(id, adapter, meta).await {
                    last_err = e;
                    continue;
                }
                crate::log_line!("reconnect", "{id}: rebuilt successfully on attempt {next_attempt}");
                registry.take_reconnecting(id).await;
                emit(
                    app,
                    "connection:reconnected",
                    ReconnectEvent {
                        connection_id: id.to_string(),
                        attempt: next_attempt,
                        max_attempts: MAX_RETRIES,
                        error: None,
                    },
                );
                // Next loop iteration will re-issue the op.
            }
            Err(e) => {
                crate::log_line!("reconnect", "rebuild attempt {next_attempt} failed: {e}");
                last_err = e;
                // Keep looping; the next backoff slot handles waiting.
            }
        }
    }

    crate::log_line!("reconnect", "{id}: exhausted {MAX_RETRIES} rebuild attempts, connection lost: {last_err}");
    registry.take_reconnecting(id).await;
    emit(
        app,
        "connection:lost",
        ReconnectEvent {
            connection_id: id.to_string(),
            attempt: 0,
            max_attempts: MAX_RETRIES,
            error: Some(last_err.to_string()),
        },
    );
    Err(last_err)
}

/// Build a fresh adapter from a stored profile via the factory
/// registry. Mirrors the body of `db_connect`; kept here rather than
/// calling the command so we don't re-enter the registry mid-rebuild.
pub(crate) async fn rebuild(
    factories: &Arc<FactoryRegistry>,
    profile: &ConnectionProfile,
) -> Result<(Arc<dyn Adapter>, ConnectionMeta), AdapterError> {
    let adapter_id = factories.resolve(&profile.driver).ok_or_else(|| {
        AdapterError::Unsupported(format!(
            "driver `{}` has no adapter registered",
            profile.driver
        ))
    })?;
    let factory = factories.get(adapter_id)?;
    let adapter = factory.connect(profile.to_adapter_profile(adapter_id)).await?;
    // If the post-connect ping fails, explicitly shut the just-built pool
    // down before returning. Otherwise every failed rebuild attempt leaks a
    // pool (and any connection its ping opened) — under a flapping server
    // that's hundreds of orphaned connections, which exhausts the server's
    // max_connections and looks like a crash. `connect()` is lazy so a
    // clean ping-failure usually holds ≤1 socket, but we must not rely on
    // Drop timing for that.
    let server = match adapter.ping().await {
        Ok(s) => s,
        Err(e) => {
            adapter.shutdown().await;
            return Err(e);
        }
    };
    let meta = ConnectionMeta {
        id: profile.id.clone(),
        server,
    };
    Ok((adapter, meta))
}
