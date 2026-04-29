//! Google Gemini provider. Uses the public `generativelanguage.googleapis.com`
//! surface with an API key in the request URL.
//!
//! Wire format:
//!   `POST /v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`
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
    AiError, AiProvider, ChatMessage, ChatRole, CompletionRequest, FinishReason, ProviderKind,
    TokenChunk,
};

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

    /// GET `/v1beta/models?key=…`. Gemini returns entries like `models/gemini-2.0-flash`;
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
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models?key={}",
            api_key,
        );
        let res = client()?.get(url).send().await.map_err(map_reqwest)?;
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
            }),
        };
        let (url, body_json) = self.build_request(&inner, false).await?;
        let req = client()?.post(url).body(body_json).header(
            reqwest::header::CONTENT_TYPE,
            "application/json",
        );
        let res = req.send().await.map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }
        Ok(())
    }

    /// Build (url, json-body) for the public Gemini API.
    async fn build_request<'a>(
        &self,
        inner: &GeminiRequest<'a>,
        stream: bool,
    ) -> Result<(String, Vec<u8>), AiError> {
        let key = self.api_key.lock().await.to_string();
        let method = if stream {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:{}{}key={}",
            self.model,
            method,
            if stream { "&" } else { "?" },
            key,
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
}

#[derive(Deserialize)]
struct StreamPayload {
    #[serde(default)]
    candidates: Vec<Candidate>,
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
    for m in messages {
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
            while let Some(line) = lines.next().await {
                match line {
                    Err(e) => {
                        crate::log_line!("ai_gemini", "{e}");
                        yield TokenChunk {
                            request_id: request_id.clone(),
                            delta: String::new(),
                            finish_reason: Some(FinishReason::Error),
                        };
                        return;
                    }
                    Ok(json) => {
                        let payload_opt = serde_json::from_str::<StreamPayload>(&json).ok();
                        let Some(p) = payload_opt else {
                            crate::log_line!("ai_gemini", "parse: {}", json.chars().take(200).collect::<String>());
                            continue;
                        };
                        for cand in p.candidates {
                            if let Some(fr) = cand.finish_reason.as_deref() {
                                finish = Some(match fr {
                                    "STOP" => FinishReason::Stop,
                                    "MAX_TOKENS" => FinishReason::Length,
                                    _ => FinishReason::Stop,
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
