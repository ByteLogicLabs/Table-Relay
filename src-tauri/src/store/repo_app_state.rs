//! Encrypted app-state key/value persistence.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::StoreError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateEntry {
    pub key: String,
    pub value_json: String,
    pub updated_at: String,
}

pub fn get(conn: &Connection, key: &str) -> Result<Option<AppStateEntry>, StoreError> {
    conn.query_row(
        "SELECT key, value_json, updated_at FROM app_state WHERE key = ?1",
        params![key],
        row_to_entry,
    )
    .optional()
    .map_err(StoreError::Sqlite)
}

pub fn set(conn: &Connection, key: &str, value_json: &str) -> Result<AppStateEntry, StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_state (key, value_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at",
        params![key, value_json, now],
    )?;
    Ok(AppStateEntry {
        key: key.to_string(),
        value_json: value_json.to_string(),
        updated_at: now,
    })
}

pub fn delete(conn: &Connection, key: &str) -> Result<(), StoreError> {
    conn.execute("DELETE FROM app_state WHERE key = ?1", params![key])?;
    Ok(())
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppStateEntry> {
    Ok(AppStateEntry {
        key: row.get(0)?,
        value_json: row.get(1)?,
        updated_at: row.get(2)?,
    })
}
