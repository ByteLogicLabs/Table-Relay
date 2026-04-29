use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use async_trait::async_trait;

use crate::adapter::MongoAdapter;
use crate::{MongoConfig, MongoDriver, MANIFEST};

pub struct MongoFactory;

impl MongoFactory {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MongoFactory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Factory for MongoFactory {
    fn manifest(&self) -> &'static AdapterManifest {
        &MANIFEST
    }

    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> Result<Arc<dyn Adapter>, AdapterError> {
        let cfg = MongoConfig {
            host: profile.host,
            port: profile.port,
            user: profile.user,
            password: profile.password,
            database: profile.database,
            ssl_mode: profile.ssl_mode,
        };
        let driver = MongoDriver::connect(cfg).await?;
        Ok(Arc::new(MongoAdapter::new(driver)))
    }
}
