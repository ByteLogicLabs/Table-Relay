//! Host-side database plumbing — lives above the adapter trait.
//!
//! - `registry`: active-connection registry keyed by connection id.
//! - `adapter_registry`: factory lookup by adapter kind.
//! - `reconnect`: transparent reconnect supervisor wrapping adapter calls.
//! - `builtin`: `register_builtins()` — the one file that names every
//!    first-party adapter crate.

pub mod adapter_registry;
pub mod builtin;
pub mod reconnect;
pub mod registry;
pub mod subscriptions;
