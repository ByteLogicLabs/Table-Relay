//! Minimal Server-Sent Events line reader. The SSE spec is small — we only
//! need the `data:` lines, `[DONE]` terminator, and blank-line-separated
//! events. All three hosted providers (OpenAI, Anthropic, Gemini) use this
//! shape; we parse provider-specific JSON at the call site.

use bytes::Bytes;
use futures::Stream;
use futures::StreamExt;

/// Consumes a byte stream and yields complete `data:` payloads as owned
/// `String`s. Handles chunks that split events across boundaries (which
/// happens all the time with network reads).
///
/// Emits `None` when the upstream closes. `[DONE]` sentinel lines are
/// dropped — callers treat stream end and `[DONE]` identically.
pub fn data_lines<S, E>(upstream: S) -> impl Stream<Item = Result<String, String>>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    async_stream::try_stream! {
        let mut buf = String::new();
        let mut upstream = upstream;
        while let Some(chunk) = upstream.next().await {
            let chunk = chunk.map_err(|e| format!("sse read: {e}"))?;
            // Providers emit UTF-8; non-UTF-8 bytes inside a token are a
            // provider bug — surface it instead of silently lossy-decoding.
            let text = std::str::from_utf8(&chunk)
                .map_err(|e| format!("sse utf8: {e}"))?;
            buf.push_str(text);

            // Process every complete line in the buffer. Keep the trailing
            // partial line (if any) for the next chunk.
            while let Some(newline) = buf.find('\n') {
                let line = buf[..newline].trim_end_matches('\r').to_string();
                buf.drain(..=newline);
                if let Some(rest) = line.strip_prefix("data:") {
                    let payload = rest.trim_start();
                    if payload.is_empty() || payload == "[DONE]" {
                        continue;
                    }
                    yield payload.to_string();
                }
                // Ignore `event:`, `id:`, `retry:`, comments, blank lines.
            }
        }
    }
}
