//! CRUD over ai_conversations and ai_messages.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::StoreError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub connection_id: Option<String>,
    pub provider_kind: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<ConversationMessage>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub tool_calls_json: Option<String>,
    pub tool_call_id: Option<String>,
    pub kind: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationInput {
    pub id: String,
    pub connection_id: Option<String>,
    pub provider_kind: Option<String>,
    pub model: Option<String>,
}

pub fn create(conn: &Connection, input: CreateConversationInput) -> Result<Conversation, StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_conversations (id, title, connection_id, provider_kind, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![input.id, "New Chat", input.connection_id, input.provider_kind, input.model, now, now],
    )?;
    Ok(Conversation {
        id: input.id,
        title: "New Chat".into(),
        connection_id: input.connection_id,
        provider_kind: input.provider_kind,
        model: input.model,
        created_at: now.clone(),
        updated_at: now,
        messages: Some(Vec::new()),
    })
}

pub fn list(conn: &Connection, limit: Option<i64>) -> Result<Vec<Conversation>, StoreError> {
    let limit = limit.unwrap_or(50);
    let mut stmt = conn.prepare(
        "SELECT id, title, connection_id, provider_kind, model, created_at, updated_at
         FROM ai_conversations
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], row_to_conversation)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Conversation>, StoreError> {
    let conv = conn
        .query_row(
            "SELECT id, title, connection_id, provider_kind, model, created_at, updated_at
             FROM ai_conversations WHERE id = ?1",
            params![id],
            row_to_conversation,
        )
        .optional()
        .map_err(StoreError::Sqlite)?;

    if let Some(mut c) = conv {
        c.messages = Some(get_messages(conn, id)?);
        Ok(Some(c))
    } else {
        Ok(None)
    }
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), StoreError> {
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Delete every conversation (and its messages). Messages are removed
/// explicitly rather than relying on `ON DELETE CASCADE`, since SQLite only
/// enforces FKs when `PRAGMA foreign_keys = ON`.
pub fn delete_all(conn: &Connection) -> Result<(), StoreError> {
    conn.execute("DELETE FROM ai_messages", [])?;
    conn.execute("DELETE FROM ai_conversations", [])?;
    Ok(())
}

pub fn update_title(conn: &Connection, id: &str, title: &str) -> Result<(), StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE ai_conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now, id],
    )?;
    Ok(())
}

/// Update the provider/model a conversation is bound to. Called when the user
/// swaps model/provider mid-conversation so reopening it later resumes with the
/// last-used model, not the one it was created with.
pub fn update_provider_model(
    conn: &Connection,
    id: &str,
    provider_kind: Option<&str>,
    model: Option<&str>,
) -> Result<(), StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE ai_conversations SET provider_kind = ?1, model = ?2, updated_at = ?3 WHERE id = ?4",
        params![provider_kind, model, now, id],
    )?;
    Ok(())
}

pub fn touch(conn: &Connection, id: &str) -> Result<(), StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE ai_conversations SET updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn add_message(
    conn: &Connection,
    conversation_id: &str,
    msg_id: &str,
    role: &str,
    content: &str,
    tool_calls_json: Option<&str>,
    tool_call_id: Option<&str>,
    kind: Option<&str>,
) -> Result<(), StoreError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, kind, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![msg_id, conversation_id, role, content, tool_calls_json, tool_call_id, kind, now],
    )?;
    touch(conn, conversation_id)?;
    Ok(())
}

pub fn get_messages(conn: &Connection, conversation_id: &str) -> Result<Vec<ConversationMessage>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, tool_calls_json, tool_call_id, kind, created_at
         FROM ai_messages
         WHERE conversation_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![conversation_id], row_to_message)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn clear_messages(conn: &Connection, conversation_id: &str) -> Result<(), StoreError> {
    conn.execute("DELETE FROM ai_messages WHERE conversation_id = ?1", params![conversation_id])?;
    touch(conn, conversation_id)?;
    Ok(())
}

fn row_to_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        connection_id: row.get(2)?,
        provider_kind: row.get(3)?,
        model: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        messages: None,
    })
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        id: row.get(0)?,
        role: row.get(1)?,
        content: row.get(2)?,
        tool_calls_json: row.get(3)?,
        tool_call_id: row.get(4)?,
        kind: row.get(5)?,
        created_at: row.get(6)?,
    })
}
