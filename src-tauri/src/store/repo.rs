//! Plain CRUD over the connection store. Plaintext passwords by design.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::StoreError;

/// Full profile with secrets. Returned to the UI as-is (no more
/// "public view" split, since nothing is encrypted here).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: Option<String>,
    pub ssh_enabled: bool,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_auth_kind: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_key_passphrase: Option<String>,
    pub color: Option<String>,
    pub is_favorite: bool,
    pub tag: Option<String>,
    pub tag_color: Option<String>,
    /// JSON array of { name, color } — multiple tags per connection. The legacy
    /// `tag`/`tag_color` are kept for back-compat (and migrated into this).
    pub tags: Option<String>,
}

impl ConnectionProfile {
    /// Adapter-facing view of this profile. The host's `ConnectionProfile`
    /// carries rows-of-record data (id, name, color, favorite); the
    /// adapter only needs connection fields.
    ///
    /// `adapter_id` is resolved by the caller via `FactoryRegistry::resolve`
    /// — we no longer hardcode a driver→id mapping here, so adding a new
    /// adapter is a single-file change (its manifest) instead of an edit
    /// in this translator too.
    pub fn to_adapter_profile(&self, adapter_id: &str) -> adapter_api::ConnectionProfile {
        adapter_api::ConnectionProfile {
            adapter_id: adapter_id.to_string(),
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            password: self.password.clone(),
            database: self.database.clone(),
            ssl_mode: self.ssl_mode.clone(),
            ssh_enabled: self.ssh_enabled,
            ssh_host: self.ssh_host.clone(),
            ssh_port: self.ssh_port,
            ssh_user: self.ssh_user.clone(),
            ssh_auth_kind: self.ssh_auth_kind.clone(),
            ssh_password: self.ssh_password.clone(),
            ssh_key_path: self.ssh_key_path.clone(),
            ssh_key_passphrase: self.ssh_key_passphrase.clone(),
            extras: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    #[serde(default)]
    pub ssh_auth_kind: Option<String>,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_key_passphrase: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub tag_color: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
}

pub fn list_connections(conn: &Connection) -> Result<Vec<ConnectionProfile>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, driver, host, port, user, password, database, ssl_mode,
                ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path,
                ssh_password, ssh_key_passphrase, color, is_favorite, tag, tag_color, tags
         FROM connections ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ConnectionProfile {
            id: r.get(0)?,
            name: r.get(1)?,
            driver: r.get(2)?,
            host: r.get(3)?,
            port: r.get::<_, i64>(4)? as u16,
            user: r.get(5)?,
            password: r.get(6)?,
            database: r.get(7)?,
            ssl_mode: r.get(8)?,
            ssh_enabled: r.get::<_, i64>(9)? != 0,
            ssh_host: r.get(10)?,
            ssh_port: r.get::<_, Option<i64>>(11)?.map(|p| p as u16),
            ssh_user: r.get(12)?,
            ssh_auth_kind: r.get(13)?,
            ssh_key_path: r.get(14)?,
            ssh_password: r.get(15)?,
            ssh_key_passphrase: r.get(16)?,
            color: r.get(17)?,
            is_favorite: r.get::<_, i64>(18)? != 0,
            tag: r.get(19)?,
            tag_color: r.get(20)?,
            tags: r.get(21)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_connection(conn: &Connection, id: &str) -> Result<ConnectionProfile, StoreError> {
    let list = list_connections(conn)?;
    list.into_iter()
        .find(|c| c.id == id)
        .ok_or(StoreError::NotFound)
}

pub fn save_connection(
    conn: &mut Connection,
    input: ConnectionProfileInput,
) -> Result<ConnectionProfile, StoreError> {
    let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = Utc::now().timestamp();

    conn.execute(
        "INSERT INTO connections (id, name, driver, host, port, user, password, database, ssl_mode,
                                  ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_auth_kind, ssh_key_path,
                                  ssh_password, ssh_key_passphrase, color, is_favorite, tag, tag_color, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?21, ?22, ?23, ?20, ?20)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            driver = excluded.driver,
            host = excluded.host,
            port = excluded.port,
            user = excluded.user,
            password = excluded.password,
            database = excluded.database,
            ssl_mode = excluded.ssl_mode,
            ssh_enabled = excluded.ssh_enabled,
            ssh_host = excluded.ssh_host,
            ssh_port = excluded.ssh_port,
            ssh_user = excluded.ssh_user,
            ssh_auth_kind = excluded.ssh_auth_kind,
            ssh_key_path = excluded.ssh_key_path,
            ssh_password = excluded.ssh_password,
            ssh_key_passphrase = excluded.ssh_key_passphrase,
            color = excluded.color,
            is_favorite = excluded.is_favorite,
            tag = excluded.tag,
            tag_color = excluded.tag_color,
            tags = excluded.tags,
            updated_at = excluded.updated_at",
        params![
            id,
            input.name,
            input.driver,
            input.host,
            input.port as i64,
            input.user,
            input.password,
            input.database,
            input.ssl_mode,
            if input.ssh_enabled { 1 } else { 0 },
            input.ssh_host,
            input.ssh_port.map(|p| p as i64),
            input.ssh_user,
            input.ssh_auth_kind,
            input.ssh_key_path,
            input.ssh_password,
            input.ssh_key_passphrase,
            input.color,
            if input.is_favorite { 1 } else { 0 },
            now,
            input.tag,
            input.tag_color,
            input.tags,
        ],
    )?;
    get_connection(conn, &id)
}

pub fn delete_connection(conn: &mut Connection, id: &str) -> Result<(), StoreError> {
    let rows = conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    if rows == 0 {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// Utility kept for the db_connect command — looks up a profile by id.
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<ConnectionProfile>, StoreError> {
    list_connections(conn).map(|list| list.into_iter().find(|c| c.id == id))
}

#[allow(dead_code)]
pub fn any_row_exists(conn: &Connection) -> Result<bool, StoreError> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM connections", [], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    Ok(count > 0)
}
