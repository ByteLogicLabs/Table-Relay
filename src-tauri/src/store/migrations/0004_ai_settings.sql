-- AI provider credentials + preferences, one row per provider kind.
-- Plaintext by design (matches the rest of the store — encryption deferred).
-- `options_json` is a free-form JSON blob so we can add new provider
-- preferences later without a schema migration.
CREATE TABLE ai_settings (
    kind TEXT PRIMARY KEY NOT NULL,
    api_key TEXT,
    base_url TEXT,
    model TEXT,
    options_json TEXT,
    updated_at TEXT NOT NULL
);
