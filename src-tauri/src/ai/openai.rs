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

const DEFAULT_TOOL_MAX_TOKENS: u32 = 16_384;

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

    /// Tiny probe so an invalid key fails up front instead of during the
    /// first user turn. Called from `ai_start` before the session is installed.
    /// Do not cap output here: reasoning models can fail the request before
    /// producing any text if the completion budget is too small.
    pub async fn probe(&self) -> Result<(), AiError> {
        let body = ChatRequest {
            model: &self.model,
            messages: &[ChatMsg { role: "user", content: "hi" }],
            stream: false,
            max_tokens: None,
            max_completion_tokens: None,
            temperature: None,
        };
        let key = self.api_key.lock().await.to_string();
        let http = client()?;
        let res = http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_else(|e| format!("(could not read error body: {e})"));
            log_upstream_error("probe", &self.model, &self.base_url, status, &body);
            if Self::should_retry_with_max_completion_tokens(status, &body) {
                let retry_body = ChatRequest {
                    model: &self.model,
                    messages: &[ChatMsg { role: "user", content: "hi" }],
                    stream: false,
                    max_tokens: None,
                    max_completion_tokens: Some(DEFAULT_TOOL_MAX_TOKENS),
                    temperature: None,
                };
                let retry = http
                    .post(format!("{}/chat/completions", self.base_url))
                    .bearer_auth(&key)
                    .json(&retry_body)
                    .send()
                    .await
                    .map_err(map_reqwest)?;
                let retry_status = retry.status();
                if retry_status.is_success() {
                    let _ = retry.bytes().await;
                    return Ok(());
                }
                let retry_body = retry.text().await.unwrap_or_default();
                log_upstream_error("probe_retry", &self.model, &self.base_url, retry_status, &retry_body);
                return Err(map_status(retry_status, &retry_body));
            }
            return Err(map_status(status, &body));
        }
        // Drain the body so the connection is properly recycled.
        let _ = res.bytes().await;
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
        let token_params = self.token_limit_params(Some(DEFAULT_TOOL_MAX_TOKENS));
        if let Some(max_tokens) = token_params.max_tokens {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
        if let Some(max_completion_tokens) = token_params.max_completion_tokens {
            body["max_completion_tokens"] = serde_json::json!(max_completion_tokens);
        }
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
            let error_body = res.text().await.unwrap_or_default();
            log_upstream_error("tool_once", &self.model, &self.base_url, status, &error_body);
            if Self::should_retry_with_max_completion_tokens(status, &error_body) {
                let mut retry_body = body.clone();
                if let Some(obj) = retry_body.as_object_mut() {
                    obj.remove("max_tokens");
                }
                retry_body["max_completion_tokens"] = serde_json::json!(DEFAULT_TOOL_MAX_TOKENS);
                let retry = client()?
                    .post(format!("{}/chat/completions", self.base_url))
                    .bearer_auth(&key)
                    .json(&retry_body)
                    .send()
                    .await
                    .map_err(map_reqwest)?;
                let retry_status = retry.status();
                if retry_status.is_success() {
                    return parse_tool_turn_response(retry, tools).await;
                }
                let retry_body = retry.text().await.unwrap_or_default();
                log_upstream_error("tool_once_retry", &self.model, &self.base_url, retry_status, &retry_body);
                return Err(map_status(retry_status, &retry_body));
            }
            return Err(map_status(status, &error_body));
        }

        parse_tool_turn_response(res, tools).await
    }

    /// Reasoning-era OpenAI models (o1 / o3 / o4 / gpt-5 family) replaced
    /// `max_tokens` with `max_completion_tokens`. Third-party OpenAI-compatible
    /// backends (Ollama, Groq, vLLM…) still accept `max_tokens`, so we only
    /// swap the field when talking to the real OpenAI endpoint against a
    /// known reasoning-model prefix.
    fn uses_max_completion_tokens(&self) -> bool {
        if !self.is_real_openai_endpoint() {
            return false;
        }
        let m = self.model.to_ascii_lowercase();
        m.starts_with("o1")
            || m.starts_with("o3")
            || m.starts_with("o4")
            || m.starts_with("gpt-5")
    }

    fn is_real_openai_endpoint(&self) -> bool {
        self.kind == ProviderKind::Openai
            || self.base_url == "https://api.openai.com/v1"
            || self.base_url.starts_with("https://api.openai.com/")
    }

    fn token_limit_params(&self, limit: Option<u32>) -> TokenLimitParams {
        if self.uses_max_completion_tokens() {
            TokenLimitParams { max_tokens: None, max_completion_tokens: limit }
        } else {
            TokenLimitParams { max_tokens: limit, max_completion_tokens: None }
        }
    }

    fn should_retry_with_max_completion_tokens(status: reqwest::StatusCode, body: &str) -> bool {
        status.as_u16() == 400
            && body.contains("max_tokens")
            && body.contains("max_completion_tokens")
    }
}

#[derive(Clone, Copy)]
struct TokenLimitParams {
    max_tokens: Option<u32>,
    max_completion_tokens: Option<u32>,
}

async fn parse_tool_turn_response(
    res: reqwest::Response,
    tools: Option<&[crate::ai::tools::ToolDef]>,
) -> Result<ToolTurn, AiError> {
        // Read the body as raw bytes first — some OpenAI-compatible
        // endpoints return SSE even when stream=false, or send gzip
        // bodies regardless of Accept-Encoding. We decode as UTF-8
        // lossy so a few stray bytes don't kill the whole response.
        let raw_bytes = res.bytes().await.map_err(|e| {
            AiError::Upstream(format!("read response body: {e}"))
        })?;
        // Some servers always gzip even when we don't ask for it.
        // Detect the gzip magic bytes (1f 8b) and decompress.
        let decoded_bytes = if raw_bytes.len() >= 2 && raw_bytes[0] == 0x1f && raw_bytes[1] == 0x8b {
            use std::io::Read;
            let mut decoder = flate2::read::GzDecoder::new(&raw_bytes[..]);
            let mut decompressed = Vec::new();
            match decoder.read_to_end(&mut decompressed) {
                Ok(_) => decompressed,
                Err(e) => {
                    crate::log_line!("ai_tools_resp", "gzip decompress failed: {e}, using raw bytes");
                    raw_bytes.to_vec()
                }
            }
        } else {
            raw_bytes.to_vec()
        };
        let raw_body = String::from_utf8_lossy(&decoded_bytes).to_string();

        let json_text = if raw_body.trim_start().starts_with("data:") {
            // SSE format — extract the last non-empty data line
            raw_body
                .lines()
                .filter_map(|l| l.strip_prefix("data:").map(|s| s.trim()))
                .filter(|s| !s.is_empty() && *s != "[DONE]")
                .last()
                .unwrap_or(raw_body.trim())
                .to_string()
        } else {
            raw_body.trim().to_string()
        };

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
            tool_calls: Option<Vec<RespToolCall>>,
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

        let parsed: Resp = serde_json::from_str(&json_text).map_err(|e| {
            crate::log_line!("ai_tools_resp", "body_len={} first200={}", json_text.len(), &json_text[..json_text.len().min(200)]);
            AiError::Upstream(format!("parse response: {e}"))
        })?;
        let Some(choice) = parsed.choices.into_iter().next() else {
            return Err(AiError::Upstream("response had no choices".into()));
        };
        let mut tool_calls: Vec<crate::ai::ToolCall> = choice
            .message
            .tool_calls
            .unwrap_or_default()
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
        let token_params = self.token_limit_params(req.max_tokens);
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
            max_tokens: token_params.max_tokens,
            max_completion_tokens: token_params.max_completion_tokens,
            temperature,
        };
        let key = self.api_key.lock().await.to_string();
        let http = client()?;
        let res = http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            log_upstream_error("stream", &self.model, &self.base_url, status, &body);
            if Self::should_retry_with_max_completion_tokens(status, &body) {
                let retry_body = ChatRequest {
                    model: &self.model,
                    messages: &messages,
                    stream: true,
                    max_tokens: None,
                    max_completion_tokens: req.max_tokens,
                    temperature: None,
                };
                let retry = http
                    .post(format!("{}/chat/completions", self.base_url))
                    .bearer_auth(&key)
                    .json(&retry_body)
                    .send()
                    .await
                    .map_err(map_reqwest)?;
                let retry_status = retry.status();
                if retry_status.is_success() {
                    return stream_openai_response(retry, req.request_id.clone()).await;
                }
                let retry_body = retry.text().await.unwrap_or_default();
                log_upstream_error("stream_retry", &self.model, &self.base_url, retry_status, &retry_body);
                return Err(map_status(retry_status, &retry_body));
            }
            return Err(map_status(status, &body));
        }

        stream_openai_response(res, req.request_id.clone()).await
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

    // Second fallback: weaker local models (Qwen-Coder, small Llamas) often
    // ignore the tool-call channel entirely and just answer "here's the query"
    // with a ```sql fenced block. When `call_query` is available, treat a lone
    // SQL fence as intent to run it — otherwise the chat loops forever ("run
    // it" → model re-pastes the SQL → never executes). Only fires when a
    // query tool exists in the catalog.
    if let Some(sql) = extract_sql_fence(content) {
        let query_tool = tools.iter().find_map(|t| {
            let n = t.function.name;
            if n == "call_query" || n == "run_query" || n == "call_sql" {
                Some(n.to_string())
            } else {
                None
            }
        });
        if let Some(name) = query_tool {
            return Some(crate::ai::ToolCall {
                id: format!("textsql-{}", sql.len()),
                name,
                arguments: serde_json::json!({ "sql": sql }).to_string(),
            });
        }
    }
    None
}

/// Pull the first ```sql … ``` fenced block out of model prose. Returns the
/// trimmed SQL, or None if there's no SQL fence. Accepts ```sql and a bare ```
/// fence that contains an obvious SQL statement.
fn extract_sql_fence(content: &str) -> Option<String> {
    let lower = content.to_ascii_lowercase();
    // Locate a fence opening: prefer an explicit ```sql.
    let fence_start = lower.find("```sql").map(|i| i + 6).or_else(|| {
        // Bare ``` fence — only accept if the body starts with a SQL verb.
        lower.find("```").and_then(|i| {
            let body = content[i + 3..].trim_start();
            let bl = body.to_ascii_lowercase();
            let looks_sql = ["select", "with", "insert", "update", "delete", "create", "alter", "drop"]
                .iter()
                .any(|kw| bl.starts_with(kw));
            if looks_sql { Some(i + 3) } else { None }
        })
    })?;
    let rest = &content[fence_start..];
    let end = rest.find("```").unwrap_or(rest.len());
    let sql = rest[..end].trim().trim_start_matches('\n').trim();
    if sql.is_empty() {
        None
    } else {
        Some(sql.to_string())
    }
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

async fn stream_openai_response(
    res: reqwest::Response,
    request_id: String,
) -> Result<BoxStream<'static, TokenChunk>, AiError> {
    let byte_stream = res.bytes_stream();
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

fn log_upstream_error(
    phase: &str,
    model: &str,
    base_url: &str,
    status: reqwest::StatusCode,
    body: &str,
) {
    crate::log_line!(
        "ai_openai_error",
        "phase={} status={} model={} base_url={} body={}",
        phase,
        status.as_u16(),
        model,
        base_url,
        body.chars().take(1000).collect::<String>()
    );
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

#[cfg(test)]
mod sql_fence_tests {
    use super::*;
    use crate::ai::tools::catalog_scoped;

    #[test]
    fn extracts_explicit_sql_fence() {
        let c = "Here you go:\n```sql\nSELECT COUNT(*) FROM film_genres;\n```\nDone.";
        assert_eq!(
            extract_sql_fence(c).as_deref(),
            Some("SELECT COUNT(*) FROM film_genres;")
        );
    }

    #[test]
    fn extracts_bare_fence_with_sql_verb() {
        let c = "```\nSELECT 1\n```";
        assert_eq!(extract_sql_fence(c).as_deref(), Some("SELECT 1"));
    }

    #[test]
    fn ignores_non_sql_bare_fence() {
        let c = "```\nnpm install foo\n```";
        assert_eq!(extract_sql_fence(c), None);
    }

    #[test]
    fn no_fence_returns_none() {
        assert_eq!(extract_sql_fence("just talking, no code"), None);
    }

    #[test]
    fn text_fallback_synthesizes_call_query_from_sql_prose() {
        // The exact failure: weak local model writes SQL prose instead of a
        // tool call. With call_query in the catalog, we synthesize the call.
        let tools = catalog_scoped(false, true);
        let content = "To count rows:\n```sql\nSELECT COUNT(DISTINCT actor_id) FROM film_actors;\n```";
        let call = extract_text_tool_call(content, &tools).expect("should synthesize a call");
        assert!(call.name == "call_query" || call.name == "run_query" || call.name == "call_sql");
        assert!(call.arguments.contains("actor_id"));
    }
}
