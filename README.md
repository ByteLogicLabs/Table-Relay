# Table Relay

A multi-database desktop workbench for browsing, querying, editing, and diagramming your data — with a built-in AI assistant. One app for **MySQL, PostgreSQL, SQLite, MongoDB, and Redis**, built with [Tauri](https://tauri.app) (Rust + React).

---

## Features

- **Data grid** — browse, filter, sort, and inline-edit rows. Editable JSON tree view for MongoDB documents.
- **SQL editor** — Monaco-based editor with schema-aware autocompletion, multi-statement execution, a query log, and a destructive-query warning before you run a `DELETE`/`UPDATE`/`DROP`.
- **Schema editor** — create and alter tables, columns, indexes, and foreign keys; the app emits dialect-correct DDL per driver.
- **Diagrams** — auto-laid-out entity-relationship diagrams from your schema.
- **Realtime** — publish/subscribe against Redis Pub/Sub and Postgres `LISTEN`/`NOTIFY`.
- **Process list** — view and kill running queries/connections (where the driver supports it).
- **AI assistant** — chat about your schema and data with OpenAI, Anthropic, Google Gemini, any OpenAI-compatible endpoint (Ollama, Groq, LM Studio), or a local GGUF model. The assistant inspects schema freely but **every query it runs goes through an explicit approval prompt** before touching the database.
- **SSH tunneling** — connect to MySQL and PostgreSQL behind a jump host (password or key auth), with trust-on-first-use host-key pinning.

## Supported databases

| Driver | Browse/Edit | SQL/Query | Schema editor | Diagram | Realtime | SSH tunnel |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| MySQL | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| PostgreSQL | ✅ | ✅ | ✅ | ✅ | ✅ (`LISTEN`/`NOTIFY`) | ✅ |
| SQLite | ✅ | ✅ | ✅ | ✅ | — | — |
| MongoDB | ✅ | ✅ | ✅ | — | ✅ (change streams) | — |
| Redis | ✅ | ✅ | — | — | ✅ (Pub/Sub) | — |

Exact capabilities per driver are declared in each adapter's `manifest.toml` and drive what the UI exposes.

---

## Getting started

### Prerequisites

- **Node.js** 20+ (developed against 22.x)
- **Rust** 1.86+ and the Tauri prerequisites for your OS — see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/) (Xcode CLT on macOS; `webkit2gtk`/`build-essential` on Linux; the C++ build tools + WebView2 on Windows).

### Run in development

```bash
npm install
npm run tauri:dev
```

The first Rust build compiles all five database adapters and can take several minutes; subsequent builds are incremental.

> **AI keys are configured in-app, not via environment variables.** Open **Settings → AI Providers**, add a credential, and activate it. Keys are stored locally on your machine (see [Security](#security)). There is no required `.env` file to run the app.

### Build a release bundle

```bash
npm run tauri:build
```

Produces a native installer/app for your platform under `src-tauri/target/release/bundle/`.

### Other scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server only (frontend, no Tauri shell) |
| `npm run build` | Type-check + build the frontend bundle |
| `npm run lint` | `tsc --noEmit` type check |
| `npm run tauri:dev` | Run the full desktop app in dev mode |
| `npm run tauri:build` | Build the distributable desktop app |

---

## Architecture

```
src/                  React + TypeScript UI (Vite)
  features/           One folder per workspace tab (data-grid, sql-editor, schema, diagram, realtime, ai-chat, …)
  lib/                IPC wrappers, stores, Monaco/SQL helpers
  state/              Lightweight external stores (useSyncExternalStore)
src-tauri/            Rust backend (Tauri host)
  src/commands/       Tauri command surface (db, ai, store, rail)
  src/ai/             AI providers, streaming, tool-calling + approval flow
  src/db/             Connection registry, reconnect supervisor, subscriptions
  src/store/          Local SQLite store (connection profiles, settings) via rusqlite
  adapter-api/        Shared `Adapter` trait, manifest, intent types
  adapter-ssh/        SSH tunnel crate (russh)
src-adapters/         One folder per database driver (backend crate + frontend hooks + manifest)
  {mysql,postgres,sqlite,redis,mongo}/
```

Each database is a self-contained adapter. To add a new one: drop a folder under `src-adapters/`, declare its capabilities in `manifest.toml`, implement the `Adapter` trait, list it in `src-tauri/adapters.toml`, and add the path dependency in `src-tauri/Cargo.toml`. `build.rs` generates the registration code at build time.

---

## Security

Table Relay is currently in **development mode**, and you should treat it accordingly:

- **Connection credentials and AI API keys are stored unencrypted** on your machine — in the app's local SQLite store (`store.db` in your OS app-data directory) and, for AI keys, in the WebView's `localStorage`. At-rest encryption / OS-keychain storage is planned but **not yet implemented**.
- The AI assistant can read your schema without prompting, but **all queries it executes require explicit approval** in the chat panel.
- Don't use this build to hold credentials for sensitive production systems until at-rest protection lands.

Do not commit `.env` files or any file containing real keys; the repo's `.gitignore` excludes `*.env`, but verify before pushing.

---

## License

Not yet specified.
