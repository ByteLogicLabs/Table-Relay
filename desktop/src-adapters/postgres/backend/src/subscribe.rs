//! `Adapter::subscribe` for PostgreSQL — thin wrapper over sqlx's
//! `PgListener` (which implements `LISTEN` / `UNLISTEN` / recv over one
//! dedicated connection).
//!
//! The subscribe request pattern is interpreted as a channel name. PG
//! channel names are plain identifiers (no wildcards), so this is
//! simpler than the Redis path — one channel per subscription.
//! Multi-channel subscriptions are a follow-up; users open multiple
//! realtime tabs today if they need several.

use std::time::{SystemTime, UNIX_EPOCH};

use adapter_api::log_line;
use adapter_api::{AdapterError, SubscribeEvent, SubscribeRequest, SubscriptionHandle};
use serde_json::{json, Value as JsonValue};
use sqlx::postgres::PgListener;
use tokio::sync::mpsc::UnboundedSender;

use crate::PostgresDriver;

pub(crate) async fn subscribe(
    driver: &PostgresDriver,
    req: SubscribeRequest,
    sink: UnboundedSender<SubscribeEvent>,
) -> Result<SubscriptionHandle, AdapterError> {
    let channel = req.pattern.trim();
    if channel.is_empty() {
        return Err(AdapterError::Other(
            "subscribe pattern (channel name) cannot be empty".into(),
        ));
    }
    // PG `LISTEN` doesn't support wildcards; surface that to the user
    // early instead of silently subscribing to a literal `*` channel
    // nobody will publish on.
    if channel.contains('*') || channel.contains('?') {
        return Err(AdapterError::Unsupported(
            "Postgres LISTEN channels are literal identifiers; wildcards aren't supported. \
             Pass an exact channel name (e.g. `events_user_created`)."
                .into(),
        ));
    }

    let mut listener = PgListener::connect_with(&driver.pool)
        .await
        .map_err(AdapterError::from)?;
    listener
        .listen(channel)
        .await
        .map_err(AdapterError::from)?;

    log_line!("pg_subscribe", "LISTEN {channel}");

    let (handle, mut cancel_rx) = SubscriptionHandle::new();
    let channel_owned = channel.to_string();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    log_line!("pg_subscribe", "cancelled");
                    break;
                }
                next = listener.recv() => {
                    match next {
                        Ok(notif) => {
                            let event = SubscribeEvent {
                                channel: notif.channel().to_string(),
                                pattern: None,
                                payload: decode_payload(notif.payload()),
                                received_at_ms: now_ms(),
                                extras: extras_from(notif.process_id()),
                            };
                            if sink.send(event).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            // The listener's background task will already
                            // have logged the underlying error; we stop
                            // pumping events and let the frontend notice
                            // the stream ending.
                            log_line!("pg_subscribe", "recv error on {channel_owned}: {e}");
                            break;
                        }
                    }
                }
            }
        }
        // Dropping `listener` closes the dedicated connection cleanly —
        // no explicit UNLISTEN needed.
        drop(listener);
    });

    Ok(handle)
}

fn decode_payload(raw: &str) -> JsonValue {
    // PG NOTIFY payloads are always UTF-8 strings ≤ 8000 bytes. We
    // pass them through as a plain JSON string; upstream callers that
    // want structured data publish JSON themselves.
    JsonValue::String(raw.to_string())
}

fn extras_from(pid: u32) -> std::collections::BTreeMap<String, JsonValue> {
    let mut m = std::collections::BTreeMap::new();
    // The PID of the backend that issued the NOTIFY. Useful when
    // debugging "who sent this?".
    m.insert("pid".to_string(), json!(pid));
    m
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
