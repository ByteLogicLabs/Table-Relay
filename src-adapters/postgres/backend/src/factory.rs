//! `Factory` for the PostgreSQL adapter. Takes an
//! `Arc<dyn KnownHostsStore>` so the shared SSH tunnel can persist host
//! fingerprints via the host-provided store (same shape as the MySQL
//! factory).

use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use adapter_ssh::{SshConfig, Tunnel};
use async_trait::async_trait;

use crate::adapter::PostgresAdapter;
use crate::{PostgresConfig, PostgresDriver, MANIFEST};

pub struct PostgresFactory {
    known_hosts: Arc<dyn KnownHostsStore>,
}

impl PostgresFactory {
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self { known_hosts }
    }
}

#[async_trait]
impl Factory for PostgresFactory {
    fn manifest(&self) -> &'static AdapterManifest {
        &MANIFEST
    }

    async fn connect(
        &self,
        profile: ConnectionProfile,
    ) -> Result<Arc<dyn Adapter>, AdapterError> {
        // Same structure as the MySQL factory: optionally open an SSH
        // tunnel and redirect the DB dial target to the local forwarded
        // port. Tunnel ownership is handed to `PostgresAdapter` so its
        // lifetime matches the DB pool's.
        let (db_host, db_port, tunnel) = if profile.ssh_enabled {
            let ssh_host = profile
                .ssh_host
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AdapterError::SshTunnel("SSH enabled but no SSH host provided".into())
                })?;
            let ssh_user = profile
                .ssh_user
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AdapterError::SshTunnel("SSH enabled but no SSH user provided".into())
                })?;
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

        let cfg = PostgresConfig {
            host: db_host,
            port: db_port,
            user: profile.user.clone().unwrap_or_default(),
            password: profile.password.clone(),
            database: profile.database.clone(),
            ssl_mode: profile.ssl_mode.clone(),
        };
        let driver = PostgresDriver::connect(cfg).await?;
        Ok(Arc::new(PostgresAdapter::new_with_tunnel(driver, tunnel)))
    }
}
