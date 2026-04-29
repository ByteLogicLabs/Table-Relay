//! Tauri commands fronting the plain connection store.
//!
//! Replaces the M0 `vault_*` commands after encryption was removed. Names kept
//! similar (`connections_*`) so re-adding a vault later is a rename-plus-wrap
//! rather than a call-site rewrite.

use std::sync::Arc;

use tauri::State;

use crate::store::repo::{self, ConnectionProfile, ConnectionProfileInput};
use crate::store::repo_ai::{self, AiSettings, AiSettingsInput};
use crate::store::{Store, StoreError};

type SResult<T> = Result<T, StoreError>;

fn with_conn<R>(store: &Store, f: impl FnOnce(&mut rusqlite::Connection) -> SResult<R>) -> SResult<R> {
    let mut guard = store.db.lock().expect("store db mutex poisoned");
    f(&mut guard)
}

#[tauri::command]
pub fn connections_list(store: State<'_, Arc<Store>>) -> SResult<Vec<ConnectionProfile>> {
    with_conn(&store, |c| repo::list_connections(c))
}

#[tauri::command]
pub fn connections_save(
    store: State<'_, Arc<Store>>,
    profile: ConnectionProfileInput,
) -> SResult<ConnectionProfile> {
    with_conn(&store, |c| repo::save_connection(c, profile))
}

#[tauri::command]
pub fn connections_delete(store: State<'_, Arc<Store>>, id: String) -> SResult<()> {
    with_conn(&store, |c| repo::delete_connection(c, &id))
}

// -----------------------------------------------------------------------------
// AI settings — per-provider credentials + preferences, plaintext.
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn ai_settings_list(store: State<'_, Arc<Store>>) -> SResult<Vec<AiSettings>> {
    with_conn(&store, |c| repo_ai::list(c))
}

#[tauri::command]
pub fn ai_settings_get(store: State<'_, Arc<Store>>, kind: String) -> SResult<Option<AiSettings>> {
    with_conn(&store, |c| repo_ai::get(c, &kind))
}

#[tauri::command]
pub fn ai_settings_save(store: State<'_, Arc<Store>>, input: AiSettingsInput) -> SResult<AiSettings> {
    with_conn(&store, |c| repo_ai::upsert(c, input))
}

#[tauri::command]
pub fn ai_settings_forget(store: State<'_, Arc<Store>>, kind: String) -> SResult<()> {
    with_conn(&store, |c| repo_ai::delete(c, &kind))
}
