//! Built-in zero-dependency provider. Streams a canned assistant reply that
//! echoes the last user message. Used to exercise the chat pipeline (Start /
//! stream / End) while hosted + local providers are still being built, and
//! as a regression target going forward — if Echo is broken, something in
//! the plumbing is broken, not the provider.

use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use futures::StreamExt;
use std::time::Duration;

use super::{
    AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, FinishReason, ProviderKind,
    TokenChunk,
};

pub struct EchoProvider;

impl EchoProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AiProvider for EchoProvider {
    fn name(&self) -> String {
        "Echo (offline test)".to_string()
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Echo
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        let last_user = req
            .messages
            .iter()
            .rev()
            .find(|m: &&ChatMessage| m.role == ChatRole::User)
            .map(|m| m.content.clone())
            .unwrap_or_default();

        let reply = if last_user.is_empty() {
            "Hi — the AI chat pipeline is wired up. Replace the Echo provider with OpenAI / Anthropic / local Llama under the provider picker once those milestones land.".to_string()
        } else {
            format!(
                "Echo provider (offline). You said:\n\n> {}\n\nWhen M8.1/M8.2 land, this reply will come from your chosen model.",
                last_user.trim()
            )
        };

        // Split on whitespace but keep the separators so the streamed text
        // reads naturally rather than collapsing runs of spaces/newlines.
        let mut chunks: Vec<String> = Vec::new();
        let mut current = String::new();
        for ch in reply.chars() {
            current.push(ch);
            if ch.is_whitespace() {
                chunks.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            chunks.push(current);
        }

        let total = chunks.len();
        let request_id = req.request_id.clone();

        let stream = stream::iter(chunks.into_iter().enumerate()).then(move |(i, chunk)| {
            let rid = request_id.clone();
            async move {
                // Small delay gives the UI a visible "streaming" effect.
                tokio::time::sleep(Duration::from_millis(18)).await;
                TokenChunk {
                    request_id: rid,
                    delta: chunk,
                    finish_reason: if i + 1 == total {
                        Some(FinishReason::Stop)
                    } else {
                        None
                    },
                }
            }
        });

        Ok(stream.boxed())
    }

    async fn cancel(&self, _request_id: &str) {
        // No long-running work to interrupt; the stream finishes on its own.
    }

    async fn unload(&self) {
        // Stateless.
    }
}
