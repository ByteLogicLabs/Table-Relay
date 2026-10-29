# Routines & triggers

Table Relay has dedicated editors for stored database objects, available where
the driver supports them.

## Routines (stored procedures, functions, views)

Available on **MySQL** and **PostgreSQL**.

- Open a routine from the sidebar tree to load its current definition into a
  Monaco editor, or scaffold a new one.
- Edit the DDL with syntax highlighting, **format** it (`Cmd/Ctrl+Shift+F`), and
  **undo/redo** your changes.
- **Run** the definition to create or replace the object; results and errors go
  to the query log.
- An unsaved-changes dot marks edits you haven't run yet; in-progress edits
  survive switching tabs.
- The **Sparkles** button hands the current object to the AI assistant to help
  draft or modify it (subject to the usual [AI approval](ai-safety.md)).

## Triggers

Available on **MySQL**, **PostgreSQL**, and **SQLite**.

- Create or edit triggers (BEFORE/AFTER, INSERT/UPDATE/DELETE) in the same kind
  of Monaco DDL editor, with trigger-specific scaffolding.
- Deploy by running the `CREATE TRIGGER` statement; results log to the query log.
- Drafts persist across tab switches so unsaved work isn't lost.
- The AI assistant can pre-fill a generated `CREATE TRIGGER` for you to review
  before running.

## Driver support at a glance

| Feature | MySQL | PostgreSQL | SQLite | MongoDB | Redis |
|---|:---:|:---:|:---:|:---:|:---:|
| Routines | yes | yes | - | - | - |
| Triggers | yes | yes | yes | - | - |

What's available is declared in each adapter's `manifest.toml`, so the UI only
offers these where the driver actually supports them.

## Related

- [Querying & editing data](querying-and-editing.md)
- [AI assistant](ai-assistant.md)
