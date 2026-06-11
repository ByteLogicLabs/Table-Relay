//! Pub/sub subscription driver. Opens a dedicated Redis connection
//! (the multiplexed command connection can't be put into subscriber
//! mode) and pumps messages into a caller-owned mpsc sink.
//!
//! Pattern semantics: if `req.pattern` contains a glob metacharacter
//! (`*`, `?`, `[`), we issue PSUBSCRIBE; otherwise SUBSCRIBE. Users
//! don't have to pick between them manually.

use std::time::{SystemTime, UNIX_EPOCH};

use adapter_api::log_line;
use adapter_api::{AdapterError, SubscribeEvent, SubscribeRequest, SubscriptionHandle};
use futures::StreamExt;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc::UnboundedSender;

use crate::redis::map_err;
use crate::RedisDriver;

pub(crate) async fn subscribe(
    driver: &RedisDriver,
    req: SubscribeRequest,
    sink: UnboundedSender<SubscribeEvent>,
) -> Result<SubscriptionHandle, AdapterError> {
    let pattern = req.pattern.trim();
    if pattern.is_empty() {
        return Err(AdapterError::Other(
            "subscribe pattern cannot be empty".into(),
        ));
    }
    let is_glob = pattern.contains('*') || pattern.contains('?') || pattern.contains('[');

    let mut pubsub = driver
        .client
        .get_async_pubsub()
        .await
        .map_err(map_err)?;

    if is_glob {
        pubsub.psubscribe(pattern).await.map_err(map_err)?;
    } else {
        pubsub.subscribe(pattern).await.map_err(map_err)?;
    }

    log_line!(
        "redis_subscribe",
        "pattern={:?} kind={}",
        pattern,
        if is_glob { "PSUBSCRIBE" } else { "SUBSCRIBE" }
    );

    let (handle, mut cancel_rx) = SubscriptionHandle::new();
    let announce_pattern = if is_glob { Some(pattern.to_string()) } else { None };

    tokio::spawn(async move {
        let mut stream = pubsub.into_on_message();
        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    log_line!("redis_subscribe", "cancelled");
                    break;
                }
                next = stream.next() => {
                    let Some(msg) = next else { break };
                    let payload = decode_payload(msg.get_payload_bytes());
                    let event = SubscribeEvent {
                        channel: msg.get_channel_name().to_string(),
                        pattern: announce_pattern.clone(),
                        payload,
                        received_at_ms: now_ms(),
                        extras: Default::default(),
                    };
                    if sink.send(event).is_err() {
                        // Receiver dropped — host cancelled or the
                        // webview closed. Teardown below handles the
                        // PubSub cleanup.
                        break;
                    }
                }
            }
        }
        // Dropping `stream` (and the PubSub it was built from) closes
        // the underlying connection; no explicit UNSUBSCRIBE needed.
        drop(stream);
    });

    Ok(handle)
}

fn decode_payload(bytes: &[u8]) -> JsonValue {
    if adapter_api::looks_binary(bytes) {
        JsonValue::String(adapter_api::bytes_to_hex_upper(bytes))
    } else {
        JsonValue::String(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
