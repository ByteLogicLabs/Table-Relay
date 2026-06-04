//! Factory for the Redis adapter. Takes an `Arc<dyn KnownHostsStore>`
//! at construction time so the SSH tunnel can persist fingerprints
//! without every `Factory::connect` call having to thread one through.

use std::sync::Arc;

use adapter_api::manifest::AdapterManifest;
use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::{Adapter, AdapterError, ConnectionProfile, Factory};
use async_trait::async_trait;

use crate::adapter::RedisAdapter;
use crate::{RedisConfig, RedisDriver, SshConfig, Tunnel, MANIFEST};

pub struct RedisFactory {
    known_hosts: Arc<dyn KnownHostsStore>,
}

impl RedisFactory {
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self { known_hosts }
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

        // The frontend may store Redis DBs as either "8" (connection form) or
        // "db8" (sidebar/rail naming). Accept both; default to DB 0 otherwise.
        let database = profile
            .database
            .as_deref()
            .and_then(parse_database);

        let driver = RedisDriver::connect(RedisConfig {
            host: db_host,
            port: db_port,
            user: profile.user.clone(),
            password: profile.password.clone(),
            database,
        })
        .await?;

        let adapter = RedisAdapter::new_with_tunnel(driver, tunnel);
        Ok(Arc::new(adapter))
    }
}

fn parse_database(raw: &str) -> Option<u32> {
    let s = raw.trim();
    let n = s
        .strip_prefix("db")
        .or_else(|| s.strip_prefix("DB"))
        .unwrap_or(s);
    n.parse::<u32>().ok()
}
