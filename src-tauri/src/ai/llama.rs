//! Local-Llama provider: thin wrapper around a spawned `llama-server` plus
//! an `OpenAiProvider` pointed at it. Keeps the session identity as
//! `ProviderKind::LlamaLocal` for UI purposes while reusing all the
//! streaming / error-mapping / SSE machinery we already wrote for hosted
//! OpenAI-compatible backends.

use async_trait::async_trait;
use futures::stream::BoxStream;
use std::path::PathBuf;
use std::sync::Arc;

use super::llama_server::LlamaServer;
use super::openai::OpenAiProvider;
use super::{AiError, AiProvider, CompletionRequest, ProviderKind, TokenChunk};

pub struct LlamaLocalProvider {
    server: Arc<LlamaServer>,
    inner: OpenAiProvider,
    model_id: String,
}

impl LlamaLocalProvider {
    pub async fn start(model_id: String, model_path: PathBuf) -> Result<Self, AiError> {
        let server = Arc::new(LlamaServer::spawn(&model_path).await?);
        // llama-server ignores the `model` field on requests (it loads one
        // model per process) but we pass it through so logs are accurate.
        let inner = OpenAiProvider::compatible(server.base_url.clone(), String::new(), model_id.clone());
        Ok(Self { server, inner, model_id })
    }
}

#[async_trait]
impl AiProvider for LlamaLocalProvider {
    fn name(&self) -> String {
        format!("llama_local · {}", self.model_id)
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::LlamaLocal
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        self.inner.complete(req).await
    }

    async fn cancel(&self, request_id: &str) {
        self.inner.cancel(request_id).await;
    }

    async fn unload(&self) {
        // Tear down the HTTP-side key buffers first (no-op for the empty
        // key we pass), then shut down the child process. The order
        // doesn't strictly matter — unload is idempotent on both sides.
        self.inner.unload().await;
        self.server.shutdown().await;
    }

    async fn complete_once(
        &self,
        history: &[crate::ai::ChatMessage],
        tools: Option<&[crate::ai::tools::ToolDef]>,
    ) -> Result<super::openai::ToolTurn, AiError> {
        self.inner.complete_once(history, tools).await
    }

    async fn complete_once_stream(
        &self,
        history: &[crate::ai::ChatMessage],
        tools: Option<&[crate::ai::tools::ToolDef]>,
    ) -> Result<
        Option<BoxStream<'static, Result<super::openai::ToolStreamEvent, AiError>>>,
        AiError,
    > {
        // Call the TRAIT method (returns Option); the inherent method of the
        // same name on OpenAiProvider would otherwise shadow it.
        AiProvider::complete_once_stream(&self.inner, history, tools).await
    }

    fn supports_tools(&self) -> bool {
        // llama-server implements the OpenAI tool-call shape — works as long
        // as the model itself was trained for tool use (Qwen 2.5 Coder, etc.).
        true
    }
}
