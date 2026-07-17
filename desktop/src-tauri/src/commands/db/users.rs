//! Database user / role administration: probe the current account's
//! privileges, list users, inspect grants, and create / alter / drop users.
//! Every command dispatches through the adapter registry via `with_retry`,
//! matching the process-list surface in `realtime.rs`.

use std::sync::Arc;

use adapter_api::{
    AdapterError, AlterUserRequest, CreateUserRequest, GrantInfo, GrantRequest,
    ManageUsersCapability, UserInfo, UserRef,
};
use tauri::{AppHandle, State};

use crate::db::adapter_registry::FactoryRegistry;
use crate::db::reconnect::with_retry;
use crate::db::registry::Registry;

/// Probe whether the current account may manage users on this connection.
/// Drives both the enabled state of the create/alter/drop controls and the
/// explanatory message shown when the account is under-privileged.
#[tauri::command]
pub async fn db_can_manage_users(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<ManageUsersCapability, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.can_manage_users().await },
    )
    .await
}

#[tauri::command]
pub async fn db_list_users(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<Vec<UserInfo>, AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.list_users().await },
    )
    .await
}

#[tauri::command]
pub async fn db_list_grants(
    app: AppHandle,
    connection_id: String,
    user: UserRef,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<GrantInfo, AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let user = user.clone();
        async move { a.list_grants(&user).await }
    })
    .await
}

#[tauri::command]
pub async fn db_create_user(
    app: AppHandle,
    connection_id: String,
    request: CreateUserRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let request = request.clone();
        async move { a.create_user(request).await }
    })
    .await
}

#[tauri::command]
pub async fn db_alter_user(
    app: AppHandle,
    connection_id: String,
    request: AlterUserRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let request = request.clone();
        async move { a.alter_user(request).await }
    })
    .await
}

#[tauri::command]
pub async fn db_drop_user(
    app: AppHandle,
    connection_id: String,
    user: UserRef,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let user = user.clone();
        async move { a.drop_user(&user).await }
    })
    .await
}

#[tauri::command]
pub async fn db_grant_privileges(
    app: AppHandle,
    connection_id: String,
    request: GrantRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let request = request.clone();
        async move { a.grant_privileges(request).await }
    })
    .await
}

#[tauri::command]
pub async fn db_revoke_privileges(
    app: AppHandle,
    connection_id: String,
    request: GrantRequest,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(&app, &registry, &factories, &connection_id, |a| {
        let request = request.clone();
        async move { a.revoke_privileges(request).await }
    })
    .await
}

#[tauri::command]
pub async fn db_flush_privileges(
    app: AppHandle,
    connection_id: String,
    factories: State<'_, Arc<FactoryRegistry>>,
    registry: State<'_, Arc<Registry>>,
) -> Result<(), AdapterError> {
    with_retry(
        &app,
        &registry,
        &factories,
        &connection_id,
        |a| async move { a.flush_privileges().await },
    )
    .await
}
