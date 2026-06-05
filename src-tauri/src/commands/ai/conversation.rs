//! Tool-approval commands plus the conversation-persistence commands backed by
//! the `repo_ai_conv` store repository.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::ai::AiError;

// Approval command — the UI calls this with approve/deny after showing the
// user the SQL that `call_query` wants to execute.
#[derive(Debug, Deserialize)]
pub struct ApprovalInput {
    pub tool_call_id: String,
    pub decision: crate::ai::tools::ApprovalDecision,
}

#[tauri::command]
pub async fn ai_approve_tool_call(
    input: ApprovalInput,
    approvals: State<'_, Arc<crate::ai::tools::ApprovalRegistry>>,
) -> Result<(), AiError> {
    let ok = approvals.resolve(&input.tool_call_id, input.decision).await;
    if !ok {
        return Err(AiError::Other(format!(
            "no pending tool call with id {}",
            input.tool_call_id
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_get_auto_approvals(
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<crate::ai::tools::AutoApprovalFlags, AiError> {
    Ok(auto_approvals.get().await)
}

#[tauri::command]
pub async fn ai_set_auto_approvals(
    flags: crate::ai::tools::AutoApprovalFlags,
    auto_approvals: State<'_, Arc<crate::ai::tools::AutoApprovals>>,
) -> Result<(), AiError> {
    auto_approvals.set(flags).await;
    Ok(())
}

// ---- Conversation persistence ----

use crate::store::repo_ai_conv as conv_repo;

#[tauri::command]
pub async fn ai_conversation_list(
    store: State<'_, Arc<crate::store::Store>>,
    limit: Option<i64>,
) -> Result<Vec<conv_repo::Conversation>, AiError> {
    store
        .with_conn(false, |db| conv_repo::list(db, limit))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_get(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
) -> Result<Option<conv_repo::Conversation>, AiError> {
    store
        .with_conn(false, |db| conv_repo::get(db, &id))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_create(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
    connection_id: Option<String>,
    provider_kind: Option<String>,
    model: Option<String>,
) -> Result<conv_repo::Conversation, AiError> {
    store
        .with_conn(true, |db| {
            conv_repo::create(
                db,
                conv_repo::CreateConversationInput {
                    id,
                    connection_id,
                    provider_kind,
                    model,
                },
            )
        })
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_delete(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::delete(db, &id))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_update_title(
    store: State<'_, Arc<crate::store::Store>>,
    id: String,
    title: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::update_title(db, &id, &title))
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_save_message(
    store: State<'_, Arc<crate::store::Store>>,
    conversation_id: String,
    msg_id: String,
    role: String,
    content: String,
    tool_calls_json: Option<String>,
    tool_call_id: Option<String>,
    kind: Option<String>,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| {
            conv_repo::add_message(
                db,
                &conversation_id,
                &msg_id,
                &role,
                &content,
                tool_calls_json.as_deref(),
                tool_call_id.as_deref(),
                kind.as_deref(),
            )
        })
        .map_err(|e| AiError::Other(e.to_string()))
}

#[tauri::command]
pub async fn ai_conversation_clear_messages(
    store: State<'_, Arc<crate::store::Store>>,
    conversation_id: String,
) -> Result<(), AiError> {
    store
        .with_conn(true, |db| conv_repo::clear_messages(db, &conversation_id))
        .map_err(|e| AiError::Other(e.to_string()))
}
