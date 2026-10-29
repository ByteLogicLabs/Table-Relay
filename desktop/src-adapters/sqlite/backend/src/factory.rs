//! `Factory` for the SQLite adapter. Unlike the MySQL factory, this one
//! needs no `KnownHostsStore` — SQLite is a local file open, not a
//! network dial.

use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use async_trait::async_trait;

use crate::adapter::SqliteAdapter;
use crate::{SqliteConfig, SqliteDriver, MANIFEST};

pub struct SqliteFactory;

impl SqliteFactory {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SqliteFactory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Factory for SqliteFactory {
    fn manifest(&self) -> &'static AdapterManifest {
        &MANIFEST
    }

    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> Result<Arc<dyn Adapter>, AdapterError> {
        // The manifest declares a single required field: `database`, the
        // path to the .db file. We read it from `profile.database` first
        // (the host populates it from the corresponding form input); if
        // that's missing, we look in `profile.extras` for adapters that
        // stash things there.
        let path = profile
            .database
            .clone()
            .or_else(|| {
                profile
                    .extras
                    .get("database")
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
            })
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AdapterError::Connection(
                    "SQLite adapter requires a `database` file path (got empty)".into(),
                )
            })?;

        let driver = SqliteDriver::connect(SqliteConfig { path }).await?;
        let adapter = SqliteAdapter::new(driver);
        Ok(Arc::new(adapter))
    }
}
