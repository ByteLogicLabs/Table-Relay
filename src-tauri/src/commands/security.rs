//! App-store lock/unlock commands.

use std::sync::Arc;

use tauri::State;

use crate::store::{SecurityStatus, Store, StoreError};

type SResult<T> = Result<T, StoreError>;

#[tauri::command]
pub fn security_status(store: State<'_, Arc<Store>>) -> SResult<SecurityStatus> {
    Ok(store.status())
}

#[tauri::command]
pub fn security_initialize(
    store: State<'_, Arc<Store>>,
    password: String,
) -> SResult<SecurityStatus> {
    store.initialize(&password)
}

#[tauri::command]
pub fn security_unlock(store: State<'_, Arc<Store>>, password: String) -> SResult<SecurityStatus> {
    store.unlock(&password)
}

#[tauri::command]
pub fn security_lock(store: State<'_, Arc<Store>>) -> SResult<SecurityStatus> {
    store.lock()
}

#[tauri::command]
pub fn security_remove_backup(store: State<'_, Arc<Store>>) -> SResult<SecurityStatus> {
    store.remove_plaintext_backup()
}
