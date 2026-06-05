//! Realtime subscriptions plus server-process administration: subscribe /
//! unsubscribe to adapter-native event streams, list / kill processes, and
//! analyze a command for warnings.

use std::sync::Arc;

use adapter_api::{
    AdapterError, CommandWarning, KillResult, ProcessInfo, SubscribeEvent, SubscribeRequest,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
use uuid::Uuid;

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::with_retry;
use crate::db::registry::Registry;
use crate::db::subscriptions::{SubscriptionEntry, SubscriptionRegistry};

/// Wire shape for `db_subscribe`. The `pattern` is adapter-native (Redis
/// glob, Postgres channel name, …) — no translation on the host side.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequestInput {
    #[serde(default)]
    pub schema: Option<String>,
    pub pattern: String,
}

/// Response from `db_subscribe` — the server-generated id the UI must
/// pass to `db_unsubscribe` to stop the subscription.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeResponse {
    pub subscription_id: String,
}

/// Open a realtime subscription. Events stream to the caller via the
/// Tauri IPC channel; the returned id is how the frontend tells the
/// host to stop the pump later.
///
/// Does not go through `with_retry` — subscriptions aren't safe to
/// restart transparently mid-stream (the UI would lose events silently).
/// A dropped pubsub connection surfaces as the stream ending on the
/// frontend side; users can re-subscribe deliberately.
#[tauri::command]
pub async fn db_subscribe(
    connection_id: String,
    request: SubscribeRequestInput,
    on_event: Channel<SubscribeEvent>,
    registry: State<'_, Arc<Registry>>,
    subscriptions: State<'_, Arc<SubscriptionRegistry>>,
) -> Result<SubscribeResponse, AdapterError> {
    let adapter = registry.get(&connection_id).await?;
    let req = SubscribeRequest {
        schema: request.schema,
        pattern: request.pattern,
    };

    // Bridge the adapter's tokio mpsc → the Tauri IPC channel. One
    // spawned task per subscription; exits when the mpsc closes (the
    // adapter's pump stopped) or the channel send errors (webview gone).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SubscribeEvent>();
    let handle = adapter.subscribe(req, tx).await?;

    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });

    let subscription_id = Uuid::new_v4().to_string();
    subscriptions
        .insert(
            subscription_id.clone(),
            SubscriptionEntry {
                connection_id: connection_id.clone(),
                handle,
            },
        )
        .await;

    Ok(SubscribeResponse { subscription_id })
}

/// Cancel an active subscription. Idempotent — unknown ids return Ok
/// so the frontend doesn't have to special-case double-stops.
#[tauri::command]
pub async fn db_unsubscribe(
    subscription_id: String,
    subscriptions: State<'_, Arc<SubscriptionRegistry>>,
) -> Result<(), AdapterError> {
    let _ = subscriptions.cancel(&subscription_id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_process_list(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<ProcessInfo>, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.process_list().await },
    )
    .await
}

#[tauri::command]
pub async fn db_kill_process(
    app: AppHandle,
    connection_id: String,
    process_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let pid = process_id.clone();
        async move { a.kill_process(&pid).await }
    })
    .await
}

#[tauri::command]
pub async fn db_kill_processes(
    app: AppHandle,
    connection_id: String,
    process_ids: Vec<String>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<KillResult>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let pids = process_ids.clone();
        async move { a.kill_processes(&pids).await }
    })
    .await
}

#[tauri::command]
pub async fn db_analyze_command(
    app: AppHandle,
    connection_id: String,
    command: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<CommandWarning>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let cmd = command.clone();
        async move { Ok(a.analyze_command(&cmd).await) }
    })
    .await
}
