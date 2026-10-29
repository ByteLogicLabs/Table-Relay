//! Host-side adapter between the app's SQLite store and the
//! `KnownHostsStore` trait SSH tunnels expect. The `ssh_known_hosts`
//! table migration lives in `store/mod.rs`; this file just implements
//! the trait.

use std::sync::Arc;

use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::AdapterError;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use crate::store::Store;

/// Owning variant: holds an `Arc<Store>` so the factory can keep a
/// `'static` trait object without borrowing lifetimes.
pub struct KnownHostsSqlite {
    store: Arc<Store>,
}

impl KnownHostsSqlite {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }
}

impl KnownHostsStore for KnownHostsSqlite {
    fn get(&self, host: &str, port: u16) -> Result<Option<String>, AdapterError> {
        self.store
            .with_conn(false, |guard| {
                guard
                    .query_row(
                        "SELECT fingerprint FROM ssh_known_hosts WHERE host = ?1 AND port = ?2",
                        params![host, port as i64],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(crate::store::StoreError::Sqlite)
            })
            .map_err(|e| AdapterError::SshTunnel(format!("known_hosts read: {e}")))
    }

    fn insert(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), AdapterError> {
        self.store
            .with_conn(true, |guard| {
                guard
                    .execute(
                        "INSERT INTO ssh_known_hosts (host, port, fingerprint, accepted_at)
                 VALUES (?1, ?2, ?3, ?4)",
                        params![host, port as i64, fingerprint, Utc::now().timestamp()],
                    )
                    .map(|_| ())
                    .map_err(crate::store::StoreError::Sqlite)
            })
            .map_err(|e| AdapterError::SshTunnel(format!("known_hosts write: {e}")))?;
        Ok(())
    }
}
