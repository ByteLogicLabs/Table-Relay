//! Factory for the Redis adapter. Like the SQLite factory, it takes no
//! `KnownHostsStore` — there's no SSH tunnel support in the first cut.

use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use async_trait::async_trait;

use crate::adapter::RedisAdapter;
use crate::{RedisConfig, RedisDriver, MANIFEST};

pub struct RedisFactory;

impl RedisFactory {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RedisFactory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Factory for RedisFactory {
    fn manifest(&self) -> &'static AdapterManifest {
        &MANIFEST
    }

    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> Result<Arc<dyn Adapter>, AdapterError> {
        // The frontend stores `database` as a string ("0" / "3"); accept
        // integer-parseable values and default to 0 otherwise.
        let database = profile
            .database
            .as_deref()
            .and_then(|s| s.trim().parse::<u32>().ok());

        let driver = RedisDriver::connect(RedisConfig {
            host: profile.host.clone(),
            port: profile.port,
            user: profile.user.clone(),
            password: profile.password.clone(),
            database,
        })
        .await?;
        Ok(Arc::new(RedisAdapter::new(driver)))
    }
}
