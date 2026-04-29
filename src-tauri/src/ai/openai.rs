//! OpenAI and OpenAI-compatible chat completions provider.
//!
//! Wire format: `POST {base_url}/chat/completions` with
//! `{ model, messages, stream: true }` and `Authorization: Bearer {key}`.
//! Streams `data: {json}` SSE lines; the terminal line is `data: [DONE]`.
//!
//! The same struct serves both the real OpenAI endpoint and OpenAI-compatible
//! servers (Ollama, Groq, Together, OpenRouter, LM Studio, vLLM, ...). The
//! only difference is `base_url` and the `ProviderKind` we report.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use super::http::{client, map_reqwest, map_status};
use super::sse::data_lines;
use super::{
    AiError, AiProvider, ChatRole, CompletionRequest, FinishReason, ProviderKind, TokenChunk,
};

pub struct OpenAiProvider {
    base_url: String,
    // Zeroizing<String> overwrites the buffer with zeros when dropped, so
    // end_chat → drop(session) → drop(provider) → key is zeroed.
    api_key: Arc<Mutex<Zeroizing<String>>>,
    model: String,
    kind: ProviderKind,
}

/// Result of one non-streaming turn. Either `tool_calls` is non-empty
/// (model wants us to call tools and come back), or `content` carries the
/// final reply.
pub struct ToolTurn {
    pub content: String,
    pub tool_calls: Vec<crate::ai::ToolCall>,
    #[allow(dead_code)]
    pub finish_reason: String,
}

impl OpenAiProvider {
    pub fn new(base_url: String, api_key: String, model: String, kind: ProviderKind) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: Arc::new(Mutex::new(Zeroizing::new(api_key))),
            model,
            kind,
        }
    }

    pub fn openai(api_key: String, model: String) -> Self {
        Self::new(
            "https://api.openai.com/v1".into(),
            api_key,
            model,
            ProviderKind::Openai,
        )
    }

    pub fn compatible(base_url: String, api_key: String, model: String) -> Self {
        Self::new(base_url, api_key, model, ProviderKind::OpenaiCompatible)
    }

    /// GET `{base_url}/models`. Works for both OpenAI and any OpenAI-compatible
    /// server that exposes the same listing endpoint (Ollama, Groq, LM Studio,
    /// vLLM, OpenRouter…). Returns model ids sorted alphabetically.
    pub async fn list_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<String>, AiError> {
        #[derive(Deserialize)]
        struct ListResp {
            data: Vec<ListEntry>,
        }
        #[derive(Deserialize)]
        struct ListEntry {
            id: String,
        }
        let url = format!("{}/models", base_url.trim_end_matches('/'));
        let mut req = client()?.get(url);
        if let Some(k) = api_key {
            req = req.bearer_auth(k);
        }
        let res = req.send().await.map_err(map_reqwest)?;
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

    /// 1-token probe so an invalid key fails up front instead of during the
    /// first user turn. Called from `ai_start` before the session is installed.
    pub async fn probe(&self) -> Result<(), AiError> {
        // NB: no `max_tokens` / `max_completion_tokens` in the probe. Some
        // newer models (o1, o3, gpt-5) reject `max_tokens` and the
        // Responses-only ones reject `max_completion_tokens` too when set to
        // 1. A bare 2-message ping is the widest-compatible shape.
        let body = ChatRequest {
            model: &self.model,
            messages: &[ChatMsg { role: "user", content: "ping" }],
            stream: false,
            max_tokens: None,
            max_completion_tokens: None,
            temperature: None,
        };
        let key = self.api_key.lock().await.to_string();
        let res = client()?
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&key)
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

    /// One non-streaming round-trip with tool definitions attached. Used by
    /// the tool-use loop in `ai_chat_send`. Messages already include any
    /// prior tool calls/results so the model can see the whole conversation.
    pub async fn complete_once(
        &self,
        history: &[crate::ai::ChatMessage],
        tools: Option<&[crate::ai::tools::ToolDef]>,
    ) -> Result<ToolTurn, AiError> {
        // Build the messages array with the OpenAI tool-use shape: assistant
        // turns that originated a tool call carry `tool_calls` in place of
        // content; tool replies carry `tool_call_id`.
        #[derive(Serialize)]
        struct ToolCallWire<'a> {
            id: &'a str,
            #[serde(rename = "type")]
            kind: &'a str,
            function: ToolCallFn<'a>,
        }
        #[derive(Serialize)]
        struct ToolCallFn<'a> {
            name: &'a str,
            arguments: &'a str,
        }

        let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(history.len());
        for m in history {
            match m.role {
                crate::ai::ChatRole::Tool => {
                    msgs.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": m.tool_call_id,
                        "content": m.content,
                    }));
                }
                crate::ai::ChatRole::Assistant if !m.tool_calls.is_empty() => {
                    let calls: Vec<ToolCallWire> = m.tool_calls.iter().map(|c| ToolCallWire {
                        id: &c.id,
                        kind: "function",
                        function: ToolCallFn { name: &c.name, arguments: &c.arguments },
                    }).collect();
                    msgs.push(serde_json::json!({
                        "role": "assistant",
                        "content": if m.content.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(m.content.clone()) },
                        "tool_calls": calls,
                    }));
                }
                _ => {
                    msgs.push(serde_json::json!({
                        "role": role_str(m.role),
                        "content": m.content,
                    }));
                }
            }
        }

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": msgs,
            "stream": false,
        });
        if let Some(tools) = tools {
            body["tools"] = serde_json::to_value(tools).unwrap_or(serde_json::Value::Null);
            body["tool_choice"] = serde_json::Value::String("auto".into());
        }

        // Debug logging — helps diagnose why small local models sometimes
        // print tool-call JSON as text instead of emitting a structured
        // tool_calls array. Redacts nothing beyond the bearer token (which
        // `http::redact` would strip from error bodies but not from our own
        // outbound request shape).
        crate::log_line!(
            "ai_tools_req",
            "POST {}/chat/completions tools={} msgs={}",
            self.base_url,
            tools.map(|t| t.len()).unwrap_or(0),
            msgs.len()
        );

        let key = self.api_key.lock().await.to_string();
        let res = client()?
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(map_status(status, &body));
        }

        #[derive(Deserialize)]
        struct Resp {
            choices: Vec<RespChoice>,
        }
        #[derive(Deserialize)]
        struct RespChoice {
            message: RespMessage,
            #[serde(default)]
            finish_reason: Option<String>,
        }
        #[derive(Deserialize)]
        struct RespMessage {
            #[serde(default)]
            content: Option<String>,
            #[serde(default)]
            tool_calls: Vec<RespToolCall>,
        }
        #[derive(Deserialize)]
        struct RespToolCall {
            id: String,
            function: RespToolCallFn,
        }
        #[derive(Deserialize)]
        struct RespToolCallFn {
            name: String,
            #[serde(default)]
            arguments: String,
        }

        let parsed: Resp = res
            .json()
            .await
            .map_err(|e| AiError::Upstream(format!("parse response: {e}")))?;
        let Some(choice) = parsed.choices.into_iter().next() else {
            return Err(AiError::Upstream("response had no choices".into()));
        };
        let mut tool_calls: Vec<crate::ai::ToolCall> = choice
            .message
            .tool_calls
            .into_iter()
            .map(|c| crate::ai::ToolCall {
                id: c.id,
                name: c.function.name,
                arguments: c.function.arguments,
            })
            .collect();
        let mut content = choice.message.content.unwrap_or_default();

        // Fallback extractor for small/unpatched local models that emit the
        // tool call as JSON text inside a ```json``` fence instead of using
        // the structured `tool_calls` channel. Without this, Qwen 2.5 Coder
        // 3B in particular produces output like:
        //   ```json
        //   {"name": "describe_table", "arguments": {"table": "foo"}}
        //   ```
        // and the loop stalls because `tool_calls` is empty. We parse that
        // shape against our known tool catalog; on a match we synthesize a
        // ToolCall and clear the content so the UI doesn't render both.
        if tool_calls.is_empty() {
            if let Some(tools_slice) = tools {
                if let Some(extracted) = extract_text_tool_call(&content, tools_slice) {
                    crate::log_line!(
                        "ai_tools_resp",
                        "text-fallback extracted tool_call: {} args={}",
                        extracted.name,
                        extracted.arguments
                    );
                    tool_calls.push(extracted);
                    content.clear();
                }
            }
        }

        crate::log_line!(
            "ai_tools_resp",
            "tool_calls={} content_len={} content_preview={:?}",
            tool_calls.len(),
            content.len(),
            content.chars().take(140).collect::<String>()
        );
        Ok(ToolTurn {
            content,
            tool_calls,
            finish_reason: choice.finish_reason.unwrap_or_default(),
        })
    }

    /// Reasoning-era OpenAI models (o1 / o3 / o4 / gpt-5 family) replaced
    /// `max_tokens` with `max_completion_tokens`. Third-party OpenAI-compatible
    /// backends (Ollama, Groq, vLLM…) still accept `max_tokens`, so we only
    /// swap the field when talking to the real OpenAI endpoint against a
    /// known reasoning-model prefix.
    fn uses_max_completion_tokens(&self) -> bool {
        if self.kind != ProviderKind::Openai {
            return false;
        }
        let m = self.model.to_ascii_lowercase();
        m.starts_with("o1")
            || m.starts_with("o3")
            || m.starts_with("o4")
            || m.starts_with("gpt-5")
    }
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMsg<'a>],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(rename = "max_completion_tokens", skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct ChatMsg<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct StreamPayload {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: DeltaContent,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct DeltaContent {
    #[serde(default)]
    content: Option<String>,
}

fn role_str(role: ChatRole) -> &'static str {
    match role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
    }
}

#[async_trait]
impl AiProvider for OpenAiProvider {
    fn name(&self) -> String {
        format!("{} · {}", self.kind.as_str(), self.model)
    }

    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn complete(
        &self,
        req: CompletionRequest,
    ) -> Result<BoxStream<'static, TokenChunk>, AiError> {
        let messages: Vec<ChatMsg> = req
            .messages
            .iter()
            .map(|m| ChatMsg { role: role_str(m.role), content: &m.content })
            .collect();
        let (max_tokens, max_completion_tokens) = if self.uses_max_completion_tokens() {
            (None, req.max_tokens)
        } else {
            (req.max_tokens, None)
        };
        // Reasoning-era OpenAI models also reject a custom `temperature`;
        // they only accept the default. Send `None` in that case.
        let temperature = if self.uses_max_completion_tokens() {
            None
        } else {
            req.temperature
        };
        let body = ChatRequest {
            model: &self.model,
            messages: &messages,
            stream: true,
            max_tokens,
            max_completion_tokens,
            temperature,
        };
        let key = self.api_key.lock().await.to_string();
        let res = client()?
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&key)
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

        // Map each decoded `data:` line to a TokenChunk. Parse errors fold
        // into a final Error chunk so the UI always gets a terminator.
        let out = async_stream::stream! {
            let mut lines = Box::pin(lines);
            while let Some(line) = lines.next().await {
                match line {
                    Err(e) => {
                        yield TokenChunk {
                            request_id: request_id.clone(),
                            delta: String::new(),
                            finish_reason: Some(FinishReason::Error),
                        };
                        tracing_fallback(&e);
                        return;
                    }
                    Ok(json) => {
                        match serde_json::from_str::<StreamPayload>(&json) {
                            Ok(p) => {
                                for choice in p.choices {
                                    let delta = choice.delta.content.unwrap_or_default();
                                    let finish = choice.finish_reason.as_deref().map(map_finish);
                                    if delta.is_empty() && finish.is_none() {
                                        continue;
                                    }
                                    yield TokenChunk {
                                        request_id: request_id.clone(),
                                        delta,
                                        finish_reason: finish,
                                    };
                                }
                            }
                            Err(e) => {
                                tracing_fallback(&format!("openai parse: {e}"));
                                continue;
                            }
                        }
                    }
                }
            }
            // Upstream ended without a finish_reason — synthesize one so the
            // UI's `done` handler always fires.
            yield TokenChunk {
                request_id,
                delta: String::new(),
                finish_reason: Some(FinishReason::Stop),
            };
        };
        Ok(out.boxed())
    }

    async fn cancel(&self, _request_id: &str) {
        // OpenAI doesn't offer mid-stream cancel; dropping the response future
        // on the client side is effectively the cancel. The frontend already
        // stops displaying chunks the moment `pendingRequestId` clears.
    }

    async fn unload(&self) {
        // Zero the key explicitly rather than waiting for Drop — faster
        // guarantee when the user clicks End Chat.
        let mut guard = self.api_key.lock().await;
        guard.zeroize();
    }

    async fn complete_once(
        &self,
        history: &[crate::ai::ChatMessage],
        tools: Option<&[crate::ai::tools::ToolDef]>,
    ) -> Result<ToolTurn, AiError> {
        // Delegate to the inherent method we already implemented above.
        OpenAiProvider::complete_once(self, history, tools).await
    }

    fn supports_tools(&self) -> bool {
        true
    }
}

/// Best-effort extractor for models that print their tool call as JSON text
/// inside the `content` field instead of using the structured `tool_calls`
/// channel. Looks for a `{...}` block that contains both a `name` matching
/// one of our registered tools and an `arguments` object.
///
/// Matches three common shapes:
///   ```json
///   {"name": "foo", "arguments": {...}}
///   ```
/// or the same without fences, or with extra prose around it.
fn extract_text_tool_call(
    content: &str,
    tools: &[crate::ai::tools::ToolDef],
) -> Option<crate::ai::ToolCall> {
    // Find the first balanced `{...}` object in the content. We walk the
    // string char-by-char tracking brace depth; cheaper + more forgiving
    // than a regex and handles embedded arguments objects cleanly.
    let bytes = content.as_bytes();
    let mut start: Option<usize> = None;
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => {
                if start.is_none() {
                    start = Some(i);
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let slice = &content[start.unwrap()..=i];
                    if let Some(call) = try_match_tool(slice, tools) {
                        return Some(call);
                    }
                    // Didn't match — keep scanning in case there's another
                    // object later (e.g. prose then JSON).
                    start = None;
                }
            }
            _ => {}
        }
    }
    None
}

fn try_match_tool(
    json_text: &str,
    tools: &[crate::ai::tools::ToolDef],
) -> Option<crate::ai::ToolCall> {
    #[derive(Deserialize)]
    struct TextCall {
        name: String,
        #[serde(default)]
        arguments: serde_json::Value,
    }
    let parsed: TextCall = serde_json::from_str(json_text).ok()?;
    let known = tools.iter().any(|t| t.function.name == parsed.name);
    if !known {
        return None;
    }
    let args = if parsed.arguments.is_null() {
        "{}".to_string()
    } else if parsed.arguments.is_string() {
        // Some models stringify the args. Normalise to the object form the
        // dispatcher expects.
        parsed.arguments.as_str().unwrap_or("{}").to_string()
    } else {
        parsed.arguments.to_string()
    };
    Some(crate::ai::ToolCall {
        // Synthesize an id matching the OpenAI format so the downstream
        // approval/tool bubble logic doesn't care where the call originated.
        id: format!("text-{}", uuid::Uuid::new_v4()),
        name: parsed.name,
        arguments: args,
    })
}

fn map_finish(raw: &str) -> FinishReason {
    match raw {
        "stop" | "end_turn" => FinishReason::Stop,
        "length" | "max_tokens" => FinishReason::Length,
        "canceled" | "cancelled" => FinishReason::Canceled,
        _ => FinishReason::Stop,
    }
}

// Tiny logging hook — emits to our existing log-file pipeline without
// turning on `tracing`.
fn tracing_fallback(msg: &str) {
    crate::log_line!("ai_openai", "{msg}");
}
