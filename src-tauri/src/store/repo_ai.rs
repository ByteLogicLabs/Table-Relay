//! CRUD over ai_settings. One row per provider kind; plaintext credentials
//! by design (encryption is deferred — see store/mod.rs).
//!
//! `options_json` is a free-form JSON blob so the frontend can stash
//! arbitrary per-provider preferences (temperature, max_tokens, custom
//! headers, whatever) without schema churn every time a new knob gets
//! added to the StartScreen form.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::StoreError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// Provider kind, e.g. "openai" / "anthropic" / "gemini" /
    /// "openai_compatible" / "llama_local".
    pub kind: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// JSON-encoded arbitrary options. Round-tripped as a string so we
    /// never have to re-parse it on the Rust side.
    pub options_json: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub kind: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub options_json: Option<String>,
}

/// Return every saved provider's credentials. Used by the StartScreen to
/// know at a glance which providers have something saved.
pub fn list(conn: &Connection) -> Result<Vec<AiSettings>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT kind, api_key, base_url, model, options_json, updated_at
         FROM ai_settings",
    )?;
    let rows = stmt.query_map([], row_to_settings)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, kind: &str) -> Result<Option<AiSettings>, StoreError> {
    conn.query_row(
        "SELECT kind, api_key, base_url, model, options_json, updated_at
         FROM ai_settings WHERE kind = ?1",
        params![kind],
        row_to_settings,
    )
    .optional()
    .map_err(StoreError::Sqlite)
}

/// Upsert — `kind` is the primary key, so repeated saves overwrite. We only
/// persist non-empty fields; an empty string from the UI is stored as NULL
/// so a subsequent `get` returns None instead of a blank.
pub fn upsert(conn: &Connection, input: AiSettingsInput) -> Result<AiSettings, StoreError> {
    let now = Utc::now().to_rfc3339();
    let api_key = input.api_key.filter(|s| !s.is_empty());
    let base_url = input.base_url.filter(|s| !s.is_empty());
    let model = input.model.filter(|s| !s.is_empty());
    let options_json = input.options_json.filter(|s| !s.is_empty());

    conn.execute(
        "INSERT INTO ai_settings (kind, api_key, base_url, model, options_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(kind) DO UPDATE SET
            api_key = excluded.api_key,
            base_url = excluded.base_url,
            model = excluded.model,
            options_json = excluded.options_json,
            updated_at = excluded.updated_at",
        params![input.kind, api_key, base_url, model, options_json, now],
    )?;

    Ok(AiSettings {
        kind: input.kind,
        api_key,
        base_url,
        model,
        options_json,
        updated_at: now,
    })
}

pub fn delete(conn: &Connection, kind: &str) -> Result<(), StoreError> {
    conn.execute("DELETE FROM ai_settings WHERE kind = ?1", params![kind])?;
    Ok(())
}

fn row_to_settings(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSettings> {
    Ok(AiSettings {
        kind: row.get(0)?,
        api_key: row.get(1)?,
        base_url: row.get(2)?,
        model: row.get(3)?,
        options_json: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
