//! AI module — session-scoped. No persistence. See ai-plan.md for the big
//! picture; this file only owns the public surface (trait + error + message
//! types). Provider implementations live in sibling files.

pub mod anthropic;
pub mod context;
pub mod download;
pub mod echo;
pub mod gemini;
pub mod http;
pub mod llama;
pub mod llama_server;
pub mod models_catalog;
pub mod openai;
pub mod session;
pub mod sse;
pub mod tools;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

/// What kind of backend powers a session. The UI uses this tag; Rust uses it
/// to pick the right provider struct on `ai_start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Built-in no-network provider. Round-trips input back as output so the
    /// chat UI is exercisable without a model or API key.
    Echo,
    /// Local llama.cpp model (GGUF weights). Implemented in M8.1.
    LlamaLocal,
    /// OpenAI /v1/chat/completions. Implemented in M8.2.
    Openai,
    /// Anthropic /v1/messages. Implemented in M8.2.
    Anthropic,
    /// Google /v1beta/models/…:streamGenerateContent. Implemented in M8.2.
    Gemini,
    /// OpenAI-compatible backend with user-supplied base_url (Ollama, Groq, …).
    /// Implemented in M8.2.
    OpenaiCompatible,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Echo => "echo",
            ProviderKind::LlamaLocal => "llama_local",
            ProviderKind::Openai => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Gemini => "gemini",
            ProviderKind::OpenaiCompatible => "openai_compatible",
        }
    }
}

/// One turn in the chat history. Rich enough to carry OpenAI-style tool
/// calls + tool responses; other provider types (Anthropic, Gemini) only
/// ever populate `role` + `content`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// Populated when the assistant asks to call one or more tools. Each
    /// entry has a unique `id` used to correlate the eventual Tool reply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Populated on `role: Tool` messages — the id of the assistant tool
    /// call this message is answering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn text(role: ChatRole, content: impl Into<String>) -> Self {
        Self { role, content: content.into(), tool_calls: Vec::new(), tool_call_id: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// An assistant-issued request to invoke a named tool with JSON arguments.
/// Matches the OpenAI `tool_calls[]` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON string as emitted by the model. We don't re-serialize it
    /// because some models produce subtly-invalid JSON and we want to keep
    /// the original for debugging.
    pub arguments: String,
}

/// Completion request shape used by every provider. Prompt assembly happens
/// one level up (session / chat command), so the provider only needs the
/// finished message list.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct CompletionRequest {
    pub request_id: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub stop: Option<Vec<String>>,
}

/// One streamed chunk. `delta` is the incremental text to append. `finish_reason`
/// is set on the final chunk only.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TokenChunk {
    pub request_id: String,
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<FinishReason>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum FinishReason {
    Stop,
    Length,
    Canceled,
    Error,
}

/// Unified error surface for the AI layer. Serializes as `{kind, message}`
/// the same way DbError does, so the frontend can discriminate on `kind`.
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[allow(dead_code)]
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[allow(dead_code)]
    #[error("rate limit: {0}")]
    RateLimit(String),
    #[allow(dead_code)]
    #[error("network timeout")]
    NetworkTimeout,
    #[allow(dead_code)]
    #[error("model not loaded")]
    ModelNotLoaded,
    #[error("invalid model: {0}")]
    InvalidModel(String),
    #[allow(dead_code)]
    #[error("context too long")]
    ContextTooLong,
    #[allow(dead_code)]
    #[error("canceled")]
    Canceled,
    #[error("no active AI session")]
    NoActiveSession,
    #[error("session already active")]
    SessionAlreadyActive,
    #[allow(dead_code)]
    #[error("upstream: {0}")]
    Upstream(String),
    #[allow(dead_code)]
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct W<'a> {
            kind: &'a str,
            message: String,
        }
        let kind = match self {
            AiError::Unauthorized(_) => "Unauthorized",
            AiError::RateLimit(_) => "RateLimit",
            AiError::NetworkTimeout => "NetworkTimeout",
            AiError::ModelNotLoaded => "ModelNotLoaded",
            AiError::InvalidModel(_) => "InvalidModel",
            AiError::ContextTooLong => "ContextTooLong",
            AiError::Canceled => "Canceled",
            AiError::NoActiveSession => "NoActiveSession",
            AiError::SessionAlreadyActive => "SessionAlreadyActive",
            AiError::Upstream(_) => "Upstream",
            AiError::Other(_) => "Other",
        };
        W { kind, message: self.to_string() }.serialize(s)
    }
}

/// Trait every provider implements. `Send + Sync` so we can park one behind
/// an `Arc` and stream tokens across tasks.
#[async_trait]
#[allow(dead_code)]
pub trait AiProvider: Send + Sync {
    /// Display name (e.g. "OpenAI gpt-4o-mini"). Shown in the chat header.
    fn name(&self) -> String;

    fn kind(&self) -> ProviderKind;

    /// Run a completion and return a stream of token chunks. The final chunk
    /// MUST have `finish_reason: Some(_)`. Errors before the first chunk
    /// surface as an `Err` on this call; mid-stream failures surface as a
    /// final chunk with `finish_reason: Some(Error)`.
    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError>;

    /// Best-effort cancel for an in-flight request.
    async fn cancel(&self, request_id: &str);

    /// Drop model weights / zero API keys. No-op for stateless hosted providers.
    async fn unload(&self);

    /// One non-streaming round-trip with optional tool definitions. Used by
    /// the tool-use loop. Providers that don't implement OpenAI-style tool
    /// calls (Anthropic, Gemini, Echo) return `Unsupported` — the command
    /// layer falls back to streaming `complete()` in that case.
    async fn complete_once(
        &self,
        _history: &[ChatMessage],
        _tools: Option<&[tools::ToolDef]>,
    ) -> Result<openai::ToolTurn, AiError> {
        Err(AiError::InvalidModel(
            "this provider doesn't support tool use".into(),
        ))
    }

    /// Does this provider support OpenAI-style tool calls? Checked before
    /// we even build the tools list.
    fn supports_tools(&self) -> bool {
        false
    }
}
