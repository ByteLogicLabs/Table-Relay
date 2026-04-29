use std::time::{SystemTime, UNIX_EPOCH};

use adapter_api::log_line;
use adapter_api::{AdapterError, SubscribeEvent, SubscribeRequest, SubscriptionHandle};
use futures::TryStreamExt;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc::UnboundedSender;

use crate::MongoDriver;
use crate::mongo::map_err;

pub(crate) async fn subscribe(
    driver: &MongoDriver,
    req: SubscribeRequest,
    sink: UnboundedSender<SubscribeEvent>,
) -> Result<SubscriptionHandle, AdapterError> {
    let (schema, coll_pattern) = parse_pattern(req.schema, req.pattern)?;
    let db = driver.query_db(schema.as_deref())?;
    let db_name = db.name().to_string();

    // Mongo change streams require replica set / sharded cluster.
    let mut stream = db.watch(None, None).await.map_err(map_err)?;
    let (handle, mut cancel_rx) = SubscriptionHandle::new();
    let glob = coll_pattern.to_string();
    let announce_pattern = Some(glob.clone());

    log_line!("mongo_subscribe", "WATCH {}.{}", db_name, glob);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    log_line!("mongo_subscribe", "cancelled");
                    break;
                }
                next = stream.try_next() => {
                    match next {
                        Ok(Some(ev)) => {
                            let coll = ev
                                .ns
                                .as_ref()
                                .and_then(|ns| ns.coll.as_deref())
                                .unwrap_or("");
                            if !glob_match(&glob, coll) {
                                continue;
                            }
                            let channel = if coll.is_empty() {
                                db_name.clone()
                            } else {
                                format!("{db_name}.{coll}")
                            };
                            let payload = serde_json::to_value(&ev)
                                .unwrap_or_else(|_| JsonValue::String(format!("{ev:?}")));
                            let mut extras = std::collections::BTreeMap::new();
                            extras.insert("db".to_string(), JsonValue::String(db_name.clone()));
                            if !coll.is_empty() {
                                extras.insert("collection".to_string(), JsonValue::String(coll.to_string()));
                            }
                            let op_type = format!("{:?}", ev.operation_type);
                            extras.insert("op".to_string(), JsonValue::String(op_type));
                            let event = SubscribeEvent {
                                channel,
                                pattern: announce_pattern.clone(),
                                payload,
                                received_at_ms: now_ms(),
                                extras,
                            };
                            if sink.send(event).is_err() {
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log_line!("mongo_subscribe", "stream error: {e}");
                            break;
                        }
                    }
                }
            }
        }
        drop(stream);
    });

    Ok(handle)
}

fn parse_pattern(
    schema: Option<String>,
    pattern: String,
) -> Result<(Option<String>, String), AdapterError> {
    let p = pattern.trim();
    if p.is_empty() {
        return Err(AdapterError::Other(
            "subscribe pattern cannot be empty".into(),
        ));
    }
    if p.contains('.') && schema.is_none() {
        let mut parts = p.splitn(2, '.');
        let db = parts.next().unwrap_or_default().trim();
        let coll = parts.next().unwrap_or_default().trim();
        if db.is_empty() || coll.is_empty() {
            return Err(AdapterError::Syntax {
                message: "Mongo realtime pattern with `db.collection` requires both parts".to_string(),
                line: None,
                column: None,
            });
        }
        return Ok((Some(db.to_string()), coll.to_string()));
    }
    Ok((schema, p.to_string()))
}

// Minimal glob matcher: supports `*` and `?`. Character classes aren't needed
// for Mongo collection names in our UI flow.
fn glob_match(glob: &str, text: &str) -> bool {
    let g = glob.as_bytes();
    let t = text.as_bytes();
    let (mut i, mut j) = (0usize, 0usize);
    let (mut star_i, mut star_j) = (None::<usize>, 0usize);

    while j < t.len() {
        if i < g.len() && (g[i] == b'?' || g[i] == t[j]) {
            i += 1;
            j += 1;
        } else if i < g.len() && g[i] == b'*' {
            star_i = Some(i);
            i += 1;
            star_j = j;
        } else if let Some(si) = star_i {
            i = si + 1;
            star_j += 1;
            j = star_j;
        } else {
            return false;
        }
    }
    while i < g.len() && g[i] == b'*' {
        i += 1;
    }
    i == g.len()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_db_collection_splits() {
        let (db, coll) = parse_pattern(None, "clipbridge.systemevents".to_string()).expect("ok");
        assert_eq!(db.as_deref(), Some("clipbridge"));
        assert_eq!(coll, "systemevents");
    }

    #[test]
    fn glob_match_basics() {
        assert!(glob_match("*", "users"));
        assert!(glob_match("sys*", "systemevents"));
        assert!(glob_match("pairing?essions", "pairingsessions"));
        assert!(!glob_match("clip*", "systemevents"));
    }
}

