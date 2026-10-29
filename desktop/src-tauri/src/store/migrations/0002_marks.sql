-- Historical v2. The marks feature was removed from the product but the
-- table is kept so existing store.db files (user_version = 2) can still
-- be opened. Remove from this migration only if you also bump all users'
-- databases down (which rusqlite_migration can't do).
CREATE TABLE IF NOT EXISTS pinned_tables (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  schema_name TEXT NOT NULL,
  object_name TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  label       TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pinned_server ON pinned_tables(server_id, order_index);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pin ON pinned_tables(server_id, schema_name, object_name, object_kind);
