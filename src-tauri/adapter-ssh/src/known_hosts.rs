//! Trust-on-first-use host-key tracking. Delegates persistence to the
//! host-provided `KnownHostsStore`.
//!
//! Policy:
//!   - First time we see a (host, port), persist the fingerprint silently.
//!   - On later connects, require an exact match. Mismatch returns
//!     `AdapterError::SshTunnel` with a message pointing the user at the
//!     stored fingerprint so they can decide whether the host really
//!     rotated keys.
//!
//! Fingerprint format follows OpenSSH: `SHA256:<base64>` (no padding).

use adapter_api::log_line;
use adapter_api::ssh_hosts::KnownHostsStore;
use adapter_api::AdapterError;

pub fn verify_or_trust(
    store: &dyn KnownHostsStore,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), AdapterError> {
    match store.get(host, port)? {
        Some(saved) if saved == fingerprint => Ok(()),
        Some(saved) => Err(AdapterError::SshTunnel(format!(
            "SSH host key for {host}:{port} has changed.\n  stored:  {saved}\n  current: {fingerprint}\nIf this is expected, remove the saved fingerprint and reconnect."
        ))),
        None => {
            store.insert(host, port, fingerprint)?;
            log_line!(
                "ssh_tunnel",
                "trusted new host {host}:{port} fingerprint={fingerprint}"
            );
            Ok(())
        }
    }
}
