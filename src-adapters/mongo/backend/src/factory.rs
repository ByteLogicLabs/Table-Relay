use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use async_trait::async_trait;

use crate::adapter::MongoAdapter;
use crate::{MongoConfig, MongoDriver, SshConfig, Tunnel, MANIFEST};

pub struct MongoFactory {
    known_hosts: Arc<dyn KnownHostsStore>,
}

impl MongoFactory {
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self { known_hosts }
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
        // Optionally open an SSH tunnel and redirect the DB dial target
        // to the local forwarded port.
        let (db_host, db_port, tunnel) = if profile.ssh_enabled {
            let ssh_host = profile
                .ssh_host
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| AdapterError::SshTunnel(
                    "SSH enabled but no SSH host provided".into(),
                ))?;
            let ssh_user = profile
                .ssh_user
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| AdapterError::SshTunnel(
                    "SSH enabled but no SSH user provided".into(),
                ))?;
            let cfg = SshConfig {
                ssh_host,
                ssh_port: profile.ssh_port.unwrap_or(22),
                ssh_user,
                auth_kind: profile.ssh_auth_kind.clone(),
                password: profile.ssh_password.clone(),
                key_path: profile.ssh_key_path.clone(),
                key_passphrase: profile.ssh_key_passphrase.clone(),
                remote_host: profile.host.clone(),
                remote_port: profile.port,
            };
            let t = Tunnel::open(cfg, &*self.known_hosts).await?;
            (t.local_host().to_string(), t.local_port(), Some(t))
        } else {
            (profile.host.clone(), profile.port, None)
        };

        let auth_source = profile
            .extras
            .get("authSource")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Normalize a blank database to None — an empty string later becomes a
        // ping/connect against database "" which Mongo rejects with
        // "InvalidNamespace: Invalid database name: ''".
        let database = profile
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let cfg = MongoConfig {
            host: db_host,
            port: db_port,
            user: profile.user.clone(),
            password: profile.password.clone(),
            database,
            ssl_mode: profile.ssl_mode.clone(),
            auth_source,
        };
        let driver = MongoDriver::connect(cfg).await?;

        let adapter = MongoAdapter::new_with_tunnel(driver, tunnel);
        Ok(Arc::new(adapter))
    }
}
