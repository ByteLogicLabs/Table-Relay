//! Read-path query commands: raw query execution (buffered + streamed) and
//! paginated table browsing.

use std::sync::Arc;

use adapter_api::{AdapterError, BrowseRequest, BrowseResult, Page, QueryResult, ServerDetail, StatementResult};
use tauri::{ipc::Channel, AppHandle, State};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::with_retry;
use crate::db::registry::Registry;

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
    tab_id: Option<String>,
) -> Result<QueryResult, AdapterError> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StatementResult>();
    let forwarder = tokio::spawn(async move {
        while let Some(statement) = rx.recv().await {
            if on_statement.send(statement).is_err() {
                break;
            }
        }
    });

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    if let Some(ref tab_id_str) = tab_id {
        registry.register_query(connection_id.clone(), tab_id_str.clone(), cancel_tx).await;
    }

    let query_fut = with_retry(&app, &registry, &factories, &connection_id, |a| {
        let statement = statement.clone();
        let schema = schema.clone();
        let sink = tx.clone();
        async move {
            a.execute_raw_scoped_stream(&statement, row_limit, schema.as_deref(), sink)
                .await
        }
    });

    let result = tokio::select! {
        res = query_fut => res,
        _ = &mut cancel_rx => {
            Err(AdapterError::Other("Query was cancelled by user".to_string()))
        }
    };

    if let Some(ref tab_id_str) = tab_id {
        registry.remove_query(&connection_id, tab_id_str).await;
    }

    drop(tx);
    let _ = forwarder.await;
    result
}

#[tauri::command]
pub async fn db_cancel_query(
    connection_id: String,
    tab_id: String,
    registry: State<'_, Arc<Registry>>,
) -> Result<bool, AdapterError> {
    Ok(registry.cancel_query(&connection_id, &tab_id).await)
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
            columns: request.columns.clone(),
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

/// Live server/database statistics for the connection "Information" dialog
/// (collation, on-disk size, table count, uptime, …). `schema` scopes the
/// database-specific stats to the focused database. Empty for adapters that
/// don't implement it.
#[tauri::command]
pub async fn db_server_details(
    app: AppHandle,
    connection_id: String,
    schema: Option<String>,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<ServerDetail>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        async move { a.server_details(schema.as_deref()).await }
    })
    .await
}

/// Fetch one full record by primary-key value, untruncated. Used by the grid's
/// row-open / JSON-edit view for adapters (Mongo) whose `browse` returns
/// size-capped previews of huge values. Returns `null` if no record matches.
#[tauri::command]
pub async fn db_get_record(
    app: AppHandle,
    connection_id: String,
    schema: String,
    table: String,
    id: serde_json::Value,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Option<serde_json::Value>, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let schema = schema.clone();
        let table = table.clone();
        let id = id.clone();
        async move { a.get_record(&schema, &table, &id).await }
    })
    .await
}
