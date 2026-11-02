//! Google Gemini provider. Uses the public `generativelanguage.googleapis.com`
//! surface with the API key in the `x-goog-api-key` header (not the URL, where
//! a transport error message would carry it into logs and the UI).
//!
//! Wire format:
//!   `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`
//!   body: `{ systemInstruction, contents, generationConfig }`
//!
//! SSE events (in both paths) ultimately surface the same
//! `candidates[].content.parts[].text`.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use super::http::{client, map_reqwest, map_status};
use super::sse::data_lines;
use super::{
    stream_failure, AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, FinishReason,
    ProviderKind, TokenChunk,
};

const API_KEY_HEADER: &str = "x-goog-api-key";

pub struct GeminiProvider {
    api_key: Arc<Mutex<Zeroizing<String>>>,
    model: String,
}

impl GeminiProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key: Arc::new(Mutex::new(Zeroizing::new(api_key))),
            model,
        }
    }

    /// GET `/v1beta/models`. Gemini returns entries like `models/gemini-2.0-flash`;
    /// we strip the `models/` prefix so the dropdown matches what users pass back in.
    /// Only models that support `generateContent` are returned — lots of the
    /// catalog is embeddings-only and unusable here.
    pub async fn list_models(api_key: &str) -> Result<Vec<String>, AiError> {
        #[derive(Deserialize)]
        struct ListResp {
            models: Vec<ListEntry>,
        }
        #[derive(Deserialize)]
        struct ListEntry {
            name: String,
            #[serde(default, rename = "supportedGenerationMethods")]
            methods: Vec<String>,
        }
        let res = client()?
            .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000")
            .header(API_KEY_HEADER, api_key)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }
        let list: ListResp = res.json().await.map_err(map_reqwest)?;
        let mut ids: Vec<String> = list
            .models
            .into_iter()
            .filter(|m| m.methods.iter().any(|s| s == "generateContent"))
            .map(|m| m.name.strip_prefix("models/").unwrap_or(&m.name).to_string())
            .collect();
        ids.sort();
        Ok(ids)
    }

    #[allow(dead_code)] // kept for explicit key validation; not on start path
    pub async fn probe(&self) -> Result<(), AiError> {
        let user = vec![GeminiContent {
            role: "user",
            parts: vec![GeminiPart { text: "ping" }],
        }];
        let inner = GeminiRequest {
            system_instruction: None,
            contents: user,
            generation_config: Some(GenerationConfig {
                max_output_tokens: Some(1),
                temperature: None,
                thinking_config: None,
            }),
        };
        let (url, body_json) = self.build_request(&inner, false).await?;
        let req = client()?
            .post(url)
            .body(body_json)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(API_KEY_HEADER, self.api_key.lock().await.as_str());
        let res = req.send().await.map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }
        Ok(())
    }

    /// Build (url, json-body) for the public Gemini API. The key goes in the
    /// [`API_KEY_HEADER`] header.
    async fn build_request<'a>(
        &self,
        inner: &GeminiRequest<'a>,
        stream: bool,
    ) -> Result<(String, Vec<u8>), AiError> {
        let method = if stream {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:{}",
            self.model, method,
        );
        let body = serde_json::to_vec(inner)
            .map_err(|e| AiError::Other(format!("encode body: {e}")))?;
        Ok((url, body))
    }
}

#[derive(Serialize)]
struct GeminiRequest<'a> {
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent<'a>>,
    contents: Vec<GeminiContent<'a>>,
    #[serde(rename = "generationConfig", skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
}

#[derive(Serialize)]
struct GeminiContent<'a> {
    role: &'a str,
    parts: Vec<GeminiPart<'a>>,
}

#[derive(Serialize)]
struct GeminiPart<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "maxOutputTokens", skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(rename = "thinkingConfig", skip_serializing_if = "Option::is_none")]
    thinking_config: Option<ThinkingConfig>,
}

/// Gemini 2.5 thinking control. `thinkingBudget` is a token budget for internal
/// reasoning (0 disables it).
#[derive(Serialize)]
struct ThinkingConfig {
    #[serde(rename = "thinkingBudget")]
    thinking_budget: u32,
}

/// Token budget for an effort, or `None` to omit thinkingConfig entirely.
/// Gated to 2.5-family models — older Gemini rejects `thinkingConfig`.
fn gemini_thinking_budget(model: &str, effort: Option<crate::ai::ReasoningEffort>) -> Option<u32> {
    if !model.to_ascii_lowercase().contains("2.5") {
        return None;
    }
    match effort {
        Some(crate::ai::ReasoningEffort::High) => Some(12_288),
        Some(crate::ai::ReasoningEffort::Medium) => Some(4_096),
        // Don't send `thinkingBudget: 0` — 2.5 Pro can't fully disable thinking
        // and rejects it. Omitting the field lets the model use its own default.
        Some(crate::ai::ReasoningEffort::Low) => None,
        None => None,
    }
}

#[derive(Deserialize)]
struct StreamPayload {
    #[serde(default)]
    candidates: Vec<Candidate>,
    /// Set when the prompt itself was refused (no candidates follow).
    #[serde(rename = "promptFeedback", default)]
    prompt_feedback: Option<PromptFeedback>,
    /// A mid-stream failure arrives as an ordinary SSE frame carrying this.
    #[serde(default)]
    error: Option<StreamError>,
}

#[derive(Deserialize)]
struct PromptFeedback {
    #[serde(rename = "blockReason", default)]
    block_reason: Option<String>,
}

#[derive(Deserialize)]
struct StreamError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
struct Candidate {
    #[serde(default)]
    content: Option<CandidateContent>,
    #[serde(rename = "finishReason", default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct CandidateContent {
    #[serde(default)]
    parts: Vec<CandidatePart>,
}

#[derive(Deserialize)]
struct CandidatePart {
    #[serde(default)]
    text: Option<String>,
}

fn split_system(messages: &[ChatMessage]) -> (Option<GeminiContent<'_>>, Vec<GeminiContent<'_>>) {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut contents: Vec<GeminiContent<'_>> = Vec::new();
    // Gemini rejects empty text parts, so an empty turn (a stopped reply, a
    // tool turn with no text) is left out rather than failing the request.
    for m in messages.iter().filter(|m| !m.content.trim().is_empty()) {
        match m.role {
            ChatRole::System => system_parts.push(&m.content),
            ChatRole::User => contents.push(GeminiContent {
                role: "user",
                parts: vec![GeminiPart { text: &m.content }],
            }),
            ChatRole::Assistant => contents.push(GeminiContent {
                role: "model",
                parts: vec![GeminiPart { text: &m.content }],
            }),
            // Gemini has no native tool-use in v1. If a session's history
            // contains Tool messages (from a prior provider), flatten them
            // as user content so the API still accepts the payload.
            ChatRole::Tool => contents.push(GeminiContent {
                role: "user",
                parts: vec![GeminiPart { text: &m.content }],
            }),
        }
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(GeminiContent {
            role: "system",
            parts: system_parts
                .into_iter()
                .map(|s| GeminiPart { text: s })
                .collect(),
        })
    };
    (system, contents)
}

#[async_trait]
impl AiProvider for GeminiProvider {
    fn name(&self) -> String {
        format!("gemini · {}", self.model)
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        let (system, contents) = split_system(&req.messages);
        let inner = GeminiRequest {
            system_instruction: system,
            contents,
            generation_config: Some(GenerationConfig {
                max_output_tokens: req.max_tokens,
                temperature: req.temperature,
                thinking_config: gemini_thinking_budget(&self.model, req.reasoning_effort)
                    .map(|b| ThinkingConfig { thinking_budget: b }),
            }),
        };
        let (url, body_json) = self.build_request(&inner, true).await?;
        let http = client()?
            .post(url)
            .body(body_json)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        let res = http.send().await.map_err(map_reqwest)?;
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
            // Why Gemini cut the reply short (SAFETY, RECITATION, …), if it did.
            let mut cut_short: Option<String> = None;
            while let Some(line) = lines.next().await {
                match line {
                    Err(e) => {
                        crate::log_line!("ai_gemini", "{e}");
                        yield stream_failure(&request_id, &e.to_string());
                        return;
                    }
                    Ok(json) => {
                        let payload_opt = serde_json::from_str::<StreamPayload>(&json).ok();
                        let Some(p) = payload_opt else {
                            crate::log_line!("ai_gemini", "parse: {}", json.chars().take(200).collect::<String>());
                            continue;
                        };
                        if let Some(err) = p.error {
                            crate::log_line!("ai_gemini", "stream error: {} {}", err.status, err.message);
                            let msg = if err.message.is_empty() { err.status } else { err.message };
                            yield stream_failure(&request_id, &format!("Gemini: {msg}"));
                            return;
                        }
                        if let Some(reason) = p.prompt_feedback.and_then(|f| f.block_reason) {
                            yield stream_failure(&request_id, &format!("Gemini refused the prompt ({reason})"));
                            return;
                        }
                        for cand in p.candidates {
                            if let Some(fr) = cand.finish_reason.as_deref() {
                                finish = Some(match fr {
                                    "STOP" => FinishReason::Stop,
                                    "MAX_TOKENS" => FinishReason::Length,
                                    // SAFETY, RECITATION, BLOCKLIST, … end the
                                    // reply early; said at the end (after this
                                    // frame's text) instead of stopping silently,
                                    // often with nothing shown.
                                    other => {
                                        cut_short = Some(other.to_string());
                                        FinishReason::Error
                                    }
                                });
                            }
                            if let Some(content) = cand.content {
                                for part in content.parts {
                                    if let Some(text) = part.text {
                                        if text.is_empty() {
                                            continue;
                                        }
                                        yield TokenChunk {
                                            request_id: request_id.clone(),
                                            delta: text,
                                            finish_reason: None,
                                        };
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Every complete reply ends with a finishReason; without one the
            // connection was cut mid-reply.
            // An error finish keeps a cut-short notice out of the transcript the
            // model reads back.
            match (finish, cut_short) {
                (_, Some(reason)) => yield stream_failure(&request_id, &format!("Gemini stopped the reply ({reason})")),
                (Some(f), None) => yield TokenChunk { request_id, delta: String::new(), finish_reason: Some(f) },
                (None, None) => yield stream_failure(&request_id, "the connection closed before the reply finished"),
            }
        };
        Ok(out.boxed())
    }

    async fn cancel(&self, _request_id: &str) {}

    async fn unload(&self) {
        let mut guard = self.api_key.lock().await;
        guard.zeroize();
    }
}
