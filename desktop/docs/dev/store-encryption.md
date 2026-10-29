# The encrypted store

Table Relay keeps connection profiles, settings, AI conversations, and SSH known
hosts in a local, encrypted SQLite snapshot. Code: `src-tauri/src/store/`.

## On-disk format (`store.db.enc`)

```
[ MAGIC (8 bytes) ][ NONCE (12 bytes) ][ CIPHERTEXT ]
```

- **MAGIC** = `TRDBE02\n` (`src/store/mod.rs`, `const MAGIC`).
- **NONCE** - 12 random bytes from `OsRng`, fresh on every write.
- **CIPHERTEXT** - the serialized SQLite database, encrypted with **AES-256-GCM**
  (`aes_gcm` crate).

The plaintext is a SQLite snapshot whose tables include `connections` (profiles
incl. SSH fields), `ssh_known_hosts`, `app_state`, `ai_settings`,
`ai_conversations`, `marks`, `rail_tiles`, and `tags`.

## Key derivation

The 32-byte AES key comes from **`APP_TOKEN`**, a 64-hex-char value compiled into
the binary at build time:

- `app_key()` (`src/store/mod.rs`) reads `option_env!("APP_TOKEN")`, requires
  exactly 64 hex digits, and parses it to 32 bytes. No runtime fallback.
- `build.rs` sources `APP_TOKEN` from the CI env var or the workspace `.env`
  (env var wins). **Release builds hard-fail if it's missing**; debug builds
  tolerate absence and surface the error at runtime.

> **Security caveat.** A key embedded in the binary protects against casual
> inspection and copy-off-disk, but is recoverable by a determined attacker. A
> password-derived key or OS-keychain storage is stronger and still planned. Do
> not treat this as hardened for high-value production secrets. See the project
> [Security](../../README.md#security) section.

> **Operational caveat.** Because the key *is* `APP_TOKEN`, changing it makes
> every existing `store.db.enc` undecryptable (it'll read as `WrongKey`). The
> token is effectively permanent for a given user base - rotating it locks people
> out of their saved connections.

## Migrations

`src/store/schema.rs` uses `rusqlite_migration::Migrations` with numbered SQL
files (`0001_initial.sql` … `0008_connection_tags_multi.sql` at time of writing).

**DB-ahead-of-code is tolerated.** If the on-disk schema version is *newer* than
the latest migration this build knows about, the open proceeds **without
migrating** - a newer store is treated as a superset, and SQLite ignores the
extra tables/columns. This prevents data loss when an older build (or a hot
update that rolled the JS back) opens a store written by a newer build. Covered
by the `db_ahead_of_code_is_tolerated` test.

## Open hardening (no silent wipe)

Decryption failures are classified (`DecryptFailure`) and handled differently so
intact-but-unreadable data is never destroyed:

| Failure | Meaning | Action |
|---|---|---|
| `LegacyFormat` | wrong magic bytes (genuinely foreign file) | set aside as `.enc.incompatible`, start fresh |
| `WrongKey` | valid envelope, AES-GCM auth failed (wrong/missing `APP_TOKEN`) | **hard error, file untouched** - a correctly-built app will read it |
| `KeyUnavailable` | `APP_TOKEN` not configured | **hard error** |

Migration errors are likewise treated as *unreadable-not-corrupt*
(`is_unreadable_not_corrupt`) and do **not** trigger a reset. Only a provably
foreign file (`LegacyFormat`) is moved aside.

This hardening exists because earlier versions reset the store on *any* open
failure - which, combined with a build that lacked the correct `APP_TOKEN`, could
wipe a user's connections. The rule now: **never reset on a crypto or migration
error.**

## See also

- [Architecture overview](architecture.md)
- User-facing: [Connections](../guide/connections.md)
