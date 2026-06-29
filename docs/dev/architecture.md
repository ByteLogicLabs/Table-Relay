# Architecture overview

Table Relay is a [Tauri](https://tauri.app) desktop app: a **React + TypeScript**
frontend (Vite) over a **Rust** backend (the Tauri host). Databases are reached
through self-contained **adapters**.

```
src/                  React + TypeScript UI (Vite)
  features/           One folder per workspace tab (data-grid, sql-editor, schema,
                      diagram, realtime, ai-chat, connections, ...)
  lib/                IPC wrappers, stores, Monaco/SQL helpers
  state/              Lightweight external stores (useSyncExternalStore)
src-tauri/            Rust backend (Tauri host)
  src/commands/       Tauri command surface (db, ai, store, rail)
  src/ai/             AI providers, streaming, tool-calling, approval flow, MCP bridge
  src/db/             Connection registry, reconnect supervisor, subscriptions
  src/store/          Local AES-256-GCM encrypted SQLite store (profiles, settings)
  adapter-api/        Shared `Adapter` + `Factory` traits, manifest, intent types
  adapter-ssh/        SSH tunnel crate (russh)
  manifest-build/     Build-time manifest.toml -> Rust codegen
src-adapters/         One folder per database driver
  {mysql,postgres,sqlite,redis,mongo}/
```

## Layers

### Frontend (`src/`)

- **`features/`** - one folder per workspace surface. Each tab type (data grid,
  SQL editor, schema editor, diagram, realtime, AI chat) is independent.
- **`state/`** - small external stores built on `useSyncExternalStore`, not a
  heavyweight state library. Connection state, the rail, adapter manifests, etc.
- **`lib/`** - Tauri IPC wrappers, the settings store, Monaco/SQL helpers.

The frontend never constructs SQL for browsing/mutation. It sends **intent**
(`BrowseRequest`, `MutateRequest`) and the adapter translates to its native
query language.

### Backend (`src-tauri/`)

- **`commands/`** - the Tauri command surface the frontend invokes (db, ai,
  store, rail).
- **`db/`** - the connection [registry](reconnect.md) (open adapters, per-id
  locks) and the transparent [reconnect supervisor](reconnect.md).
- **`store/`** - the [encrypted local store](store-encryption.md): connection
  profiles, settings, AI conversations, SSH known hosts.
- **`ai/`** - providers, the streaming/tool loop, the [approval gate](ai-internals.md),
  and the MCP bridge.

### Adapters (`adapter-api/` + `src-adapters/`)

Every database implements the same `Adapter` + `Factory` traits from
`adapter-api`. Methods that a driver can't support default to `Unsupported`, so a
new adapter grows one capability at a time. Each adapter ships a `manifest.toml`
of capability flags that **drive what the UI exposes**. See
[Adding a database adapter](adding-an-adapter.md).

Adapters are registered at **compile time**: `adapters.toml` (the enrollment
list) + path deps in `src-tauri/Cargo.toml`, with `src-tauri/build.rs`
generating the registration code and failing the build if those drift apart.

## <a id="ssh"></a>SSH tunneling

Networked adapters (MySQL, PostgreSQL, MongoDB, Redis) share the **`adapter-ssh`**
crate (built on `russh`). It opens a local listener, forwards over an SSH
`direct-tcpip` channel to the database from the jump host's perspective, pins the
host key on first use (SHA-256 fingerprints stored in the encrypted store),
keeps the tunnel alive, and reuses it across operations. SQLite has no tunnel
(local file). User-facing detail: [SSH tunnels](../guide/ssh-tunnels.md).

## Cross-cutting flows

- **Opening a connection**: command → `Factory::connect(profile)` (decrypted from
  the store) → adapter pings → added to the registry → schema loads.
- **Running a query**: command → registry looks up the adapter →
  [`with_retry`](reconnect.md) wraps the call → adapter executes natively →
  rows stream back.
- **AI tool call**: model emits a tool call → [tier classification + approval
  gate](ai-internals.md) → on approval, the same query path runs.

## See also

- [Adding a database adapter](adding-an-adapter.md)
- [AI internals](ai-internals.md)
- [The encrypted store](store-encryption.md)
- [Reconnect supervisor](reconnect.md)
