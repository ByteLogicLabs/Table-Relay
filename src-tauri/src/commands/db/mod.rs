//! Tauri commands for database operations. Every command dispatches
//! through the adapter registry; reconnect is handled transparently by
//! `with_retry`.
//!
//! The command surface is split across focused submodules; everything is
//! re-exported from this module root so the `tauri::generate_handler!`
//! registration paths (`commands::db::*`) stay valid.

mod mutations;
mod queries;
mod realtime;
mod schema;

// Glob re-exports so the hidden `__cmd__*` macros that `#[tauri::command]`
// generates alongside each command function are also brought into this module
// root — `tauri::generate_handler!` resolves commands by that macro path
// (`commands::db::__cmd__<name>`), which a name-by-name `pub use` of just the
// functions would not satisfy.
pub use mutations::*;
pub use queries::*;
pub use realtime::*;
pub use schema::*;

use std::sync::Arc;

use adapter_api::{AdapterError, ServerInfo};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::{rebuild, with_retry};
use crate::db::registry::{ActiveConnection, ConnectionMeta, Registry};
use crate::db::subscriptions::SubscriptionRegistry;
use crate::store::repo::{self as store_repo, ConnectionProfile, ConnectionProfileInput};
use crate::store::Store;

/// Open (or re-open) a connection using credentials stored in the plain store.
///
/// Dispatches via the adapter factory: `factories.resolve(profile.driver)`
/// → `Factory::connect(profile)` → `Arc<dyn Adapter>`. The adapter is
/// registered so every downstream command can resolve it by id.
#[tauri::command]
pub async fn db_connect(
    connection_id: String,
    store: State<'_, Arc<Store>>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<ConnectionMeta, AdapterError> {
    let connect_lock = registry.reconnect_lock(&connection_id).await;
    let _connect_guard = connect_lock.lock().await;

    // Idempotency / tunnel reuse: if this connection is already live AND
    // healthy, return it instead of building a SECOND adapter + SSH tunnel.
    // A redundant `db_connect` (frontend state drift, a retry, two callers
    // racing) would otherwise re-run the full SSH handshake and replace the
    // working connection — the source of the observed tunnel thrashing
    // (34× Tunnel::open with 0 reconnects). `ping()` rides the existing pool
    // (and transparently revives a dead pooled socket through the LIVE tunnel
    // via the reconnect/test-before-acquire path), so a healthy tunnel is kept
    // and the handshake is skipped entirely. Only if there's no live entry, or
    // it fails to ping, do we fall through and build a fresh one.
    if let Ok(existing) = registry.get(&connection_id).await {
        if existing.ping().await.is_ok() {
            if let Some(meta) = registry.meta(&connection_id).await {
                return Ok(meta);
            }
        }
    }

    // Read the profile + plaintext password inside a short-lived lock.
    let profile = {
        store
            .with_conn(false, |guard| store_repo::find_by_id(guard, &connection_id))
            .map_err(|e| AdapterError::Other(e.to_string()))?
            .ok_or_else(|| {
                AdapterError::NotFound(format!("connection {connection_id} not in store"))
            })?
    };

    let adapter_id = factories.resolve(&profile.driver).ok_or_else(|| {
        AdapterError::Unsupported(format!(
            "driver `{}` has no adapter registered",
            profile.driver
        ))
    })?;
    let factory = factories.get(adapter_id)?;
    let manifest = factory.manifest();
    let adapter = factory
        .connect(profile.to_adapter_profile(adapter_id))
        .await?;

    let server = adapter.ping().await?;
    let meta = ConnectionMeta {
        id: connection_id.clone(),
        server,
    };
    registry
        .insert(
            connection_id,
            ActiveConnection {
                adapter,
                meta: meta.clone(),
                profile,
                manifest,
            },
        )
        .await;
    Ok(meta)
}

/// One step of the connection test. The UI renders these in order so the
/// user can see *where* a test failed — a red "SSH tunnel" step tells them
/// their jump host setup is wrong; a red "Database connect" step with a
/// green "SSH tunnel" above tells them the tunnel works but DB auth
/// doesn't.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStep {
    pub name: String,
    pub status: TestStepStatus,
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStepStatus {
    Ok,
    Failed,
    Skipped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub steps: Vec<TestStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerInfo>,
    /// True iff every non-skipped step succeeded.
    pub ok: bool,
}

/// Test a profile without persisting or adding it to the registry.
///
/// Implementation: builds a throwaway adapter via the factory, asks it
/// to ping, then shuts it down. Per-stage reporting comes at the cost
/// of losing the SSH-vs-DB granularity the old code had — the factory
/// doesn't surface which stage failed inside `connect`. We infer it
/// from the error `kind`: `SshTunnel` → SSH stage, anything else →
/// database stage.
#[tauri::command]
pub async fn db_test_connection(
    profile: ConnectionProfileInput,
    factories: State<'_, Arc<FactoryRegistry>>,
) -> Result<TestReport, AdapterError> {
    let profile = ConnectionProfile {
        id: profile.id.unwrap_or_else(|| "test".into()),
        name: profile.name,
        driver: profile.driver,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password: profile.password,
        database: profile.database,
        ssl_mode: profile.ssl_mode,
        ssh_enabled: profile.ssh_enabled,
        ssh_host: profile.ssh_host,
        ssh_port: profile.ssh_port,
        ssh_user: profile.ssh_user,
        ssh_auth_kind: profile.ssh_auth_kind,
        ssh_key_path: profile.ssh_key_path,
        ssh_password: profile.ssh_password,
        ssh_key_passphrase: profile.ssh_key_passphrase,
        color: profile.color,
        is_favorite: profile.is_favorite,
    };

    let adapter_id = factories.resolve(&profile.driver).ok_or_else(|| {
        AdapterError::Unsupported(format!(
            "driver `{}` has no adapter registered",
            profile.driver
        ))
    })?;
    let factory = factories.get(adapter_id)?;

    let mut steps: Vec<TestStep> = Vec::new();

    // Stage 1+2 collapsed — the factory owns SSH + DB connect. On
    // failure we disambiguate by error kind.
    let t_connect = std::time::Instant::now();
    let adapter_result = factory
        .connect(profile.to_adapter_profile(adapter_id))
        .await;
    let connect_ms = t_connect.elapsed().as_secs_f64() * 1000.0;

    let adapter = match adapter_result {
        Ok(a) => {
            if profile.ssh_enabled {
                steps.push(TestStep {
                    name: "SSH tunnel".into(),
                    status: TestStepStatus::Ok,
                    duration_ms: 0.0,
                    message: Some("tunnel up".into()),
                });
            } else {
                steps.push(TestStep {
                    name: "SSH tunnel".into(),
                    status: TestStepStatus::Skipped,
                    duration_ms: 0.0,
                    message: Some("not enabled".into()),
                });
            }
            steps.push(TestStep {
                name: "Database connect".into(),
                status: TestStepStatus::Ok,
                duration_ms: connect_ms,
                message: None,
            });
            a
        }
        Err(e) => {
            let is_ssh = matches!(e, AdapterError::SshTunnel(_));
            if profile.ssh_enabled && is_ssh {
                steps.push(TestStep {
                    name: "SSH tunnel".into(),
                    status: TestStepStatus::Failed,
                    duration_ms: connect_ms,
                    message: Some(e.to_string()),
                });
                steps.push(TestStep {
                    name: "Database connect".into(),
                    status: TestStepStatus::Skipped,
                    duration_ms: 0.0,
                    message: None,
                });
            } else {
                if profile.ssh_enabled {
                    steps.push(TestStep {
                        name: "SSH tunnel".into(),
                        status: TestStepStatus::Ok,
                        duration_ms: 0.0,
                        message: Some("tunnel up".into()),
                    });
                } else {
                    steps.push(TestStep {
                        name: "SSH tunnel".into(),
                        status: TestStepStatus::Skipped,
                        duration_ms: 0.0,
                        message: Some("not enabled".into()),
                    });
                }
                steps.push(TestStep {
                    name: "Database connect".into(),
                    status: TestStepStatus::Failed,
                    duration_ms: connect_ms,
                    message: Some(e.to_string()),
                });
            }
            steps.push(TestStep {
                name: "Server ping".into(),
                status: TestStepStatus::Skipped,
                duration_ms: 0.0,
                message: None,
            });
            return Ok(TestReport {
                steps,
                server: None,
                ok: false,
            });
        }
    };

    // Stage 3 — ping.
    let t_ping = std::time::Instant::now();
    let server = match adapter.ping().await {
        Ok(s) => {
            steps.push(TestStep {
                name: "Server ping".into(),
                status: TestStepStatus::Ok,
                duration_ms: t_ping.elapsed().as_secs_f64() * 1000.0,
                message: Some(format!(
                    "{} {}",
                    s.flavor.as_deref().unwrap_or(&s.adapter_id),
                    s.version
                )),
            });
            Some(s)
        }
        Err(e) => {
            steps.push(TestStep {
                name: "Server ping".into(),
                status: TestStepStatus::Failed,
                duration_ms: t_ping.elapsed().as_secs_f64() * 1000.0,
                message: Some(e.to_string()),
            });
            None
        }
    };

    adapter.shutdown().await;

    let ok = steps
        .iter()
        .all(|s| !matches!(s.status, TestStepStatus::Failed));
    Ok(TestReport { steps, server, ok })
}

#[tauri::command]
pub async fn db_disconnect(
    connection_id: String,
    registry: State<'_, Arc<Registry>>,
    subscriptions: State<'_, Arc<SubscriptionRegistry>>,
) -> Result<(), AdapterError> {
    // Stop any realtime pumps tied to this connection first so the
    // adapter's pubsub socket closes cleanly before we drop the adapter.
    subscriptions.cancel_for_connection(&connection_id).await;
    registry.remove(&connection_id).await
}

#[tauri::command]
pub async fn db_ping(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<ServerInfo, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.ping().await },
    )
    .await
}

#[tauri::command]
pub async fn db_list_active(
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<ConnectionMeta>, AdapterError> {
    Ok(registry.list().await)
}

/// Reconnect this connection to a different database. The adapter's
/// pool is torn down and rebuilt with `database = name`; the profile
/// snapshot in the registry is updated so later automatic reconnects
/// target the new database too. The on-disk profile is left alone so
/// the user's saved connection still reflects their preferred default.
#[tauri::command]
pub async fn db_switch_database(
    connection_id: String,
    database: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<ConnectionMeta, AdapterError> {
    crate::log_line!(
        "db_switch_database",
        "→ connection_id={} database={}",
        connection_id,
        database
    );
    let mut profile = registry.profile(&connection_id).await?;
    profile.database = Some(database);
    let (adapter, meta) = rebuild(&factories, &profile).await?;
    let meta_clone = meta.clone();
    registry
        .replace_with_profile(&connection_id, adapter, meta, profile)
        .await?;
    crate::log_line!(
        "db_switch_database",
        "  pool rebuilt on {:?}",
        meta_clone.server.default_schema
    );
    Ok(meta_clone)
}

/// Every adapter the host knows about. Drives the connection modal's
/// adapter picker + field list.
#[tauri::command]
pub async fn db_list_adapters(
    factories: State<'_, Arc<FactoryRegistry>>,
) -> Result<Vec<&'static adapter_api::AdapterManifest>, AdapterError> {
    Ok(factories.manifests())
}
