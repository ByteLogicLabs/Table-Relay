//! Trait adapters use to persist SSH known-host fingerprints. The host
//! supplies an implementation at startup (today: SQLite-backed).
//!
//! Adapters receive an `Arc<dyn KnownHostsStore>` via their factory at
//! registration time — this avoids threading a `&dyn KnownHostsStore`
//! through every intent method on the `Adapter` trait.

use crate::AdapterError;

pub trait KnownHostsStore: Send + Sync {
    fn get(&self, host: &str, port: u16) -> Result<Option<String>, AdapterError>;
    fn insert(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), AdapterError>;
}
