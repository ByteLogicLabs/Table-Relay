//! Per-request cancellation for chat turns.
//!
//! Stop used to reach only `provider.cancel()`, which is a no-op for every
//! HTTP provider — the turn kept streaming, running tools and waiting on
//! approvals in the background while holding the session's send lock, so the
//! next message sat behind it. Now each `ai_chat_send` registers a token under
//! its request id; `ai_chat_stop` trips it, and every long wait in the turn
//! (stream reads, retries, approvals, the send lock) races against it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// A cheap, clonable "stop requested" flag that can also be awaited.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<Inner>);

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel()` has been called (immediately if it already was).
    pub async fn cancelled(&self) {
        loop {
            // Register before checking the flag: a `Notified` future receives
            // `notify_waiters()` from the moment it is created, so a cancel
            // between the check and the await can't be missed.
            let notified = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Drive `fut` unless the turn is stopped first: `None` means it was, and
    /// `fut` has been dropped (closing whatever connection it held).
    pub async fn run<F: std::future::Future>(&self, fut: F) -> Option<F::Output> {
        tokio::select! {
            biased;
            _ = self.cancelled() => None,
            v = fut => Some(v),
        }
    }
}

/// Tokens of the turns currently in flight, keyed by request id.
#[derive(Default)]
pub struct CancelRegistry {
    tokens: Mutex<HashMap<String, CancelToken>>,
}

/// Stops a stale "cancelled before it started" entry from living forever when
/// its send never arrives.
const MAX_ENTRIES: usize = 256;

impl CancelRegistry {
    /// Token for `request_id`, registered until the returned guard is dropped.
    /// A Stop that raced ahead of its own send is honoured: the token comes
    /// back already cancelled.
    pub fn register(self: &Arc<Self>, request_id: &str) -> (CancelToken, CancelGuard) {
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        let token = tokens.entry(request_id.to_string()).or_default().clone();
        let guard = CancelGuard { registry: self.clone(), request_id: request_id.to_string() };
        (token, guard)
    }

    /// Trip the token for `request_id`. Returns whether a turn was running.
    pub fn cancel(&self, request_id: &str) -> bool {
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = tokens.get(request_id) {
            token.cancel();
            return true;
        }
        if tokens.len() >= MAX_ENTRIES {
            tokens.retain(|_, t| !t.is_cancelled());
        }
        let token = CancelToken::default();
        token.cancel();
        tokens.insert(request_id.to_string(), token);
        false
    }
}

/// Unregisters the request's token when the turn ends, however it ends.
pub struct CancelGuard {
    registry: Arc<CancelRegistry>,
    request_id: String,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut tokens = self.registry.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.remove(&self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancel_wakes_a_waiter() {
        let registry = Arc::new(CancelRegistry::default());
        let (token, _guard) = registry.register("r1");
        let waiter = tokio::spawn({
            let token = token.clone();
            async move { token.cancelled().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(registry.cancel("r1"));
        tokio::time::timeout(Duration::from_secs(1), waiter).await.expect("woken").unwrap();
    }

    #[tokio::test]
    async fn stop_before_send_is_honoured() {
        let registry = Arc::new(CancelRegistry::default());
        assert!(!registry.cancel("early"));
        let (token, _guard) = registry.register("early");
        assert!(token.is_cancelled());
        tokio::time::timeout(Duration::from_millis(100), token.cancelled()).await.expect("already cancelled");
    }

    #[tokio::test]
    async fn guard_unregisters_on_drop() {
        let registry = Arc::new(CancelRegistry::default());
        {
            let (_token, _guard) = registry.register("r2");
            assert_eq!(registry.tokens.lock().unwrap().len(), 1);
        }
        assert!(registry.tokens.lock().unwrap().is_empty());
    }
}
