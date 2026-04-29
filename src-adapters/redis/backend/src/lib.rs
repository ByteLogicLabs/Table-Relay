//! Built-in Redis adapter. `MANIFEST` is generated at build time from
//! `adapter.toml` + `templates/ai_system_context.md`.

pub mod adapter;
pub mod browse;
pub mod execute;
pub mod factory;
pub mod mutate;
pub mod redis;
pub mod subscribe;

include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));

pub use adapter::RedisAdapter;
pub use factory::RedisFactory;
pub use redis::{RedisConfig, RedisDriver};
