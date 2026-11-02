use std::sync::Arc;

use tauri::State;

use crate::store::{SecurityStatus, Store, StoreError};

type SResult<T> = Result<T, StoreError>;

#[tauri::command]
pub fn security_status(store: State<'_, Arc<Store>>) -> SResult<SecurityStatus> {
    Ok(store.status())
}

#[tauri::command]
pub fn security_remove_backup(store: State<'_, Arc<Store>>) -> SResult<SecurityStatus> {
    store.remove_plaintext_backup()
}
