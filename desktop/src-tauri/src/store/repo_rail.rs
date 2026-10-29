//! CRUD over rail_tiles (one row per pinned (server, database) pair).

use chrono::Utc;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::StoreError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailTile {
    pub id: String,
    pub server_id: String,
    pub database_name: String,
    pub label: Option<String>,
    pub order_index: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailTileInput {
    pub server_id: String,
    pub database_name: String,
    #[serde(default)]
    pub label: Option<String>,
}

pub fn list_all(conn: &Connection) -> Result<Vec<RailTile>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, server_id, schema_name, label, order_index, created_at, updated_at
         FROM rail_tiles
         ORDER BY order_index, created_at",
    )?;
    let rows = stmt.query_map([], row_to_tile)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn pin(conn: &mut Connection, input: RailTileInput) -> Result<RailTile, StoreError> {
    // Idempotent on (server, database): re-pinning returns the existing row.
    if let Ok(existing) = conn.query_row(
        "SELECT id, server_id, schema_name, label, order_index, created_at, updated_at
         FROM rail_tiles WHERE server_id = ?1 AND schema_name = ?2",
        params![input.server_id, input.database_name],
        row_to_tile,
    ) {
        return Ok(existing);
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(order_index) + 1, 0) FROM rail_tiles",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO rail_tiles
           (id, server_id, schema_name, object_name, object_kind, label,
            order_index, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3, 'database', ?4, ?5, ?6, ?6)",
        params![
            id,
            input.server_id,
            input.database_name,
            input.label,
            next_order,
            now,
        ],
    )?;
    get_by_id(conn, &id)
}

pub fn unpin(conn: &mut Connection, id: &str) -> Result<(), StoreError> {
    let rows = conn.execute("DELETE FROM rail_tiles WHERE id = ?1", params![id])?;
    if rows == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

pub fn rename(conn: &mut Connection, id: &str, label: Option<&str>) -> Result<RailTile, StoreError> {
    let now = Utc::now().timestamp();
    let rows = conn.execute(
        "UPDATE rail_tiles SET label = ?1, updated_at = ?2 WHERE id = ?3",
        params![label, now, id],
    )?;
    if rows == 0 {
        return Err(StoreError::NotFound);
    }
    get_by_id(conn, id)
}

pub fn reorder(conn: &mut Connection, ordered_ids: &[String]) -> Result<(), StoreError> {
    let tx = conn.transaction()?;
    for (idx, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE rail_tiles SET order_index = ?1 WHERE id = ?2",
            params![idx as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn get_by_id(conn: &Connection, id: &str) -> Result<RailTile, StoreError> {
    conn.query_row(
        "SELECT id, server_id, schema_name, label, order_index, created_at, updated_at
         FROM rail_tiles WHERE id = ?1",
        params![id],
        row_to_tile,
    )
    .map_err(|_| StoreError::NotFound)
}

fn row_to_tile(r: &rusqlite::Row<'_>) -> rusqlite::Result<RailTile> {
    Ok(RailTile {
        id: r.get(0)?,
        server_id: r.get(1)?,
        database_name: r.get(2)?,
        label: r.get(3)?,
        order_index: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}
