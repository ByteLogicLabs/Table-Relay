//! Tool definitions exposed to the model as the OpenAI-compatible `tools: [...]`
//! list, plus scope filtering for cross-database access.

use serde::Serialize;
use serde_json::{json, Value};

/// Shape sent to the model as part of `tools: [...]`. Serde renames match
/// the OpenAI function-calling schema exactly.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub kind: &'static str, // always "function"
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolFunction {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

/// Catalog filtered for the current scope.
///
/// `cross_database` — whether the user granted cross-database access.
/// `database_is_schema` — true for MySQL/SQLite-style adapters where a "schema"
///   IS a database. For those, with cross-DB off, we DROP `list_schemas`: the
///   active DB is already stated in the context, and exposing the tool only
///   invited weak models to loop-call it and enumerate databases they can't
///   reach. For Postgres-style adapters (database ≠ schema) `list_schemas`
///   lists the schemas WITHIN the active database — always safe and necessary
///   for the model to discover what it can query — so we keep it regardless.
pub fn catalog_scoped(cross_database: bool, database_is_schema: bool) -> Vec<ToolDef> {
    let mut tools = catalog_all();
    if !cross_database && database_is_schema {
        tools.retain(|t| t.function.name != "list_schemas");
    }
    tools
}

fn catalog_all() -> Vec<ToolDef> {
    vec![
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "list_schemas",
                description: "List every database/schema on the current connection. Returns an array of schema names.",
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "required": []
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "list_tables",
                description: "List every table and view in a schema. Returns `{ name, kind }` entries.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name. If omitted, uses the active schema from the system context." }
                    },
                    "required": []
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "describe_table",
                description: "Get the full column list, primary key, indexes, and foreign keys for a specific table.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "schema": { "type": "string", "description": "Schema name. If omitted, uses the active schema." },
                        "table": { "type": "string", "description": "Table name." }
                    },
                    "required": ["table"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "call_query",
                description: "YOU execute this query against the live database and receive the rows back — this is how you actually run queries and get data. Works for any database: write SQL for SQL databases, or the native query (e.g. a Mongo `db.collection.find(...)`) for document/other stores. May require user approval (the user sees the query and approves or denies); with auto-approval granted it runs without prompting. Use whenever the task needs real data or a real change: reads / counts / samples, and writes the user asked you to perform. This is the tool for getting an answer or doing the work. Keep it to a single statement and add a limit to reads unless the user explicitly asked for everything.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "The query to execute (SQL, or the database's native query syntax). One statement. Prefer a limited read." }
                    },
                    "required": ["sql"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "write_query_tab",
                description: "Does NOT run anything — it only places SQL into the user's query editor for THEM to review and run manually. Use ONLY when the user explicitly wants the SQL in their editor (\"put it in a tab\", \"write/draft/scaffold this query\", \"open in editor\", or to tweak before running). REQUIRES USER APPROVAL (they see a diff). If the user wants an answer or wants the work actually done, use `call_query` instead — writing a tab leaves the query UNEXECUTED, so do not treat it as completing a data task.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string", "description": "The SQL to write into the editor. Multi-statement OK; formatted nicely." },
                        "mode": {
                            "type": "string",
                            "enum": ["new", "replace"],
                            "description": "`new` to open a fresh query tab; `replace` to overwrite the content of the currently-focused query tab (falls back to `new` if no query tab is active)."
                        },
                        "title": { "type": "string", "description": "Optional tab title — defaults to a short snippet of the SQL." }
                    },
                    "required": ["sql", "mode"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "open_object_tab",
                description: "Open a dedicated EDITOR tab for a database object so the user can review and save it — NOT a plain SQL query tab. Use this when the user wants to create or edit a TRIGGER or a TABLE (its columns/structure), e.g. \"create a trigger\", \"edit this trigger\", \"open the trigger editor\", \"create a table\", \"edit the table structure\". For `trigger`, you may pass `sql` containing a complete `CREATE TRIGGER …` statement to prefill the editor (recommended — the user just reviews and clicks Save). For an existing object pass its `name` to open it for editing; omit `name` to start a blank new-object editor. Does NOT execute anything; the user saves from the editor. REQUIRES USER APPROVAL. To actually run DDL yourself instead, use `call_query`.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "object": {
                            "type": "string",
                            "enum": ["trigger", "table"],
                            "description": "Which editor to open: `trigger` (CREATE TRIGGER editor) or `table` (table structure / create-table editor)."
                        },
                        "name": { "type": "string", "description": "Existing object name to open for editing. Omit to open a blank new-object editor." },
                        "schema": { "type": "string", "description": "Schema/database the object lives in. Defaults to the active schema from the context." },
                        "sql": { "type": "string", "description": "Optional. For `trigger`, a full `CREATE TRIGGER …` statement to prefill the editor buffer so the user can review and save it." }
                    },
                    "required": ["object"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "publish_notify",
                description: "Publish a realtime message to a pub/sub channel. Translates to Postgres `NOTIFY <channel>, '<payload>'` or Redis `PUBLISH <channel> <payload>` depending on the active adapter. REQUIRES USER APPROVAL before sending. Use when the user asks you to publish, notify, send, or trigger on a channel.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "channel": { "type": "string", "description": "Channel/topic name. Plain identifier on Postgres (no wildcards); any string on Redis." },
                        "payload": { "type": "string", "description": "Message body. Plain text or JSON-stringified. Keep under 8000 bytes on Postgres." }
                    },
                    "required": ["channel", "payload"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: ToolFunction {
                name: "subscribe_channel",
                description: "Start a realtime subscription on the user's realtime tab. Prefills the channel input and triggers the Start button. Postgres requires a literal channel name (no wildcards). Redis accepts globs like `foo.*` (runs PSUBSCRIBE) or plain names (runs SUBSCRIBE). REQUIRES USER APPROVAL. Use when the user asks you to subscribe, listen, watch, or monitor a channel.",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "channel": { "type": "string", "description": "Channel name / Redis glob. On Postgres: literal identifier only." }
                    },
                    "required": ["channel"]
                }),
            },
        },
    ]
}
