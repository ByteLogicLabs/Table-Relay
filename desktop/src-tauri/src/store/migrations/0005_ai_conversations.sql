-- Conversations and messages for persistent AI chat history.
-- Messages are stored as flat rows; the session reconstructs them
-- on load by ordering on `created_at`.

CREATE TABLE ai_conversations (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL DEFAULT 'New Chat',
    connection_id TEXT,
    provider_kind TEXT,
    model       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_ai_conversations_updated
    ON ai_conversations(updated_at DESC);

CREATE TABLE ai_messages (
    id              TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,   -- 'user' | 'assistant' | 'system' | 'tool'
    content         TEXT NOT NULL DEFAULT '',
    tool_calls_json TEXT,            -- JSON array of tool calls (assistant only)
    tool_call_id    TEXT,            -- for tool-result messages
    kind            TEXT,            -- 'chat' | 'fix' | 'explain' | 'generate'
    created_at      TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_messages_conv
    ON ai_messages(conversation_id, created_at);
