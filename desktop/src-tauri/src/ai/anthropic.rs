//! Anthropic Messages API provider.
//!
//! Wire format: `POST /v1/messages` with `stream: true`, `x-api-key: {key}`,
//! `anthropic-version: 2023-06-01`. SSE events include `message_start`,
//! `content_block_start`, `content_block_delta` (what we want),
//! `content_block_stop`, `message_delta`, `message_stop`.
//!
//! Each SSE line looks like `data: {"type":"content_block_delta",...}`.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use super::http::{client, map_reqwest, map_status};
use super::sse::data_lines;
use super::{
    AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, FinishReason, ProviderKind,
    TokenChunk,
};

pub struct AnthropicProvider {
    api_key: Arc<Mutex<Zeroizing<String>>>,
    model: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key: Arc::new(Mutex::new(Zeroizing::new(api_key))),
            model,
        }
    }

    /// GET `/v1/models`. Anthropic published this endpoint in late 2024.
    pub async fn list_models(api_key: &str) -> Result<Vec<String>, AiError> {
        #[derive(Deserialize)]
        struct ListResp {
            data: Vec<ListEntry>,
        }
        #[derive(Deserialize)]
        struct ListEntry {
            id: String,
        }
        let res = client()?
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }
        let list: ListResp = res.json().await.map_err(map_reqwest)?;
        let mut ids: Vec<String> = list.data.into_iter().map(|e| e.id).collect();
        ids.sort();
        Ok(ids)
    }

    #[allow(dead_code)] // kept for explicit key validation; not on start path
    pub async fn probe(&self) -> Result<(), AiError> {
        let body = AnthropicRequest {
            model: &self.model,
            max_tokens: 1,
            system: None,
            messages: &[AnthropicMsg { role: "user", content: "ping" }],
            stream: false,
            temperature: None,
            thinking: None,
        };
        let key = self.api_key.lock().await.to_string();
        let res = client()?
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: &'a [AnthropicMsg<'a>],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Thinking>,
}

/// Extended-thinking block. When present, Anthropic spends up to
/// `budget_tokens` reasoning before the answer; `max_tokens` must exceed it and
/// `temperature` must be unset.
#[derive(Serialize)]
struct Thinking {
    #[serde(rename = "type")]
    kind: &'static str,
    budget_tokens: u32,
}

/// Token budget for a given effort, or `None` to disable thinking. Extended
/// thinking exists ONLY on Claude 3.7 Sonnet and the Claude 4 family (opus-4 /
/// sonnet-4) — NOT 3.5/3.0. Sending `thinking` to a model that rejects it is a
/// 400 that kills the whole turn, so the gate is deliberately strict: when in
/// doubt, omit and let the turn run without thinking.
fn supports_thinking(model_lower: &str) -> bool {
    let m = model_lower;
    // Claude 4 family: `claude-opus-4`, `claude-sonnet-4`, `claude-opus-4-1`, …
    let v4 = m.contains("opus-4") || m.contains("sonnet-4");
    // Claude 3.7 Sonnet (first model with extended thinking).
    let v37 = m.contains("3-7-sonnet") || m.contains("3.7-sonnet");
    v4 || v37
}

fn thinking_budget(model: &str, effort: Option<crate::ai::ReasoningEffort>) -> Option<u32> {
    if !supports_thinking(&model.to_ascii_lowercase()) {
        return None;
    }
    match effort {
        Some(crate::ai::ReasoningEffort::High) => Some(12_288),
        Some(crate::ai::ReasoningEffort::Medium) => Some(4_096),
        _ => None,
    }
}

#[derive(Serialize)]
struct AnthropicMsg<'a> {
    role: &'a str,
    content: &'a str,
}

// The Anthropic SSE stream is self-describing — each `data:` line has a
// `type` field we key off. We only care about `content_block_delta` for
// incremental text and `message_delta` for `stop_reason`.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum AnthropicEvent {
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: DeltaText },
    #[serde(rename = "message_delta")]
    MessageDelta { delta: MessageDeltaStop },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct DeltaText {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct MessageDeltaStop {
    #[serde(default)]
    stop_reason: Option<String>,
}

/// Anthropic lifts the system message out of the messages array. Split the
/// trailing system turns (usually one, at index 0) so we can pass them via
/// the top-level `system` field.
fn split_system(messages: &[ChatMessage]) -> (Option<String>, Vec<AnthropicMsg<'_>>) {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut rest: Vec<AnthropicMsg<'_>> = Vec::new();
    for m in messages {
        match m.role {
            ChatRole::System => system_parts.push(&m.content),
            ChatRole::User => rest.push(AnthropicMsg { role: "user", content: &m.content }),
            ChatRole::Assistant => rest.push(AnthropicMsg { role: "assistant", content: &m.content }),
            // Tool messages come from the OpenAI-tool-use path. Anthropic
            // doesn't speak that protocol in v1, but if a migrated session
            // still has them in history, flatten as User with a prefix so
            // the API still accepts the payload.
            ChatRole::Tool => rest.push(AnthropicMsg {
                role: "user",
                content: &m.content,
            }),
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (system, rest)
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    fn name(&self) -> String {
        format!("anthropic · {}", self.model)
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        let (system, msgs) = split_system(&req.messages);
        let budget = thinking_budget(&self.model, req.reasoning_effort);
        let mut max_tokens = req.max_tokens.unwrap_or(2048);
        // Thinking requires max_tokens > budget; give the answer headroom too.
        // Temperature must be unset when thinking is on.
        let (thinking, temperature) = match budget {
            Some(b) => {
                if max_tokens <= b {
                    max_tokens = b + 2048;
                }
                (Some(Thinking { kind: "enabled", budget_tokens: b }), None)
            }
            None => (None, req.temperature),
        };
        let body = AnthropicRequest {
            model: &self.model,
            max_tokens,
            system: system.as_deref(),
            messages: &msgs,
            stream: true,
            temperature,
            thinking,
        };
        let key = self.api_key.lock().await.to_string();
        let res = client()?
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }

        let byte_stream = res.bytes_stream();
        let request_id = req.request_id.clone();
        let lines = data_lines(byte_stream);

        let out = async_stream::stream! {
            let mut lines = Box::pin(lines);
            let mut finish: Option<FinishReason> = None;
            while let Some(line) = lines.next().await {
                match line {
                    Err(e) => {
                        crate::log_line!("ai_anthropic", "{e}");
                        yield TokenChunk {
                            request_id: request_id.clone(),
                            delta: String::new(),
                            finish_reason: Some(FinishReason::Error),
                        };
                        return;
                    }
                    Ok(json) => {
                        match serde_json::from_str::<AnthropicEvent>(&json) {
                            Ok(AnthropicEvent::ContentBlockDelta { delta }) => {
                                if !delta.text.is_empty() {
                                    yield TokenChunk {
                                        request_id: request_id.clone(),
                                        delta: delta.text,
                                        finish_reason: None,
                                    };
                                }
                            }
                            Ok(AnthropicEvent::MessageDelta { delta }) => {
                                if let Some(stop) = delta.stop_reason {
                                    finish = Some(match stop.as_str() {
                                        "end_turn" | "stop_sequence" => FinishReason::Stop,
                                        "max_tokens" => FinishReason::Length,
                                        _ => FinishReason::Stop,
                                    });
                                }
                            }
                            Ok(AnthropicEvent::Other) => {}
                            Err(e) => {
                                crate::log_line!("ai_anthropic", "parse: {e}");
                            }
                        }
                    }
                }
            }
            yield TokenChunk {
                request_id,
                delta: String::new(),
                finish_reason: Some(finish.unwrap_or(FinishReason::Stop)),
            };
        };
        Ok(out.boxed())
    }

    async fn cancel(&self, _request_id: &str) {}

    async fn unload(&self) {
        let mut guard = self.api_key.lock().await;
        guard.zeroize();
    }
}
