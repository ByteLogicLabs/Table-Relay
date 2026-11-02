//! Built-in MySQL adapter.
//!
//! `MANIFEST` is generated at build time from `adapter.toml` +
//! `templates/ai_system_context.md`.

pub mod adapter;
pub mod analyze;
pub mod browse;
pub mod factory;
pub mod mutate;
pub mod mysql;

include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));

pub use adapter::MysqlAdapter;
pub use factory::MysqlFactory;
pub use mysql::{MysqlConfig, MysqlDriver};
pub use adapter_ssh::{SshConfig, Tunnel};
