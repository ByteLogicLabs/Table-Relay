//! Session-scoped AI state. Lives in an `Arc<RwLock<Option<AiSession>>>` on
//! `AppState` — `None` means the feature is inactive and consumes zero
//! resources; `Some(_)` means the user has clicked "Start Chat".

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::RwLock;

use super::{AiError, AiProvider, ChatMessage, ProviderKind};

/// Live state for a single chat session. Created on `ai_start`, destroyed on
/// `ai_end` — no persistence.
#[allow(dead_code)]
pub struct AiSession {
    pub provider: Arc<dyn AiProvider>,
    pub provider_kind: ProviderKind,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub started_at: Instant,
    /// Fingerprint of the last schema-context message we injected — formatted
    /// as `"<connection_id>|<schema>"`. When the user switches tabs the
    /// frontend sends the new fingerprint; if it differs we re-inject a
    /// fresh context message so the model doesn't keep answering against the
    /// old schema.
    pub last_context_key: Option<String>,
    /// Serialises the send pipeline so two `ai_chat_send` calls can't
    /// interleave their commits. Without this, a quick second send
    /// could append a User message between an assistant-with-tool_calls
    /// turn and its Tool replies, corrupting the wire format and
    /// poisoning every subsequent send with HTTP 400 from the provider.
    pub send_lock: Arc<tokio::sync::Mutex<()>>,
}

/// Global slot. App startup installs `Arc::new(RwLock::new(None))`; every
/// `ai_*` command grabs a read/write guard on it.
pub type SessionSlot = Arc<RwLock<Option<AiSession>>>;

/// Returns the active provider or `NoActiveSession`. Cheap — clones an `Arc`.
pub async fn require_provider(slot: &SessionSlot) -> Result<Arc<dyn AiProvider>, AiError> {
    let guard = slot.read().await;
    guard
        .as_ref()
        .map(|s| s.provider.clone())
        .ok_or(AiError::NoActiveSession)
}

/// Install a fresh session. Errors if one is already active so the caller
/// knows to `ai_end` first.
pub async fn install(slot: &SessionSlot, session: AiSession) -> Result<(), AiError> {
    let mut guard = slot.write().await;
    if guard.is_some() {
        return Err(AiError::SessionAlreadyActive);
    }
    *guard = Some(session);
    Ok(())
}

/// Swap the session out and drop the provider asynchronously. Drop order
/// matters: the provider's `unload()` runs (zeroes API keys, frees model
/// memory) while we still hold the `Arc`.
pub async fn end(slot: &SessionSlot) -> Result<(), AiError> {
    // Take the session out of the slot first so other commands see "inactive"
    // while we run the (potentially slow) unload.
    let session = {
        let mut guard = slot.write().await;
        guard.take()
    };
    let Some(session) = session else {
        return Err(AiError::NoActiveSession);
    };
    session.provider.unload().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::echo::EchoProvider;
    use crate::ai::ProviderKind;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn fresh_session() -> AiSession {
        AiSession {
            provider: Arc::new(EchoProvider::new()),
            provider_kind: ProviderKind::Echo,
            model: "echo".into(),
            messages: Vec::new(),
            started_at: Instant::now(),
            last_context_key: None,
            send_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[tokio::test]
    async fn start_then_end_leaves_slot_empty() {
        let slot: SessionSlot = Arc::new(RwLock::new(None));
        install(&slot, fresh_session()).await.unwrap();
        assert!(slot.read().await.is_some());
        end(&slot).await.unwrap();
        assert!(slot.read().await.is_none());
    }

    #[tokio::test]
    async fn double_start_is_a_clean_error() {
        let slot: SessionSlot = Arc::new(RwLock::new(None));
        install(&slot, fresh_session()).await.unwrap();
        match install(&slot, fresh_session()).await {
            Err(AiError::SessionAlreadyActive) => {}
            other => panic!("expected SessionAlreadyActive, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn require_provider_without_session_returns_no_active() {
        let slot: SessionSlot = Arc::new(RwLock::new(None));
        match require_provider(&slot).await {
            Err(AiError::NoActiveSession) => {}
            Err(other) => panic!("expected NoActiveSession, got {other:?}"),
            Ok(_) => panic!("expected error, got provider"),
        }
    }

    #[tokio::test]
    async fn end_without_session_returns_no_active() {
        let slot: SessionSlot = Arc::new(RwLock::new(None));
        match end(&slot).await {
            Err(AiError::NoActiveSession) => {}
            other => panic!("expected NoActiveSession, got {other:?}"),
        }
    }
}
