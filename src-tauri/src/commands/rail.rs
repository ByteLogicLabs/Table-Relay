//! Tauri commands for the connection-rail tiles (pinned server+database pairs).

use std::sync::Arc;

use tauri::State;

use crate::store::repo_rail::{self, RailTile, RailTileInput};
use crate::store::{Store, StoreError};

type SResult<T> = Result<T, StoreError>;

fn with_conn<R>(store: &Store, f: impl FnOnce(&mut rusqlite::Connection) -> SResult<R>) -> SResult<R> {
    let mut guard = store.db.lock().expect("store db mutex poisoned");
    f(&mut guard)
}

#[tauri::command]
pub fn rail_list(store: State<'_, Arc<Store>>) -> SResult<Vec<RailTile>> {
    with_conn(&store, |c| repo_rail::list_all(c))
}

#[tauri::command]
pub fn rail_pin(store: State<'_, Arc<Store>>, input: RailTileInput) -> SResult<RailTile> {
    with_conn(&store, |c| repo_rail::pin(c, input))
}

#[tauri::command]
pub fn rail_unpin(store: State<'_, Arc<Store>>, id: String) -> SResult<()> {
    with_conn(&store, |c| repo_rail::unpin(c, &id))
}

#[tauri::command]
pub fn rail_rename(
    store: State<'_, Arc<Store>>,
    id: String,
    label: Option<String>,
) -> SResult<RailTile> {
    with_conn(&store, |c| repo_rail::rename(c, &id, label.as_deref()))
}

#[tauri::command]
pub fn rail_reorder(store: State<'_, Arc<Store>>, ordered_ids: Vec<String>) -> SResult<()> {
    with_conn(&store, |c| repo_rail::reorder(c, &ordered_ids))
}
