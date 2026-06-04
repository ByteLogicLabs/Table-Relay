//! Shared SSH tunnel used by the built-in database adapters.
//!
//! Was originally inlined inside `adapter-mysql`; extracted here so
//! Postgres (and future adapters) can reuse the same port-forwarding,
//! key-resolution, and trust-on-first-use known-hosts policy without
//! copy-paste.
//!
//! Public surface is just `SshConfig` + `Tunnel`; everything else stays
//! crate-private because the host wires `KnownHostsStore` through
//! `adapter-api` already.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use std::time::Instant;

use adapter_api::log_line;
use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::AdapterError;
use russh::client::{self, Handle, Handler};
use russh::keys::ssh_key::public::PublicKey;
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

mod known_hosts;

static SUCCESSFUL_KEYS: OnceLock<StdMutex<HashMap<String, PathBuf>>> = OnceLock::new();

/// Inputs for opening a tunnel. Everything the command layer can
/// extract from a `ConnectionProfile` once plaintext secrets have been
/// pulled.
pub struct SshConfig {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    /// "password" or "key" (None is treated as "key with defaults").
    pub auth_kind: Option<String>,
    pub password: Option<String>,
    /// Explicit private-key path. When `None`, we fall back to the common
    /// OpenSSH defaults under `~/.ssh/` (id_ed25519, id_rsa).
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    /// The database server from the SSH side's point of view. Usually
    /// `127.0.0.1` — the DB listens on localhost of the jump host — but
    /// can point to another internal host.
    pub remote_host: String,
    pub remote_port: u16,
}

/// Handle to an open tunnel. Drop to tear it down.
pub struct Tunnel {
    local_port: u16,
    session: Arc<Mutex<Option<Handle<TunnelHandler>>>>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Tunnel {
    pub fn local_host(&self) -> &'static str {
        "127.0.0.1"
    }
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// Open an SSH session and start forwarding. Returns once the
    /// listener is bound and auth has succeeded; the forwarding task
    /// runs in the background.
    pub async fn open(
        cfg: SshConfig,
        known_hosts_store: &dyn KnownHostsStore,
    ) -> Result<Self, AdapterError> {
        let t_total = Instant::now();
        log_line!(
            "ssh_tunnel",
            "→ opening tunnel ssh={}:{} user={} remote={}:{} auth={:?}",
            cfg.ssh_host,
            cfg.ssh_port,
            cfg.ssh_user,
            cfg.remote_host,
            cfg.remote_port,
            cfg.auth_kind,
        );
        let ssh_config = Arc::new(client::Config {
            // Keepalive matters now that we REUSE tunnels across operations
            // (db_connect is idempotent). Without it an idle SSH session is
            // silently dropped by NAT/firewall/server idle-timeout, and the
            // next forwarded DB connection floods "open channel: Channel send
            // error" against the dead session. A keepalive every 20s keeps the
            // session warm; 4 unanswered probes (~80s) declares the peer dead
            // so the transport closes and the reconnect supervisor rebuilds a
            // fresh tunnel instead of hammering a corpse.
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 4,
            // Backstop: if truly nothing is heard for a few minutes, drop the
            // session (keepalives normally keep this from ever firing).
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Default::default()
        });

        let key_cache_id = key_cache_key(&cfg);
        let (fp_tx, fp_rx) = oneshot::channel::<String>();
        let handler = TunnelHandler {
            fingerprint_tx: Mutex::new(Some(fp_tx)),
        };

        let t_resolve = Instant::now();
        let addr: SocketAddr = (cfg.ssh_host.as_str(), cfg.ssh_port)
            .to_socket_addrs_first()
            .map_err(|e| AdapterError::SshTunnel(format!("resolve {}: {}", cfg.ssh_host, e)))?;
        log_line!(
            "ssh_tunnel",
            "  resolved {}:{} → {} ({:.1}ms)",
            cfg.ssh_host,
            cfg.ssh_port,
            addr,
            t_resolve.elapsed().as_secs_f64() * 1000.0
        );

        let t_connect = Instant::now();
        let mut session = client::connect(ssh_config, addr, handler)
            .await
            .map_err(|e| {
                AdapterError::SshTunnel(format!("connect {}:{}: {}", cfg.ssh_host, cfg.ssh_port, e))
            })?;
        log_line!(
            "ssh_tunnel",
            "  tcp+ssh handshake completed ({:.1}ms)",
            t_connect.elapsed().as_secs_f64() * 1000.0
        );

        let t_known_hosts = Instant::now();
        let fingerprint = fp_rx
            .await
            .map_err(|_| AdapterError::SshTunnel("server did not present a host key".into()))?;
        known_hosts::verify_or_trust(known_hosts_store, &cfg.ssh_host, cfg.ssh_port, &fingerprint)?;
        log_line!(
            "ssh_tunnel",
            "  host key verified ({:.1}ms)",
            t_known_hosts.elapsed().as_secs_f64() * 1000.0
        );

        let auth_kind = cfg.auth_kind.as_deref().unwrap_or("key");
        let t_auth = Instant::now();
        let auth_ok = match auth_kind {
            "password" => {
                let pw = cfg.password.clone().ok_or_else(|| {
                    AdapterError::SshTunnel(
                        "SSH password auth selected but no password provided".into(),
                    )
                })?;
                session
                    .authenticate_password(&cfg.ssh_user, pw)
                    .await
                    .map_err(|e| AdapterError::SshTunnel(format!("password auth: {e}")))?
                    .success()
            }
            _ => {
                let candidates = resolve_key_candidates(cfg.key_path.as_deref(), &key_cache_id)?;
                let hash_alg = session
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten();
                let mut success = false;
                let mut last_err: Option<String> = None;
                for key_path in &candidates {
                    let key =
                        match russh::keys::load_secret_key(key_path, cfg.key_passphrase.as_deref())
                        {
                            Ok(k) => k,
                            Err(e) => {
                                log_line!(
                                    "ssh_tunnel",
                                    "  skip {:?}: load failed ({e})",
                                    key_path
                                );
                                last_err = Some(format!("{:?}: {e}", key_path));
                                continue;
                            }
                        };
                    let auth = session
                        .authenticate_publickey(
                            &cfg.ssh_user,
                            PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                        )
                        .await
                        .map_err(|e| {
                            AdapterError::SshTunnel(format!("key auth ({:?}): {e}", key_path))
                        })?;
                    if auth.success() {
                        remember_successful_key(&key_cache_id, key_path.clone());
                        log_line!(
                            "ssh_tunnel",
                            "  authenticated with {:?} ({:.1}ms)",
                            key_path,
                            t_auth.elapsed().as_secs_f64() * 1000.0
                        );
                        success = true;
                        break;
                    }
                    log_line!("ssh_tunnel", "  server rejected {:?}", key_path);
                }
                if !success && candidates.is_empty() {
                    return Err(AdapterError::SshTunnel(
                        "no SSH key specified and no default key found under ~/.ssh".into(),
                    ));
                }
                if !success {
                    if let Some(e) = last_err {
                        return Err(AdapterError::Authentication(format!(
                            "SSH key authentication failed ({e})"
                        )));
                    }
                }
                success
            }
        };
        if auth_kind == "password" && auth_ok {
            log_line!(
                "ssh_tunnel",
                "  password authenticated ({:.1}ms)",
                t_auth.elapsed().as_secs_f64() * 1000.0
            );
        }
        if !auth_ok {
            return Err(AdapterError::Authentication(format!(
                "SSH authentication failed for {}@{}",
                cfg.ssh_user, cfg.ssh_host
            )));
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| AdapterError::SshTunnel(format!("bind local listener: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AdapterError::SshTunnel(format!("read local addr: {e}")))?
            .port();
        log_line!(
            "ssh_tunnel",
            "  listener on 127.0.0.1:{local_port} → {}:{} ({:.1}ms total)",
            cfg.remote_host,
            cfg.remote_port,
            t_total.elapsed().as_secs_f64() * 1000.0
        );

        let session = Arc::new(Mutex::new(Some(session)));
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        tokio::spawn(forward_loop(
            listener,
            session.clone(),
            cfg.remote_host.clone(),
            cfg.remote_port,
            stop_rx,
        ));

        Ok(Self {
            local_port,
            session,
            shutdown: Some(stop_tx),
        })
    }

    pub async fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.take() {
            let _ = session
                .disconnect(Disconnect::ByApplication, "bye", "en")
                .await;
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn forward_loop(
    listener: TcpListener,
    session: Arc<Mutex<Option<Handle<TunnelHandler>>>>,
    remote_host: String,
    remote_port: u16,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut stop => {
                log_line!("ssh_tunnel", "forward_loop: shutdown signal");
                return;
            }
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        log_line!("ssh_tunnel", "accept error: {e}");
                        return;
                    }
                };
                let session = session.clone();
                let remote_host = remote_host.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward_one(stream, session, remote_host.clone(), remote_port, peer).await {
                        log_line!("ssh_tunnel", "forward_one({peer}) error: {e}");
                    }
                });
            }
        }
    }
}

async fn forward_one(
    mut stream: TcpStream,
    session: Arc<Mutex<Option<Handle<TunnelHandler>>>>,
    remote_host: String,
    remote_port: u16,
    peer: SocketAddr,
) -> Result<(), String> {
    let mut channel = {
        let guard = session.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "ssh session closed".to_string())?;
        handle
            .channel_open_direct_tcpip(
                remote_host,
                remote_port as u32,
                peer.ip().to_string(),
                peer.port() as u32,
            )
            .await
            .map_err(|e| format!("open channel: {e}"))?
    };

    let (mut r, mut w) = stream.split();
    let mut buf = [0u8; 16 * 1024];

    loop {
        tokio::select! {
            read = r.read(&mut buf) => {
                match read {
                    Ok(0) => { let _ = channel.eof().await; break; }
                    Ok(n) => { channel.data(&buf[..n]).await.map_err(|e| format!("data→ssh: {e}"))?; }
                    Err(e) => return Err(format!("read local: {e}")),
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        w.write_all(&data).await.map_err(|e| format!("write local: {e}"))?;
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        w.write_all(&data).await.map_err(|e| format!("write local (ext): {e}"))?;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
        }
    }
    Ok(())
}

struct TunnelHandler {
    fingerprint_tx: Mutex<Option<oneshot::Sender<String>>>,
}

impl Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let mut guard = self.fingerprint_tx.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(fp);
        }
        Ok(true)
    }
}

fn key_cache_key(cfg: &SshConfig) -> String {
    format!("{}:{}:{}", cfg.ssh_host, cfg.ssh_port, cfg.ssh_user)
}

fn remember_successful_key(cache_id: &str, path: PathBuf) {
    let map = SUCCESSFUL_KEYS.get_or_init(|| StdMutex::new(HashMap::new()));
    if let Ok(mut guard) = map.lock() {
        guard.insert(cache_id.to_string(), path);
    }
}

fn cached_successful_key(cache_id: &str) -> Option<PathBuf> {
    let map = SUCCESSFUL_KEYS.get_or_init(|| StdMutex::new(HashMap::new()));
    map.lock().ok().and_then(|guard| guard.get(cache_id).cloned())
}

fn resolve_key_candidates(explicit: Option<&str>, cache_id: &str) -> Result<Vec<PathBuf>, AdapterError> {
    if let Some(p) = explicit.filter(|s| !s.trim().is_empty()) {
        return Ok(vec![PathBuf::from(p)]);
    }
    let home = dirs::home_dir()
        .ok_or_else(|| AdapterError::SshTunnel("cannot determine home directory".into()))?;
    let mut out = Vec::new();
    for name in ["id_rsa", "id_ed25519", "id_ecdsa"] {
        let path = home.join(".ssh").join(name);
        if path.exists() {
            out.push(path);
        }
    }
    if let Some(cached) = cached_successful_key(cache_id) {
        if let Some(pos) = out.iter().position(|p| p == &cached) {
            out.remove(pos);
            out.insert(0, cached);
        }
    }
    Ok(out)
}

trait ToSocketAddrFirst {
    fn to_socket_addrs_first(self) -> std::io::Result<SocketAddr>;
}

impl ToSocketAddrFirst for (&str, u16) {
    fn to_socket_addrs_first(self) -> std::io::Result<SocketAddr> {
        use std::net::ToSocketAddrs;
        self.to_socket_addrs()?.next().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no addresses")
        })
    }
}
