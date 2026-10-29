//! Tauri commands fronting the plain connection store.
//!
//! Replaces the M0 `vault_*` commands after encryption was removed. Names kept
//! similar (`connections_*`) so re-adding a vault later is a rename-plus-wrap
//! rather than a call-site rewrite.

use std::sync::Arc;

use tauri::State;

use crate::store::repo::{self, ConnectionProfile, ConnectionProfileInput};
use crate::store::repo_app_state::{self, AppStateEntry};
use crate::store::repo_ai::{self, AiSettings, AiSettingsInput};
use crate::store::{Store, StoreError};

type SResult<T> = Result<T, StoreError>;

fn with_conn<R>(
    store: &Store,
    f: impl FnOnce(&mut rusqlite::Connection) -> SResult<R>,
) -> SResult<R> {
    store.with_conn(false, f)
}

fn with_conn_persist<R>(
    store: &Store,
    f: impl FnOnce(&mut rusqlite::Connection) -> SResult<R>,
) -> SResult<R> {
    store.with_conn(true, f)
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
    with_conn_persist(&store, |c| repo::save_connection(c, profile))
}

#[tauri::command]
pub fn connections_delete(store: State<'_, Arc<Store>>, id: String) -> SResult<()> {
    with_conn_persist(&store, |c| repo::delete_connection(c, &id))
}

// -----------------------------------------------------------------------------
// App state — small encrypted JSON values for UI preferences/layout.
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn app_state_get(
    store: State<'_, Arc<Store>>,
    key: String,
) -> SResult<Option<AppStateEntry>> {
    with_conn(&store, |c| repo_app_state::get(c, &key))
}

#[tauri::command]
pub fn app_state_set(
    store: State<'_, Arc<Store>>,
    key: String,
    value_json: String,
) -> SResult<AppStateEntry> {
    with_conn_persist(&store, |c| repo_app_state::set(c, &key, &value_json))
}

#[tauri::command]
pub fn app_state_delete(store: State<'_, Arc<Store>>, key: String) -> SResult<()> {
    with_conn_persist(&store, |c| repo_app_state::delete(c, &key))
}

// -----------------------------------------------------------------------------
// AI settings — per-provider credentials + preferences.
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
pub fn ai_settings_save(
    store: State<'_, Arc<Store>>,
    input: AiSettingsInput,
) -> SResult<AiSettings> {
    with_conn_persist(&store, |c| repo_ai::upsert(c, input))
}

#[tauri::command]
pub fn ai_settings_forget(store: State<'_, Arc<Store>>, kind: String) -> SResult<()> {
    with_conn_persist(&store, |c| repo_ai::delete(c, &kind))
}
