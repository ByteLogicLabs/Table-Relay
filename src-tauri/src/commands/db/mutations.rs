//! Write-path commands: insert / update / delete rows and index modification.
//! Each host-side request shape is translated into the adapter's
//! `MutateRequest` / `ModifyIndexesRequest`.

use std::sync::Arc;

use adapter_api::{
    AdapterError, IndexColumn, IndexKeyValue, IndexSpec, ModifyIndexesRequest, MutateRequest,
    PrimaryKeyValue,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, State};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::with_retry;
use crate::db::registry::Registry;

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
