# SSH tunnels

Table Relay can reach a database that isn't directly reachable from your machine
by tunneling through an SSH jump host. Supported for **MySQL, PostgreSQL,
MongoDB, and Redis**. SQLite is a local file, so it has no tunnel.

## Set it up

In the connection form, enable **SSH tunnel** and fill in:

- **SSH host / port** - the jump host you can reach.
- **SSH user**.
- **Auth** - either **password** or **key**:
  - **Key**: provide a private key path, or leave it blank to let Table Relay try
    your default keys (`~/.ssh/id_rsa`, `id_ed25519`, `id_ecdsa`, in that order).
    A key passphrase field is available for encrypted keys.
  - **Password**: the SSH account password.

The database host/port in the form are then resolved **from the jump host's
perspective** (often `127.0.0.1` and the DB's internal port).

## Host-key trust (trust on first use)

The first time you connect to a jump host, its SSH fingerprint (SHA-256) is
recorded. On every later connection the fingerprint must match. If it changes,
the connection is **rejected** with a clear error - which protects you from a
man-in-the-middle, but also fires if the server was legitimately rebuilt. If you
trust the change, remove the stored host key and reconnect.

## Behavior worth knowing

- **Connection reuse.** The tunnel stays open for the life of the database
  connection and is reused across operations - it is not re-handshaked on every
  query. This is why connecting can be slow once but fast afterward.
- **Keepalive.** Idle tunnels are kept alive (probes every ~20s, with a
  5-minute inactivity backstop) so NAT/firewalls don't silently drop them.
- **Auto-reconnect.** If a tunnel drops, it's rebuilt transparently on the next
  query; you'll see a brief "Reconnecting" badge only when a real rebuild is
  needed.

## Related

- [Connections](connections.md)
- Developer detail: [SSH tunneling internals](../dev/architecture.md#ssh) and the
  [reconnect supervisor](../dev/reconnect.md)
