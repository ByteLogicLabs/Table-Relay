-- Small encrypted app-state key/value store.
--
-- This replaces WebView localStorage for persistent UI preferences that do not
-- deserve a dedicated relational table. Values are JSON strings owned by the
-- frontend and encrypted at rest with the rest of store.db.enc.
CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
