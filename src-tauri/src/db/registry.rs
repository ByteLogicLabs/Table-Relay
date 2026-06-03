//! Active-connection registry keyed by connection id.
//!
//! One entry per live adapter. The entry also holds the profile the
//! adapter was built from (used by the reconnect supervisor to rebuild
//! without a store round-trip) and a per-id mutex that serializes
//! reconnect attempts so two failing queries don't rebuild the adapter
//! twice.
//!
//! SSH tunnels are no longer tracked here — each `Adapter` owns its
//! tunnel internally (see `MysqlAdapter::shutdown`) and tears it down
//! when `shutdown()` is called, so the registry only needs to reach the
//! trait object.

use std::collections::HashMap;
use std::sync::Arc;

use adapter_api::{Adapter, AdapterError, AdapterManifest, ServerInfo};
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

use crate::store::repo::ConnectionProfile;

pub type ConnectionId = String;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMeta {
    pub id: ConnectionId,
    pub server: ServerInfo,
}

pub struct ActiveConnection {
    pub adapter: Arc<dyn Adapter>,
    pub meta: ConnectionMeta,
    /// Snapshot of the profile used to open this connection. Kept so the
    /// reconnect supervisor can rebuild without a store round-trip (and
    /// without racing a profile edit).
    pub profile: ConnectionProfile,
    /// Factory manifest for this adapter. Stored so downstream code
    /// (AI context, capability gates) can reach manifest fields without
    /// re-resolving the factory from a name on every access.
    pub manifest: &'static AdapterManifest,
}

pub struct Registry {
    inner: RwLock<HashMap<ConnectionId, ActiveConnection>>,
    /// Per-connection mutex the reconnect supervisor holds so two
    /// concurrent commands on the same id don't race to rebuild.
    reconnect_locks: Mutex<HashMap<ConnectionId, Arc<Mutex<()>>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            reconnect_locks: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, id: ConnectionId, entry: ActiveConnection) {
        self.inner.write().await.insert(id, entry);
    }

    pub async fn get(&self, id: &str) -> Result<Arc<dyn Adapter>, AdapterError> {
        self.inner
            .read()
            .await
            .get(id)
            .map(|c| c.adapter.clone())
            .ok_or_else(|| AdapterError::NotFound(format!("connection {id} is not active")))
    }

    pub async fn profile(&self, id: &str) -> Result<ConnectionProfile, AdapterError> {
        self.inner
            .read()
            .await
            .get(id)
            .map(|c| c.profile.clone())
            .ok_or_else(|| AdapterError::NotFound(format!("connection {id} is not active")))
    }

    /// The `ConnectionMeta` (server info) captured when this connection was
    /// established. `None` if not active. Lets `db_connect` return an existing
    /// live connection without re-running the handshake.
    pub async fn meta(&self, id: &str) -> Option<ConnectionMeta> {
        self.inner.read().await.get(id).map(|c| c.meta.clone())
    }

    /// Manifest of the adapter backing this connection. The manifest
    /// is `&'static`, so this is cheap — no clone, no dyn lookup.
    pub async fn manifest(&self, id: &str) -> Result<&'static AdapterManifest, AdapterError> {
        self.inner
            .read()
            .await
            .get(id)
            .map(|c| c.manifest)
            .ok_or_else(|| AdapterError::NotFound(format!("connection {id} is not active")))
    }

    /// Swap in a freshly-rebuilt adapter after a reconnect. The old
    /// adapter is shut down so its pool + tunnel free immediately.
    pub async fn replace(
        &self,
        id: &str,
        adapter: Arc<dyn Adapter>,
        meta: ConnectionMeta,
    ) -> Result<(), AdapterError> {
        let mut guard = self.inner.write().await;
        let Some(entry) = guard.get_mut(id) else {
            return Err(AdapterError::NotFound(format!("connection {id} is not active")));
        };
        let old = std::mem::replace(&mut entry.adapter, adapter);
        entry.meta = meta;
        drop(guard);
        old.shutdown().await;
        Ok(())
    }

    /// Like `replace`, but also updates the in-memory `profile` snapshot.
    /// Used by `db_switch_database` where we point the adapter at a new
    /// database so subsequent automatic reconnects rebuild with the same
    /// target instead of the original.
    pub async fn replace_with_profile(
        &self,
        id: &str,
        adapter: Arc<dyn Adapter>,
        meta: ConnectionMeta,
        profile: ConnectionProfile,
    ) -> Result<(), AdapterError> {
        let mut guard = self.inner.write().await;
        let Some(entry) = guard.get_mut(id) else {
            return Err(AdapterError::NotFound(format!("connection {id} is not active")));
        };
        let old = std::mem::replace(&mut entry.adapter, adapter);
        entry.meta = meta;
        entry.profile = profile;
        drop(guard);
        old.shutdown().await;
        Ok(())
    }

    /// Acquire the per-id reconnect mutex. The returned guard serializes
    /// reconnect attempts so two failed queries don't rebuild twice.
    pub async fn reconnect_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.reconnect_locks
            .lock()
            .await
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn remove(&self, id: &str) -> Result<(), AdapterError> {
        let removed = { self.inner.write().await.remove(id) };
        { self.reconnect_locks.lock().await.remove(id); }
        match removed {
            Some(c) => {
                c.adapter.shutdown().await;
                Ok(())
            }
            None => Err(AdapterError::NotFound(format!("connection {id} is not active"))),
        }
    }

    pub async fn list(&self) -> Vec<ConnectionMeta> {
        self.inner.read().await.values().map(|c| c.meta.clone()).collect()
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}
