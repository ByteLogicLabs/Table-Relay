//! Built-in adapter enrollment.
//!
//! The actual list lives in `adapters.toml` at the crate root; `build.rs`
//! parses it and emits `$OUT_DIR/registered_adapters.rs` with the body of
//! `register_all`. This file is just the thin shell that wires up
//! `KnownHostsStore` and delegates. Adding a new built-in adapter means
//! editing `adapters.toml` + the path-dep in `Cargo.toml` — no code
//! changes here.

use std::sync::Arc;

use crate::db::adapter_registry::FactoryRegistry;
use crate::ssh::known_hosts::KnownHostsSqlite;
use crate::store::Store;

include!(concat!(env!("OUT_DIR"), "/registered_adapters.rs"));

/// Register every compile-time-known adapter with `factories`. Call once
/// at app startup after the store is open.
pub fn register_builtins(factories: &FactoryRegistry, store: &Arc<Store>) {
    let known_hosts: Arc<dyn adapter_api::ssh_hosts::KnownHostsStore> =
        Arc::new(KnownHostsSqlite::new(store.clone()));
    register_all(factories, known_hosts);
}
