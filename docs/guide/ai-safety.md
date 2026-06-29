# AI safety

Table Relay's assistant is designed so it can be **helpful without being
dangerous**: it can *look* at your schema freely, but it can never *act* on your
database without a human in the loop. If you point the assistant at a production
database, read this page.

The guarantees here are enforced in the Rust backend
(`src-tauri/src/ai/tools/approval.rs`), not in the UI - so they hold for the
in-app assistant **and** for any external agent driving Table Relay through the
[MCP bridge](../dev/ai-internals.md#mcp-bridge).

## 1. Nothing runs without approval

- **Reading shape is free.** Listing databases/tables and describing a table
  happen without a prompt (these are auto-approved by default) so the model has
  context to help you.
- **Executing anything against the database is gated.** When the assistant wants
  to run a statement, an **Approve / Deny card** appears in the chat showing the
  *exact* statement first. Nothing executes until you click Approve.
- The approval prompt times out (about 5 minutes) if left unanswered, so a
  pending call can't hang forever.

## 2. Per-operation permissions - and destructive always asks

Statements are classified into tiers. You can opt into auto-approving the
lower-risk tiers (in the AI permissions panel) so routine work isn't a click-fest
- but the destructive tier can never be auto-approved.

| Tier | Examples | Auto-approve? |
|---|---|---|
| **Read** | `SELECT`, `SHOW`, `EXPLAIN`, Mongo `find`/`aggregate`, Redis `GET` | Opt-in |
| **Write** | `INSERT`, `UPDATE … WHERE`, Mongo `insert`/`update`, Redis `SET` | Opt-in |
| **Create / DDL** | `CREATE TABLE`/`INDEX`/`VIEW`/`DATABASE` | Opt-in |
| **Delete** | `DELETE … WHERE`, Mongo `deleteOne`/`deleteMany(filter)`, Redis `DEL` | Opt-in |
| **Destructive** | no-`WHERE` `DELETE`/`UPDATE`, `DROP`, `TRUNCATE`, Mongo `drop`/`dropDatabase` | **Never - always prompts** |

Notes on how classification stays conservative:

- A `WHERE` only "counts" if it's at the **top level** of the statement. A
  `DELETE` whose only `WHERE` sits inside a subquery is treated as **Destructive**
  (no-WHERE) - i.e. when in doubt, it asks.
- A **batch** is judged by its most dangerous statement. `SELECT 1; DROP TABLE x`
  is Destructive as a whole, so it hits the always-ask gate.

## 3. Cross-database access is off by default

The assistant is locked to the active connection's current database. Attempts to
reach another database are **rejected** - both `USE <other_db>` statements and
qualified `other_db.table` references (matched against the real database names
from your server). To allow it, turn on **cross-database access** in the AI
permissions panel.

(On PostgreSQL, "schemas" within the one connected database are not other
databases, so normal schema-qualified access like `public.users` is fine.)

## 4. Private and local options

- **On-device model**: with **Local Llama**, the model runs locally via
  `llama.cpp` and **no schema or data leaves your machine.**
- **CLI providers**: run against the agent you authenticated; Table Relay never
  reads, stores, or transmits those credentials.
- **Hosted providers**: schema/context is sent to the provider you chose (and
  only that one) to answer your prompt; API keys are stored locally and encrypted
  at rest.

## 5. Resilient, not runaway

The tool loop retries only *transient* provider failures (network timeouts, rate
limits, upstream 5xx) and guards against runaway repeat calls; CLI providers have
wall-clock and output-size caps. **Retries never bypass the approval gate** - a
re-attempted query still shows the card.

## What this does NOT protect against

Be honest with yourself about the threat model:

- Once **you** approve a statement, it runs with your database privileges. The
  gate stops the *model* from acting unilaterally; it doesn't stop a bad query
  you approved.
- Hosted providers see the schema/context you send them. Use Local Llama if that
  matters.
- At-rest key storage uses a key compiled into the binary, which is recoverable
  by a determined attacker (see [Security](../../README.md#security)). This is
  not yet hardened for high-value production secrets.

## Related

- [AI assistant](ai-assistant.md) - setup and use
- Developer detail: [AI internals](../dev/ai-internals.md) - the tool loop and gate
