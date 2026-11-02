//! Built-in SQLite adapter.
//!
//! Opens a single `.db` / `.sqlite` file (or `:memory:`) and exposes
//! it through the adapter-api. SQLite has no notion of "host/port/user"
//! — the `ConnectionProfile::database` field carries the file path.
//! `MANIFEST` is generated at build time from `adapter.toml`.

pub mod adapter;
pub mod browse;
pub mod factory;
pub mod mutate;
pub mod sqlite;

include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));

pub use adapter::SqliteAdapter;
pub use factory::SqliteFactory;
pub use sqlite::{SqliteConfig, SqliteDriver};
