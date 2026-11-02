# Reconnect supervisor

Dropped database pools and SSH tunnels are rebuilt transparently on the next
query, so a flaky network or an idle-killed tunnel doesn't surface as an error.
Code: `src-tauri/src/db/reconnect.rs` and `registry.rs`.

## The retry wrapper

Database operations run through `with_retry()`:

1. Run the operation against the current adapter.
2. If it fails with a **transient** error (`Connection`, `Timeout`, `Io`,
   `SshTunnel` - see `is_transient()`), enter the retry loop. **Permanent**
   errors (auth, syntax, not-found) return immediately, no retry.
3. Acquire the connection's `reconnect_lock` so concurrent commands don't rebuild
   the pool twice.
4. **Health check first**: `ping()` the existing pool. If it's actually healthy,
   skip the rebuild and just re-issue the op (silent recovery).
5. Otherwise **rebuild**: factory → connect → ping. If the ping fails, shut the
   pool down before returning the error.
6. Up to `MAX_RETRIES = 3` attempts with exponential backoff (`1s, 3s, 9s`).

## Events emitted to the frontend

| Event | When | Payload |
|---|---|---|
| `connection:reconnecting` | a rebuild attempt starts | `{ connectionId, attempt (1-based), maxAttempts, error }` |
| `connection:reconnected` | op succeeded after a "reconnecting" toast, or silent recovery, or rebuild succeeded | `{ connectionId, attempt: 0, maxAttempts, error: null }` |
| `connection:lost` | all retries exhausted | `{ connectionId, attempt: 0, maxAttempts, error }` |

The UI shows a "Reconnecting" badge/toast only when a genuine rebuild is under
way; silent recoveries don't nag the user.

> **Frontend note.** Because `connection:reconnecting` can arrive even just after
> the user clicked Disconnect (the event was already in flight), the app guards
> against a stuck "Reconnecting…" toast: on disconnect it marks the connection
> and ignores/clears late reconnect events for it (`src/app.tsx`).

## Per-connection query gate (stampede prevention)

The registry (`src-tauri/src/db/registry.rs`) keeps one `Arc<Mutex<()>>` per
connection id (`reconnect_locks`). The rebuild phase holds that lock and releases
it before re-issuing the op. So if several commands fail at once, only **one**
rebuild happens; the rest wait and then run against the fresh pool - no thundering
herd of orphaned pools under a flapping server.

## SSH tunnels

The same machinery covers SSH: a dropped tunnel is a transient `SshTunnel`/`Io`
failure, so it's rebuilt on the next query. Each adapter owns its tunnel
internally (via `adapter-ssh`), so rebuilding the pool re-establishes the tunnel.
See [SSH tunnels](../guide/ssh-tunnels.md) for the user view and
[architecture](architecture.md#ssh) for the forwarding details.

## See also

- [Architecture overview](architecture.md)
- [The encrypted store](store-encryption.md) (where SSH known-hosts live)
