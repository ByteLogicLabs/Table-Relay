//! Shared HTTP helpers for hosted AI providers.

use std::sync::OnceLock;
use std::time::Duration;

use crate::ai::AiError;

/// Longest a hosted provider may stay completely silent — no response head,
/// no stream bytes — before the request fails as a network timeout (which the
/// tool loop retries). Generous because reasoning models can think for minutes
/// before the first byte; without any read timeout a dropped connection (sleep
/// / resume, Wi-Fi change, a proxy closing an idle socket) left the turn
/// waiting forever and every later message queued behind it.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Idle limit for a model served from this machine (llama-server, Ollama, LM
/// Studio). Prompt processing on a CPU can take many minutes before the first
/// byte, and there is no network in between to drop the connection.
const LOCAL_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(1800);

/// Overall cap for a non-streaming round-trip (`complete_once`) to a hosted
/// provider, whose whole body only arrives once generation finishes.
pub const NON_STREAMING_TIMEOUT: Duration = Duration::from_secs(600);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static LOCAL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Whether `url` points at a server on this machine.
pub fn is_local_url(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?']).next().unwrap_or("");
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    // Drop the port; keep a bracketed IPv6 literal whole.
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    let name = name.to_ascii_lowercase();
    name == "localhost" || name == "::1" || name == "0.0.0.0" || name.starts_with("127.")
}

/// Client for `url`: the shared hosted-provider client, or one with a much
/// longer idle limit for models served locally.
pub fn client_for_url(url: &str) -> Result<reqwest::Client, AiError> {
    if is_local_url(url) {
        build_cached(&LOCAL_CLIENT, LOCAL_READ_IDLE_TIMEOUT)
    } else {
        client()
    }
}

/// The global shared reqwest client for AI calls. Re-used so TLS sessions
/// and connection pools are amortised across turns.
pub fn client() -> Result<reqwest::Client, AiError> {
    build_cached(&CLIENT, READ_IDLE_TIMEOUT)
}

fn build_cached(cell: &OnceLock<reqwest::Client>, read_idle: Duration) -> Result<reqwest::Client, AiError> {
    if let Some(c) = cell.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        // Cap the TCP+TLS handshake so a dead network fails fast, but keep it
        // generous: 15s was tight enough that a momentarily slow provider or
        // congested link surfaced as a spurious "network timeout" mid-chat.
        // 30s tolerates a slow handshake without making a truly dead host hang.
        .connect_timeout(Duration::from_secs(30))
        // No overall `timeout()` here — a streaming body legitimately takes
        // minutes. Instead every read (response head and each stream chunk)
        // must make progress within `read_idle`, and TCP keepalive notices a
        // peer that vanished without closing the socket.
        .read_timeout(read_idle)
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|e| AiError::Other(format!("http client: {e}")))?;
    Ok(cell.get_or_init(|| built).clone())
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
        format!("{}…", crate::ai::clip_str(trimmed, 240))
    } else {
        trimmed.to_string()
    }
}

pub fn map_reqwest(err: reqwest::Error) -> AiError {
    if err.is_timeout() {
        return AiError::NetworkTimeout;
    }
    // reqwest's message embeds the request URL, which can carry credentials
    // (query-string keys, userinfo); the message goes to the UI and logs. Keep
    // the endpoint itself — "connection refused" is useless without it.
    let target = err.url().map(|u| {
        let mut u = u.clone();
        u.set_query(None);
        let _ = u.set_username("");
        let _ = u.set_password(None);
        u.to_string()
    });
    let msg = err.without_url().to_string();
    AiError::Upstream(redact(&match target {
        Some(t) => format!("{msg} ({t})"),
        None => msg,
    }))
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
    fn local_urls_are_detected() {
        assert!(is_local_url("http://localhost:8080/v1"));
        assert!(is_local_url("http://127.0.0.1:11434/v1"));
        assert!(is_local_url("http://[::1]:1234/v1"));
        assert!(is_local_url("http://user:pw@localhost/v1"));
        assert!(!is_local_url("https://api.openai.com/v1"));
        assert!(!is_local_url("https://localhost.example.com/v1"));
        assert!(!is_local_url("https://api.groq.com/openai/v1?x=localhost"));
    }

    #[test]
    fn long_non_json_error_body_is_clipped_on_a_char_boundary() {
        // 239 ASCII bytes then a 3-byte em-dash straddling byte 240.
        let body = format!("{}—tail", "x".repeat(239));
        let msg = extract_error_message(&body);
        assert!(msg.ends_with('…'));
        assert!(msg.starts_with(&"x".repeat(239)));
    }

    #[test]
    fn context_overflow_detection() {
        assert!(looks_like_context_overflow("Your context window of 8192 tokens is exceeded"));
        assert!(!looks_like_context_overflow("Some other error"));
    }
}
