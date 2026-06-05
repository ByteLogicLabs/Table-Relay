//! Read-path query commands: raw query execution (buffered + streamed) and
//! paginated table browsing.

use std::sync::Arc;

use adapter_api::{AdapterError, BrowseRequest, BrowseResult, Page, QueryResult, StatementResult};
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
