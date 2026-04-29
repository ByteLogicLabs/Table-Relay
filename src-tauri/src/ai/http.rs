//! Shared HTTP helpers for hosted AI providers.

use std::time::Duration;

use crate::ai::AiError;

/// The global shared reqwest client for AI calls. Re-used so TLS sessions
/// and connection pools are amortised across turns.
///
/// Timeout is set per-request (long for streaming responses), but we still
/// cap the initial TCP + TLS handshake so dead networks fail fast.
pub fn client() -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // No overall `timeout()` — the body of a streaming response takes
        // minutes on long completions. Each provider sets a read-level
        // timeout via `read_timeout` below on the response.
        .build()
        .map_err(|e| AiError::Other(format!("http client: {e}")))
}

/// Map `reqwest::Error` + HTTP status into the unified `AiError`.
///
/// Bodies from hosted providers are usually JSON like
/// `{ "error": { "code": 429, "message": "...", "status": "RESOURCE_EXHAUSTED" } }`.
/// We extract `error.message` so the chat panel shows a sentence instead
/// of pretty-printed JSON. The full body still ends up in `logs/chat.log`
/// because the caller logs the error there.
pub fn map_status(status: reqwest::StatusCode, body: &str) -> AiError {
    let msg = redact(&extract_error_message(body));
    match status.as_u16() {
        401 | 403 => AiError::Unauthorized(msg),
        429 => AiError::RateLimit(msg),
        400 if looks_like_context_overflow(body) => AiError::ContextTooLong,
        _ => AiError::Upstream(format!("HTTP {}: {}", status.as_u16(), msg)),
    }
}

/// Best-effort extract of a human-readable message from a provider error body.
/// Handles the common shapes:
///   - Google: `{ "error": { "message": "..." } }`
///   - OpenAI: `{ "error": { "message": "..." } }` (same key)
///   - Anthropic: `{ "error": { "message": "..." } }` (same key)
/// Falls back to the raw body (trimmed) if no message is found.
fn extract_error_message(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("error").and_then(|e| e.get("message")).and_then(|s| s.as_str()) {
            return m.trim().to_string();
        }
        if let Some(m) = v.get("message").and_then(|s| s.as_str()) {
            return m.trim().to_string();
        }
    }
    let trimmed = body.trim();
    if trimmed.len() > 240 {
        format!("{}…", &trimmed[..240])
    } else {
        trimmed.to_string()
    }
}

pub fn map_reqwest(err: reqwest::Error) -> AiError {
    if err.is_timeout() {
        return AiError::NetworkTimeout;
    }
    AiError::Upstream(err.to_string())
}

fn looks_like_context_overflow(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("context")
        && (lower.contains("token") || lower.contains("length") || lower.contains("window"))
}

/// Strip anything that looks like an API key or bearer token from a string
/// before it crosses back into the frontend. Defensive — providers shouldn't
/// echo keys in error bodies, but `Upstream(msg)` surfaces raw bodies to the
/// UI so scrub just in case.
pub fn redact(s: &str) -> String {
    // sk-… (OpenAI), sk-ant-… (Anthropic), AIza… (Google), plus generic
    // "Bearer <token>" patterns.
    let patterns = [
        ("sk-ant-", 8),
        ("sk-", 3),
        ("AIza", 4),
    ];
    let mut out = s.to_string();
    for (prefix, min_len) in patterns {
        while let Some(idx) = out.find(prefix) {
            let end = out[idx..]
                .char_indices()
                .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '-' && *c != '_')
                .map(|(i, _)| idx + i)
                .unwrap_or(out.len());
            if end - idx >= min_len {
                out.replace_range(idx..end, "<redacted>");
            } else {
                // Avoid infinite loop on short matches that don't extend.
                break;
            }
        }
    }
    // "Bearer xxx" → "Bearer <redacted>". Scan once — we advance the cursor
    // past each replacement to avoid re-matching the `<redacted>` we just
    // wrote.
    let mut cursor = 0usize;
    loop {
        let lower = out.to_ascii_lowercase();
        let Some(rel) = lower[cursor..].find("bearer ") else { break };
        let i = cursor + rel;
        let after = i + "bearer ".len();
        let end = out[after..]
            .char_indices()
            .find(|(_, c)| c.is_whitespace())
            .map(|(j, _)| after + j)
            .unwrap_or(out.len());
        if end > after {
            let token = &out[after..end];
            if token != "<redacted>" {
                out.replace_range(after..end, "<redacted>");
            }
            cursor = after + "<redacted>".len();
        } else {
            cursor = after;
        }
        if cursor >= out.len() {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_openai_key() {
        let s = "bad key sk-1234567890abcdef in body";
        assert!(!redact(s).contains("sk-1234"));
    }

    #[test]
    fn redacts_anthropic_key() {
        let s = "Authorization: sk-ant-api03-abcdef error";
        assert!(!redact(s).contains("sk-ant-api03"));
    }

    #[test]
    fn redacts_bearer_header() {
        let s = "Authorization: Bearer abcdef123 next";
        let r = redact(s);
        assert!(!r.contains("abcdef123"));
        assert!(r.contains("Bearer"));
    }

    #[test]
    fn context_overflow_detection() {
        assert!(looks_like_context_overflow("Your context window of 8192 tokens is exceeded"));
        assert!(!looks_like_context_overflow("Some other error"));
    }
}
