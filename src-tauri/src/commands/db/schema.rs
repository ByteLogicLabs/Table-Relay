//! Schema / introspection commands: listing schemas & databases, describing
//! tables/schemas/routines, listing views/routines, and database creation
//! metadata (charsets/collations).

use std::sync::Arc;

use adapter_api::{
    AdapterError, ForeignKey, RoutineDefinition, RoutineInfo, SchemaInfo, TableStructure, ViewInfo,
};
use tauri::{AppHandle, State};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::with_retry;
use crate::db::registry::Registry;

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
