//! Minimal Server-Sent Events line reader. The SSE spec is small — we only
//! need the `data:` lines, `[DONE]` terminator, and blank-line-separated
//! events. All three hosted providers (OpenAI, Anthropic, Gemini) use this
//! shape; we parse provider-specific JSON at the call site.

use bytes::Bytes;
use futures::Stream;
use futures::StreamExt;

/// Consumes a byte stream and yields complete `data:` payloads as owned
/// `String`s. Handles chunks that split events — and multibyte characters —
/// across network reads: bytes are buffered and only whole lines are decoded.
///
/// Ends at the `[DONE]` sentinel without waiting for the server to close the
/// connection (some keep it open), or when the upstream closes.
pub fn data_lines<S, E>(upstream: S) -> impl Stream<Item = Result<String, String>>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    async_stream::try_stream! {
        let mut buf: Vec<u8> = Vec::new();
        let mut upstream = upstream;
        let mut done = false;
        while !done {
            match upstream.next().await {
                Some(chunk) => {
                    let chunk = chunk.map_err(|e| format!("sse read: {e}"))?;
                    buf.extend_from_slice(&chunk);
                }
                None => {
                    // Flush a final line that had no trailing newline.
                    if buf.is_empty() {
                        break;
                    }
                    buf.push(b'\n');
                    done = true;
                }
            }

            // Process every complete line in the buffer. Keep the trailing
            // partial line (if any) for the next chunk.
            let mut start = 0;
            while let Some(rel) = buf[start..].iter().position(|&b| b == b'\n') {
                let line_bytes = &buf[start..start + rel];
                start += rel + 1;
                // Providers emit UTF-8; a whole line that still isn't valid is a
                // provider bug — surface it instead of silently lossy-decoding.
                let line = std::str::from_utf8(line_bytes)
                    .map_err(|e| format!("sse utf8: {e}"))?
                    .trim_end_matches('\r');
                if let Some(rest) = line.strip_prefix("data:") {
                    let payload = rest.trim_start();
                    if payload == "[DONE]" {
                        done = true;
                        break;
                    }
                    if !payload.is_empty() {
                        yield payload.to_string();
                    }
                }
                // Ignore `event:`, `id:`, `retry:`, comments, blank lines.
            }
            buf.drain(..start);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    fn collect(chunks: Vec<&'static [u8]>) -> Vec<Result<String, String>> {
        let upstream = stream::iter(chunks.into_iter().map(|c| Ok::<_, String>(Bytes::from_static(c))));
        futures::executor::block_on(data_lines(upstream).collect::<Vec<_>>())
    }

    #[test]
    fn multibyte_character_split_across_reads() {
        // "—" is E2 80 94; split it between two network reads.
        let out = collect(vec![b"data: {\"t\":\"a\xE2\x80", b"\x94b\"}\n\n"]);
        assert_eq!(out, vec![Ok("{\"t\":\"a—b\"}".to_string())]);
    }

    #[test]
    fn events_split_across_reads_and_crlf() {
        let out = collect(vec![b"data: one\r\n\r\ndata: t", b"wo\r\n\r\n"]);
        assert_eq!(out, vec![Ok("one".into()), Ok("two".into())]);
    }

    #[test]
    fn stops_at_done_even_if_more_follows() {
        let out = collect(vec![b"data: x\n\ndata: [DONE]\n\ndata: after\n\n"]);
        assert_eq!(out, vec![Ok("x".into())]);
    }

    #[test]
    fn flushes_last_line_without_newline() {
        let out = collect(vec![b"event: message\ndata: tail"]);
        assert_eq!(out, vec![Ok("tail".into())]);
    }

    #[test]
    fn invalid_utf8_in_a_complete_line_is_an_error() {
        let out = collect(vec![b"data: \xFF\n"]);
        assert!(matches!(out.as_slice(), [Err(e)] if e.starts_with("sse utf8")));
    }
}
