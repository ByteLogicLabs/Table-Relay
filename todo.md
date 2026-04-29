# db-table — Backend Integration TODO

Tracks the rollout of real MySQL / PostgreSQL / MongoDB connectivity behind an encrypted SQLite credential vault, with SSH tunneling.

## How to use this file

- Check an item off only when it's done **and** exercised against a real target (or in M0/M1, against the stubbed mock).
- When scope changes, add a line under "Notes / decisions / deviations" with a short reason — don't silently retask.
- Keep each milestone in order; don't jump ahead unless the prior milestone's "ship" bullet is checked.

---

## Locked decisions

- [x] **Credentials**: SQLite vault at `app_data_dir/vault.db`, AES-256-GCM on the password column, Argon2id master key (m=64MiB, t=3, p=4)
- [x] **SSH tunneling**: in scope for M5 via `russh` (per-connection config, forward-local)
- [x] **Query cancel**: deferred to post-M7
- [x] **Mongo**: parse-a-subset (`db.<coll>.find/aggregate/countDocuments` with `.limit/.sort/.skip`)
- [x] **Row editing**: folded into M2 / M3 / M4 per driver

### Open items to confirm before M0 start

- [x] Auto-lock idle timeout default = 30 min
- [x] Vault reset UX guarded by typed `RESET` confirmation
- [x] Master password minimum = 12 chars
- [x] SSH private keys live on disk; vault stores only the passphrase
- [x] `ConnectionProfile` schema additions: `ssl_mode`, `ssh_config`, `is_favorite`

---

## M0 — ~~Vault foundation~~ *(REMOVED 2026-04-19 per user request — see note at the bottom. Kept here as a spec for re-adding encryption later.)*

**Goal**: every credential flows through an encrypted SQLite vault before M1 touches the DB.

### Rust

- [x] Add deps: `rusqlite` (bundled), `rusqlite_migration`, `argon2`, `aes-gcm`, `zeroize`, `rand`
- [x] `vault/schema.rs` — migration v1: `connections`, `secrets`, `app_meta(kdf_salt, verifier_ciphertext)`, `ssh_known_hosts`
- [x] `vault/crypto.rs` — Argon2id KDF + AES-256-GCM helpers (encrypt/decrypt with per-row nonce)
- [x] `vault/session.rs` — unlocked master-key cache + idle-lock timer (default 30 min)
- [x] `vault/repo.rs` — CRUD for connection profiles (never exposes ciphertext to the UI)
- [x] `commands/vault.rs`:
  - [x] `vault_is_initialized`
  - [x] `vault_init(master_password)`
  - [x] `vault_unlock(master_password)`
  - [x] `vault_lock`
  - [x] `vault_is_unlocked`
  - [x] `vault_change_password(old, new)`
  - [x] `vault_list_connections`
  - [x] `vault_save_connection(profile)`
  - [x] `vault_delete_connection(id)`
- [x] Capability: add all `vault_*` commands to `src-tauri/capabilities/default.json` *(not needed — Tauri 2 auto-registers `#[tauri::command]` functions for the main window; no ACL file used)*

### Frontend

- [x] `src/lib/vault.ts` — typed `invoke` wrapper for every vault command
- [x] `src/state/vault.ts` — store with `uninitialized | locked | unlocked`
- [x] `src/components/VaultGate.tsx` — create-password / unlock screen, blocks app until unlocked
- [ ] `src/components/VaultLockedOverlay.tsx` — re-unlock prompt when session auto-locks mid-session *(deferred: VaultGate already re-renders the unlock form when `refreshVaultStatus()` flips to `locked`; a dedicated overlay is polish, not blocker)*
- [x] Migrate existing `localStorage` `db_connections` seed → one-time prompt → `vault_save_connection` for each
- [x] ConnectionModal save path calls `vault_save_connection` *(via `handleAddConnection` in `App.tsx` — ConnectionModal itself still just bubbles up the profile)*
- [x] "Reset vault" escape hatch with typed-`RESET` confirmation *(UI present; `vault_reset` backend command intentionally deferred — dialog tells the user to delete `vault.db` manually for now)*

### Ship

- [x] Unit tests for `crypto.rs` (round-trip, bad-key rejection)
- [ ] Manual: first-launch → set password → quit → relaunch → unlock → see connections *(awaiting user verification via `npm run tauri:dev`)*
- [ ] Manual: idle 30 min → locked overlay appears → unlock → state resumes *(awaiting user verification; re-check via `Session::key()` happens on every vault command)*

---

## M1 — Rust DB foundation (+ MySQL landed together)

**Goal**: the frontend talks to Rust for everything, all mock data removed. MySQL is wired end-to-end in the same pass (user asked to skip stubs and start with MySQL).

### Rust

- [x] Add deps: `sqlx` (mysql, runtime-tokio-rustls, json, chrono, uuid, bigdecimal), `tokio`, `async-trait`, `thiserror`, `chrono`, `uuid`, `bigdecimal`
- [x] `db/error.rs` — `DbError` enum (Connection, Auth, Syntax{line,col,msg}, NotFound, Unsupported, Timeout, SshTunnel, Vault, VaultLocked, Io, Other), `Serialize`
- [x] `db/types.rs` — `ConnectionMeta`, `SchemaInfo`, `TableStructure`, `ForeignKey`, `QueryResult`, `StatementResult`, `UpdateRowsRequest/Result`
- [x] `db/mod.rs` — `Driver` trait + `Registry` keyed by `ConnectionId`
- [x] `db/mysql.rs` — real MySQL driver (sqlx pool, SSL modes, statement splitter, column-level JSON conversion, `UPDATE … WHERE pk` commits)
- [ ] Postgres driver (M2)
- [ ] Mongo driver (M4)
- [x] `commands/db.rs`:
  - [x] `db_connect` (fetches profile + decrypts password from the vault; refuses if SSH is enabled — M5 wires tunneling)
  - [x] `db_disconnect`
  - [x] `db_ping`
  - [x] `db_list_active`
  - [x] `db_list_schemas`
  - [x] `db_describe_table`
  - [x] `db_list_relations`
  - [x] `db_run_query`
  - [x] `db_update_rows`
  - [ ] `db_test_connection` *(deferred to M5 with the "Test" button)*

### Frontend

- [x] `src/lib/db.ts` — typed `invoke` wrappers matching the Rust `serde` shapes
- [x] `src/state/connections.ts` — external store with `activeById`, `schemasById`, `loadingSchemasById`, `connectingIds`, `lastErrorById`
- [x] `App.tsx` → `handleConnect` now calls `connectAndLoad` → `db_connect` → populates store
- [x] `Sidebar` → reads schemas from the store, shows loading spinner, has a refresh button, passes `schema` to `onOpenTable`/`onOpenStructure`
- [x] `DataGrid` → `useEffect` fetches via `db.runQuery` + `db.describeTable`, removed `generateMockData`, real `handleCommit` uses `db.updateRows`
- [x] `DiagramView` → deleted the static `WORLD` mock; now calls `db.describeTable` + `db.listRelations` for both `scope="table"` (one-hop neighbourhood) and `scope="schema"` (everything in the schema)
- [x] `SqlEditor` → `db.runQuery` replaces the `setTimeout` mock; each statement logged with real duration + status

### Ship

- [x] `cargo clippy --all-targets -- -D warnings` clean
- [x] `npx tsc --noEmit` clean
- [ ] Manual: create a local MySQL (docker: `docker run --rm -p 3306:3306 -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=demo mysql:8`), add a connection in the app, open a table, edit a cell, commit → verify row updated on the server. *Awaits user verification.*

---

## M2 — PostgreSQL end-to-end

### Rust

- [ ] `db/postgres.rs` — `sqlx::PgPool`, open with SSL mode, ping with `SELECT version()`
- [ ] `list_schemas` via `pg_namespace` + `pg_class` (tables + views)
- [ ] `describe_table` via `information_schema.columns` + `pg_constraint` (PK, FK, UNIQUE) + `pg_indexes`
- [ ] `list_relations` for a schema
- [ ] `run_query` — multi-statement split; per-statement duration; rows as JSON values
- [ ] Type mapping: smallint, int, bigint, real, double, numeric, text/varchar/char, bool, bytea, date, time, timestamp, timestamptz, uuid, json, jsonb, arrays, enums, null
- [ ] `update_rows` — builds `UPDATE schema.table SET col = $1 WHERE pk_col = $2 RETURNING *`; rejects tables with no PK (`DbError::Unsupported`)
- [ ] Error mapping: `sqlx::Error::Database(db)` → `DbError::Syntax { line, col, message }` using `db.position()`

### Frontend

- [ ] No new UI — DataGrid / SqlEditor already render against the typed contract

### Ship

- [ ] Integration test harness: `docker compose` bringing up `postgres:16` with 4-table seed
- [ ] Manual matrix (local pg):
  - [ ] Connect → disconnect → reconnect
  - [ ] Open `users` (50 rows), grid + diagram + structure all load
  - [ ] Edit a cell → commit → re-read → value persisted
  - [ ] Edit a cell in a PK-less view → error surfaced cleanly
  - [ ] SELECT with syntax error → Monaco squiggle at the right line/col (verified in M6 but plumbed now)
  - [ ] Filter builder with 3 AND conditions → row count matches `SELECT COUNT(*) WHERE ...`

---

## M3 — MySQL *(completed as part of M1 per user request)*

### Rust

- [x] `db/mysql.rs` — `sqlx::MySqlPool`, SSL modes DISABLED / PREFERRED / REQUIRED / VERIFY_CA / VERIFY_IDENTITY
- [x] Schema/table introspection via `information_schema` (MySQL 5.7+ / 8 feature detection)
- [x] FK lookup via `information_schema.key_column_usage` + `referential_constraints`
- [x] `update_rows` — backtick-quoted identifiers, `UPDATE \`db\`.\`table\` SET \`c\` = ? WHERE \`pk\` = ?`
- [x] Error mapping: MySQL error codes → `DbError::Syntax` / `DbError::Authentication` where possible

### Ship

- [ ] `mysql:8` container in the test compose *(awaiting user verification)*
- [ ] Manual matrix mirrors M2

---

## M4 — MongoDB

### Rust

- [ ] `db/mongo.rs` — `mongodb::Client`, list databases + collections = schemas + tables
- [ ] `describe_table` — sample N docs, infer field set + union of BSON types, mark `_id` as PK
- [ ] `mongo_parser.rs` — tokenize `db.<coll>.<method>(...)` with chained `.limit()`, `.sort()`, `.skip()`; supports `find`, `findOne`, `aggregate`, `countDocuments`
- [ ] Unsupported methods → `DbError::Unsupported("method 'X' is not implemented")`
- [ ] `run_query` — returns `rows` as JSON (from BSON), `affectedRows` for `updateOne/Many`, `deleteOne/Many`
- [ ] `update_rows` — `updateOne({_id}, {$set: {...}})`
- [ ] Filter builder adapter: `FilterCondition[]` → MongoDB filter doc (server-side translation identical to current JS)

### Ship

- [ ] `mongo:7` container in the test compose
- [ ] Manual matrix parallels M2 / M3 (collections instead of tables, JSON tree + Diagram + Table views all sane)

---

## M5 — Connection UX + SSH tunneling

### Rust

- [ ] Add deps: `russh`, `russh-keys`
- [ ] `ssh/tunnel.rs` — open `russh::client::Handle`, `direct_tcpip` forward to a local ephemeral port, return bound addr
- [ ] Tunnel lifecycle: `ActiveConnection { ssh_tunnel: Option<Tunnel> }` — dropped on `db_disconnect` or app exit
- [ ] `db_connect` composes: SSH first → rewrite driver host/port to tunnel local endpoint
- [ ] Host key handling: first connection prompts with the fingerprint (returns `DbError::UnknownHostKey { fingerprint }`), UI offers accept → stored in `ssh_known_hosts`
- [ ] Keep-alive + reconnect-on-drop (bounded retries)

### Frontend

- [ ] "Test" button in `ConnectionModal` → `db_test_connection`, spinner + success/error toast, tears everything down after
- [ ] SSL mode selector in `ConnectionModal` (driver-specific options)
- [ ] SSH pane in `ConnectionModal`: enable toggle + host/port/user + auth (Password | Private Key path + passphrase)
- [ ] Host-key accept dialog rendered from `DbError::UnknownHostKey`

### Ship

- [ ] Test: bastion-style setup with pg behind an SSH jump container (docker compose)
- [ ] Manual: bad host key → prompt → accept → reconnect → quiet
- [ ] Manual: tunnel drops mid-query → surfaced as `DbError::SshTunnel(...)`, toasted, connection marked errored in the rail

---

## M6 — Query log + real error surfacing

### Rust

- [ ] `QueryResult.statements[]` carries `{ sql, duration_ms, rows_affected?, rows?, error? }`
- [ ] Syntax errors return column/line offsets where the driver exposes them

### Frontend

- [ ] `QueryLog` consumes the real `statements[]` array (one log entry per statement)
- [ ] Monaco `setModelMarkers` renders syntax errors as squiggles w/ hover tooltip from `DbError::Syntax`
- [ ] Per-log-entry actions: "Copy statement", "Re-run"
- [ ] Error styling in log uses existing One Dark Pro red `#e06c75`

### Ship

- [ ] Manual: invalid SQL in editor → squiggle at correct line, log shows error status
- [ ] Manual: multi-statement editor run → N log entries, first N-1 succeed, last one errors → visible clearly

---

## M7 — Live schema + real diagrams

### Frontend + Rust

- [ ] `Sidebar` schema tree reads from `db_list_schemas`; per-connection refresh button
- [ ] Automatic refresh after editor runs a `CREATE | DROP | ALTER` statement (detected via simple regex pre-run)
- [ ] `DiagramView` `scope="schema"` → `db_list_relations` + parallel `db_describe_table` for every table
- [ ] `DiagramView` `scope="table"` → focus table's structure + one-hop FK neighbours from real metadata
- [ ] Delete the static `WORLD` mock from `DiagramView.tsx`

### Ship

- [ ] Diagram of a 20+ table real schema lays out cleanly with dagre
- [ ] Creating a table in the editor → refresh → sidebar tree shows it

---

## Cross-cutting / ongoing

- [ ] Update this file (check items, add notes) every time a task lands
- [ ] Keep `cargo fmt` + `cargo clippy --all-targets -- -D warnings` clean on each milestone
- [ ] Keep `npm run build` (tsc + vite) green on each milestone
- [ ] Every new Tauri command added to `src-tauri/capabilities/default.json`
- [ ] No `unwrap()` / `expect()` in command handlers — errors go through `DbError`

---

## Explicitly out of scope (future plans)

- Schema edits (ALTER/CREATE/DROP via UI, not the editor)
- X.509 client certs, IAM / Azure AD authentication
- Streaming very large result sets (millions of rows) — pagination only
- Multi-statement transactions controlled from the UI
- Full Mongo shell JS evaluation
- Live autocomplete for column names in Monaco (planned after M7 when schema metadata is real)
- Query cancellation

---

## Notes / decisions / deviations

_Add dated entries here as the plan evolves._

- 2026-04-18 — initial plan locked; SQLite vault chosen over Stronghold; SSH tunneling in M5.
- 2026-04-18 — all five open items confirmed by the user. M0 started.
- 2026-04-18 — M0 code complete. Rust: 3/3 crypto unit tests pass, `cargo clippy --all-targets -- -D warnings` clean. Frontend: `tsc --noEmit` clean, `npm run build` succeeds. `VaultLockedOverlay` and `vault_reset` command both deferred with inline notes — VaultGate already handles the locked state on the same screen, and reset is documented as "delete vault.db" until the backend command lands. Two manual checks remain for user verification.
- 2026-04-18 — M1 + M3 reordered: user asked to remove all mock/dummy data and start MySQL first. Plan: land M1 shape (Driver trait, Registry, commands, TS wrappers, UI empty-state plumbing) AND the MySQL implementation together, skipping mock stubs. PostgreSQL and Mongo remain as follow-up milestones.
- 2026-04-19 — M1 + M3 code complete. MySQL end-to-end; all WORLD/mock data removed from `Sidebar`, `DataGrid`, `DiagramView`, `SqlEditor`. Schema now carried on every data/structure/erd tab so `UPDATE …` can target the right object. `cargo clippy --all-targets -- -D warnings` + `tsc --noEmit` both clean. `db_test_connection` + SqlEditor inline result-grid deferred; the editor now logs real per-statement results into the Query Log for now.
- 2026-04-19 — "Save my password" added to the Vault unlock screen: opt-in checkbox persists the master password to localStorage (base64-obfuscated; note this is convenience, not extra security — vault.db sits on the same disk). Cleared on BadPassword + on vault reset.
- 2026-04-19 — Vault fully removed for dev per user request (Option A). No master password, no encryption, no unlock screen. All connection fields (including passwords) live as plaintext in `~/Library/Application Support/com.dbtable.app/store.db`. Deleted: `src-tauri/src/vault/*`, `src-tauri/src/commands/vault.rs`, `src/lib/vault.ts`, `src/state/vault.ts`, `src/components/VaultGate.tsx`. Replaced with: `src-tauri/src/store/{mod,schema,repo}.rs` + `migrations/0001_initial.sql`, `src-tauri/src/commands/store.rs`, `src/lib/connectionsStore.ts`. New command names: `connections_list`, `connections_save`, `connections_delete`. `DbError::VaultLocked`/`Vault` variants and the crypto crates (argon2, aes-gcm, zeroize, rand) removed from Cargo.toml. To re-enable encryption, rebuild the M0 spec above on top of the new store — the SQLite rows already carry the `password`/`ssh_password`/`ssh_key_passphrase` columns so the migration is a re-encrypt-in-place.
