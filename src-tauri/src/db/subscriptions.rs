//! Global registry of active subscriptions.
//!
//! Each entry owns an `adapter_api::SubscriptionHandle` plus enough
//! metadata to describe it in logs. `cancel(id)` drops the handle,
//! which fires the oneshot the adapter's pump task is awaiting — no
//! explicit UNSUBSCRIBE / UNLISTEN / etc. needed on the adapter side.
//!
//! IDs are UUIDv4s so the frontend can issue the subscribe + cancel
//! commands independently of each other; no global counter to race on.

use std::collections::HashMap;

use adapter_api::SubscriptionHandle;
use tokio::sync::Mutex;

pub struct SubscriptionEntry {
    pub connection_id: String,
    pub handle: SubscriptionHandle,
}

pub struct SubscriptionRegistry {
    inner: Mutex<HashMap<String, SubscriptionEntry>>,
}

impl SubscriptionRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, id: String, entry: SubscriptionEntry) {
        self.inner.lock().await.insert(id, entry);
    }

    /// Remove + cancel. Returns whether an entry was present.
    pub async fn cancel(&self, id: &str) -> bool {
        if let Some(entry) = self.inner.lock().await.remove(id) {
            entry.handle.cancel();
            true
        } else {
            false
        }
    }

    /// Cancel every subscription bound to a specific connection. Used
    /// when the connection is being disconnected so we don't leak
    /// pubsub sockets.
    pub async fn cancel_for_connection(&self, connection_id: &str) {
        let mut guard = self.inner.lock().await;
        let ids: Vec<String> = guard
            .iter()
            .filter(|(_, e)| e.connection_id == connection_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            if let Some(entry) = guard.remove(&id) {
                entry.handle.cancel();
            }
        }
    }
}

impl Default for SubscriptionRegistry {
    fn default() -> Self {
        Self::new()
    }
}
