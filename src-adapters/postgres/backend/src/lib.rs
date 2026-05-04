//! Built-in PostgreSQL adapter.
//!
//! `MANIFEST` is generated at build time from `adapter.toml` +
//! `templates/ai_system_context.md`. See `build.rs`.

pub mod adapter;
pub mod analyze;
pub mod browse;
pub mod factory;
pub mod mutate;
pub mod postgres;
pub mod subscribe;

include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));

pub use adapter::PostgresAdapter;
pub use factory::PostgresFactory;
pub use postgres::{PostgresConfig, PostgresDriver};
