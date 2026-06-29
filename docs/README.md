# Table Relay documentation

Documentation for **Table Relay**, a multi-database desktop workbench (MySQL ·
PostgreSQL · SQLite · MongoDB · Redis) with an approval-gated AI assistant.

For install instructions and a feature overview, see the [project README](../README.md).

## User guide

For people using the app.

- [Connections](guide/connections.md) - adding, editing, and importing connections
- [SSH tunnels](guide/ssh-tunnels.md) - reaching databases behind a jump host
- [Workspace & navigation](guide/workspace.md) - tabs, the rail, favorites, tags, the schema sidebar
- [Querying & editing data](guide/querying-and-editing.md) - the SQL editor, data grid, and schema editor
- [Routines & triggers](guide/routines-and-triggers.md) - stored procedures, functions, views, triggers
- [Diagrams (ERD)](guide/diagrams.md) - entity-relationship diagrams
- [Realtime](guide/realtime.md) - Pub/Sub, LISTEN/NOTIFY, change streams
- [Process list](guide/process-list.md) - monitor and kill server processes
- [AI assistant](guide/ai-assistant.md) - using the assistant and what it can do
- [AI safety](guide/ai-safety.md) - how the assistant is sandboxed (read this if you connect to production)
- [Import & export](guide/import-export.md) - moving data and connections in and out
- [Settings](guide/settings.md) - every settings section explained
- [Keyboard shortcuts](guide/keyboard-shortcuts.md)

## Developer guide

For people building on or contributing to the app.

- [Architecture overview](dev/architecture.md) - how the pieces fit together
- [Adding a database adapter](dev/adding-an-adapter.md) - the adapter system end to end
- [AI internals](dev/ai-internals.md) - providers, the tool loop, and the approval gate
- [The encrypted store](dev/store-encryption.md) - at-rest encryption, migrations, recovery
- [Reconnect supervisor](dev/reconnect.md) - transparent reconnection and the query gate

## Operations

- [Auto-update setup](auto-update.md) - signing keys + CI artifacts for the Tauri updater

---

> **A note on accuracy.** These docs describe the code as of writing and cite
> the files that implement each behavior. If a doc and the code disagree, the
> code wins - please open an issue or PR to fix the doc.
