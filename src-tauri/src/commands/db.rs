//! Tauri commands for database operations. Every command dispatches
//! through the adapter registry; reconnect is handled transparently by
//! `with_retry`.

use std::sync::Arc;

use adapter_api::{
    AdapterError, BrowseRequest, BrowseResult, CommandWarning, ForeignKey, IndexColumn,
    IndexKeyValue, IndexSpec, KillResult, ModifyIndexesRequest, MutateRequest, Page,
    PrimaryKeyValue, ProcessInfo, QueryResult, RoutineDefinition, RoutineInfo, SchemaInfo,
    ServerInfo, StatementResult, SubscribeEvent, SubscribeRequest, TableStructure, ViewInfo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{ipc::Channel, AppHandle, State};
use uuid::Uuid;

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::{rebuild, with_retry};
use crate::db::registry::{ActiveConnection, ConnectionMeta, Registry};
use crate::db::subscriptions::{SubscriptionEntry, SubscriptionRegistry};
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

#[tauri::command]
pub async fn db_list_schemas(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<SchemaInfo>, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.list_schemas().await },
    )
    .await
}

#[tauri::command]
pub async fn db_list_databases(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<String>, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.list_databases().await },
    )
    .await
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

#[tauri::command]
pub async fn db_describe_table(
    app: AppHandle,
    connection_id: String,
    schema: String,
    table: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<TableStructure, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        let table = table.clone();
        async move { a.describe_table(&schema, &table).await }
    })
    .await
}

#[tauri::command]
pub async fn db_list_relations(
    app: AppHandle,
    connection_id: String,
    schema: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<ForeignKey>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        async move { a.list_relations(&schema).await }
    })
    .await
}

#[tauri::command]
pub async fn db_describe_schema(
    app: AppHandle,
    connection_id: String,
    schema: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<TableStructure>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        async move { a.describe_schema(&schema).await }
    })
    .await
}

#[tauri::command]
pub async fn db_run_query(
    app: AppHandle,
    connection_id: String,
    statement: String,
    row_limit: Option<u32>,
    schema: Option<String>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<QueryResult, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let statement = statement.clone();
        let schema = schema.clone();
        async move {
            a.execute_raw_scoped(&statement, row_limit, schema.as_deref())
                .await
        }
    })
    .await
}

#[tauri::command]
pub async fn db_run_query_stream(
    app: AppHandle,
    connection_id: String,
    statement: String,
    row_limit: Option<u32>,
    schema: Option<String>,
    on_statement: Channel<StatementResult>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<QueryResult, AdapterError> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StatementResult>();
    let forwarder = tokio::spawn(async move {
        while let Some(statement) = rx.recv().await {
            if on_statement.send(statement).is_err() {
                break;
            }
        }
    });

    let result = with_retry(&app, &registry, &factories, &connection_id, |a| {
        let statement = statement.clone();
        let schema = schema.clone();
        let sink = tx.clone();
        async move {
            a.execute_raw_scoped_stream(&statement, row_limit, schema.as_deref(), sink)
                .await
        }
    })
    .await;

    drop(tx);
    let _ = forwarder.await;
    result
}

/// Wire shape for `db_update_rows`. Kept as a host-side alias so the
/// frontend contract doesn't shift — internally we translate into the
/// adapter's `MutateRequest::Update`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRowsRequest {
    pub schema: String,
    pub table: String,
    pub primary_key: Vec<PrimaryKeyValue>,
    pub changes: std::collections::BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRowsResult {
    pub rows_affected: u64,
}

/// Wire shape for `db_insert_rows`. Host-side alias for
/// `MutateRequest::Insert` so the frontend can stay intent-driven and
/// avoid building adapter-specific INSERT text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowsRequest {
    pub schema: String,
    pub table: String,
    pub values: std::collections::BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertRowsResult {
    pub rows_affected: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_primary_key: Option<std::collections::BTreeMap<String, JsonValue>>,
}

#[tauri::command]
pub async fn db_insert_rows(
    app: AppHandle,
    connection_id: String,
    request: InsertRowsRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<InsertRowsResult, AdapterError> {
    let mutation = with_retry(&app, &registry, &factories, &connection_id, |a| {
        let req = MutateRequest::Insert {
            schema: request.schema.clone(),
            table: request.table.clone(),
            values: request.values.clone(),
        };
        async move { a.mutate(req).await }
    })
    .await?;
    Ok(InsertRowsResult {
        rows_affected: mutation.records_affected,
        generated_primary_key: mutation.generated_primary_key,
    })
}

#[tauri::command]
pub async fn db_update_rows(
    app: AppHandle,
    connection_id: String,
    request: UpdateRowsRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<UpdateRowsResult, AdapterError> {
    let mutation = with_retry(&app, &registry, &factories, &connection_id, |a| {
        let req = MutateRequest::Update {
            schema: request.schema.clone(),
            table: request.table.clone(),
            primary_key: request.primary_key.clone(),
            changes: request.changes.clone(),
        };
        async move { a.mutate(req).await }
    })
    .await?;
    Ok(UpdateRowsResult {
        rows_affected: mutation.records_affected,
    })
}

/// Wire shape for `db_modify_indexes`. Translates the host-side
/// flat shape into the adapter trait's `ModifyIndexesRequest`. Used by
/// the schema editor's Mongo path; SQL adapters keep going through the
/// existing CREATE/DROP INDEX SQL via run_query.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifyIndexesPayload {
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub drop: Vec<String>,
    #[serde(default)]
    pub create: Vec<IndexSpecPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpecPayload {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<IndexColumnPayload>,
    #[serde(default)]
    pub unique: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumnPayload {
    pub name: String,
    /// Per-field key value, Compass-style. Accepts `"asc"`, `"desc"`,
    /// `"text"`, `"2dsphere"`, `"2d"`, `"hashed"`, `"wildcard"`
    /// (case-insensitive). Optional — defaults to ascending.
    #[serde(default)]
    pub direction: Option<String>,
}

#[tauri::command]
pub async fn db_modify_indexes(
    app: AppHandle,
    connection_id: String,
    request: ModifyIndexesPayload,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let req = ModifyIndexesRequest {
            schema: request.schema.clone(),
            table: request.table.clone(),
            drop: request.drop.clone(),
            create: request
                .create
                .iter()
                .map(|s| IndexSpec {
                    name: s.name.clone(),
                    unique: s.unique,
                    columns: s
                        .columns
                        .iter()
                        .map(|c| IndexColumn {
                            name: c.name.clone(),
                            direction: c.direction.as_deref().map(|d| {
                                match d.to_ascii_lowercase().as_str() {
                                    "desc" => IndexKeyValue::Desc,
                                    "text" => IndexKeyValue::Text,
                                    "2dsphere" => IndexKeyValue::TwoDSphere,
                                    "2d" => IndexKeyValue::TwoD,
                                    "hashed" => IndexKeyValue::Hashed,
                                    "wildcard" => IndexKeyValue::Wildcard,
                                    _ => IndexKeyValue::Asc,
                                }
                            }),
                        })
                        .collect(),
                })
                .collect(),
        };
        async move { a.modify_indexes(req).await }
    })
    .await
}

/// Wire shape for `db_delete_rows`. Matches `MutateRequest::Delete`.
/// The frontend batches multiple rows client-side; each translates to one
/// call here so adapters that don't support bulk delete still work.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsRequest {
    pub schema: String,
    pub table: String,
    pub primary_key: Vec<PrimaryKeyValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRowsResult {
    pub rows_affected: u64,
}

#[tauri::command]
pub async fn db_delete_rows(
    app: AppHandle,
    connection_id: String,
    request: DeleteRowsRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<DeleteRowsResult, AdapterError> {
    let mutation = with_retry(&app, &registry, &factories, &connection_id, |a| {
        let req = MutateRequest::Delete {
            schema: request.schema.clone(),
            table: request.table.clone(),
            primary_key: request.primary_key.clone(),
        };
        async move { a.mutate(req).await }
    })
    .await?;
    Ok(DeleteRowsResult {
        rows_affected: mutation.records_affected,
    })
}

#[tauri::command]
pub async fn db_list_views(
    app: AppHandle,
    connection_id: String,
    schema: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<ViewInfo>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        async move { a.list_views(&schema).await }
    })
    .await
}

#[tauri::command]
pub async fn db_list_routines(
    app: AppHandle,
    connection_id: String,
    schema: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<RoutineInfo>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        async move { a.list_routines(&schema).await }
    })
    .await
}

#[tauri::command]
pub async fn db_describe_routine(
    app: AppHandle,
    connection_id: String,
    schema: String,
    name: String,
    kind: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<RoutineDefinition, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        let name = name.clone();
        let kind = kind.clone();
        async move { a.describe_routine(&schema, &name, &kind).await }
    })
    .await
}

#[tauri::command]
pub async fn db_create_database(
    app: AppHandle,
    connection_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let name = name.clone();
        let charset = charset.clone();
        let collation = collation.clone();
        async move {
            a.create_schema(&name, charset.as_deref(), collation.as_deref())
                .await
        }
    })
    .await
}

/// Encodings the live server offers for new databases. Empty list
/// means the adapter doesn't model per-database encoding (SQLite,
/// Mongo, Redis); the dialog uses that to hide the row.
#[tauri::command]
pub async fn db_list_charsets(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<String>, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.list_charsets().await },
    )
    .await
}

/// Collations available for `charset`. Returned in dialog order:
/// the server's default for the charset comes first, followed by the
/// rest alphabetised.
#[tauri::command]
pub async fn db_list_collations(
    app: AppHandle,
    connection_id: String,
    charset: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<String>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let charset = charset.clone();
        async move { a.list_collations(&charset).await }
    })
    .await
}

/// Every adapter the host knows about. Drives the connection modal's
/// adapter picker + field list.
#[tauri::command]
pub async fn db_list_adapters(
    factories: State<'_, Arc<FactoryRegistry>>,
) -> Result<Vec<&'static adapter_api::AdapterManifest>, AdapterError> {
    Ok(factories.manifests())
}

/// Paginated + filtered + sorted rows from one table. Identifiers are
/// backtick-quoted and values are parameter-bound inside the adapter.
#[tauri::command]
pub async fn db_browse(
    app: AppHandle,
    connection_id: String,
    request: BrowseRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<BrowseResult, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let req = BrowseRequest {
            schema: request.schema.clone(),
            table: request.table.clone(),
            filters: request.filters.clone(),
            sort: request.sort.clone(),
            page: Page {
                number: request.page.number,
                size: request.page.size,
            },
            include_total: request.include_total,
        };
        async move { a.browse(req).await }
    })
    .await
}

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
