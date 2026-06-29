# AI internals

How the AI subsystem works under the hood. For the user-facing guarantees, see
[AI safety](../guide/ai-safety.md). Code lives in `src-tauri/src/ai/`.

## Providers

`ProviderKind` (`src-tauri/src/ai/mod.rs`) has these variants:

| Kind | Transport | Tools? |
|---|---|---|
| `Echo` | none (loops input back, for UI testing) | no |
| `LlamaLocal` | local `llama-server` (OpenAI shape) | **yes** |
| `Openai` | `/v1/chat/completions` | **yes** |
| `OpenaiCompatible` | user `base_url`, OpenAI shape (Ollama, Groq, …) | **yes** |
| `Anthropic` | `/v1/messages` | no (streaming chat) |
| `Gemini` | `…:streamGenerateContent` | no (streaming chat) |
| `ClaudeCli`, `CodexCli`, `GeminiCli`, `Opencode`, `Kilo`, `Antigravity` | subprocess CLI, headless | no (own agent loop; tools via MCP) |

`supports_tools()` decides the path. Providers that return `false` run in
streaming-only mode (`complete()`); tool-capable providers run the tool loop
(`complete_once()`). CLI providers run their own agent loop and reach the
database through the [MCP bridge](#mcp-bridge).

## The tools

The catalog (`src-tauri/src/ai/tools/catalog.rs`) exposes:

| Tool | Purpose | Gating |
|---|---|---|
| `list_schemas` | list databases/schemas | auto via `read_schema` (default on) |
| `list_tables` | list tables/views in a schema | auto via `read_schema` |
| `describe_table` | columns, PK, indexes, FKs | auto via `read_structure` (default on) |
| `call_query` (aka `call_sql`, `run_query`) | execute a query, returns ≤25 rows | **tier-gated** (below) |
| `write_query_tab` | place SQL in the user's editor (does NOT execute) | gated by `write_query_tab` flag |
| `open_object_tab` | open an editor for a trigger/table | gated by `write_query_tab` flag |
| `publish_notify` | NOTIFY / PUBLISH | gated by `publish_notify` flag |
| `subscribe_channel` | LISTEN / SUBSCRIBE | gated by `subscribe_channel` flag |

`catalog_scoped(cross_database, database_is_schema)` drops `list_schemas` when
cross-database is off on MySQL/SQLite-style adapters (where a schema *is* a
database).

## The approval gate

`src-tauri/src/ai/tools/approval.rs`.

- **`ApprovalRegistry`** registers a one-shot channel keyed by request id; `wait`
  blocks (≈5-minute timeout) until the UI calls `resolve(id, decision)` with
  `Approve`/`Deny`.
- **`AutoApprovalFlags`** are the per-tier opt-ins. Defaults: `read_schema` and
  `read_structure` are **true** (shape reads are safe); everything else is
  **false**. There's a legacy `call_query` master switch that covers all
  non-destructive tiers for back-compat.
- **`allows_tier(tier)`** is the gate. The crucial invariant:

  ```rust
  if tier == QueryTier::Destructive { return false; } // never auto-approves
  ```

  No flag can auto-approve the destructive tier.

### Tier classification

`src-tauri/src/ai/tools/tiers.rs`, `classify_sql()` (checked in order):

1. `DROP` / `TRUNCATE` / `ALTER … DROP` → **Destructive**
2. `CREATE …` → **Create**
3. `DELETE … WHERE` → **Delete**; `DELETE` without a top-level WHERE → **Destructive**
4. `UPDATE … WHERE` → **Write**; `UPDATE` without a top-level WHERE → **Destructive**
5. `INSERT` / merge / upsert → **Write**
6. everything else (`SELECT`, `SHOW`, `EXPLAIN`, CTE `SELECT`, `PRAGMA`) → **Read**

`has_top_level_where()` only counts a `WHERE` at parenthesis depth 0 - a WHERE
inside a subquery doesn't save a no-WHERE delete from being Destructive (fail
safe). `classify_batch()` splits on `;` (respecting string/identifier quoting)
and returns the **strongest** tier, so `SELECT 1; DROP TABLE x` is Destructive.

### Cross-database guard

Default `cross_database = false`. `references_other_database()`
(`tools/dispatch.rs`) rejects `USE <other_db>` and `other_db.table` references
(matched against real database names from `list_schemas` - table aliases and
table-qualified columns don't false-positive). On PostgreSQL, schemas inside the
one connected database are not treated as other databases.

## Local model

`src-tauri/src/ai/llama_server.rs` resolves the `llama-server` binary
(`DBTABLE_LLAMA_SERVER` env → `which` → known install paths) and spawns it on
`127.0.0.1:<auto-port>` with `--ctx-size 8192 --n-gpu-layers 999 --jinja`
(Jinja templates so tool-call formatting works for Qwen2.5/Llama3.1/Mistral).
One server per chat session; `unload()` SIGTERMs it.

Models live in the app-data dir's `ai-models/` (overridable with
`DBTABLE_MODEL_DIR`). The catalog (`models_catalog.rs`) currently lists
Qwen2.5-Coder **3B / 7B / 14B** (q4_k_m). Downloads stream to a `.part` file,
resume, and are SHA-256-verified (catalog hashes are still `TODO` placeholders at
time of writing).

## <a id="mcp-bridge"></a>MCP bridge

`src-tauri/src/ai/mcp_bridge.rs` runs a loopback TCP JSON-RPC 2.0 server
(`127.0.0.1:<random port>`, token-authenticated - the client's first line must be
`{"token":"<32 hex>"}`). It advertises the **same tool list** and pipes calls
into the **same `dispatch()`** with the **same `ApprovalRegistry` /
`AutoApprovals`** - so an external MCP agent (or a CLI provider) gets the same
approval cards and cross-database guards as the in-app assistant. There is no
separate, less-guarded path.

## Retries & runaway guards

- Tool-loop retries target only transient provider failures and don't bypass the
  approval gate.
- CLI providers (`cli_provider.rs`) cap wall-clock (~600s) and output (~8 MB),
  with idle detection, so a wedged CLI can't hang the chat.

## See also

- [AI safety](../guide/ai-safety.md) - the user-facing guarantees
- [Architecture overview](architecture.md)
