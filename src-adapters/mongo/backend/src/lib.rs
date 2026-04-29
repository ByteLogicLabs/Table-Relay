//! Built-in MongoDB adapter. `MANIFEST` is generated at build time
//! from `adapter.toml` + `templates/ai_system_context.md`.

pub mod adapter;
pub mod execute;
pub mod factory;
pub mod index;
pub mod mongo;
pub mod mutate;
pub mod subscribe;

include!(concat!(env!("OUT_DIR"), "/manifest_generated.rs"));

pub use adapter::MongoAdapter;
pub use factory::MongoFactory;
pub use mongo::{MongoConfig, MongoDriver};
