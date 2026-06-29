# Realtime

Subscribe to server-pushed events and publish test messages. The mechanism
depends on the driver:

| Driver | Mechanism | Patterns |
|---|---|---|
| **Redis** | Pub/Sub | glob patterns (`*`, `prefix:*`) |
| **PostgreSQL** | `LISTEN` / `NOTIFY` | literal channel names |
| **MongoDB** | change streams | collection-scoped |

## Using it

1. Open the **Realtime** tab on a connection whose driver supports it.
2. Enter a channel/pattern and **subscribe**.
3. Incoming events stream into a live list (capped at ~2000 in-memory events so
   it never grows unbounded).
4. Optionally **publish** a test message back to a channel
   (Redis `PUBLISH` / Postgres `NOTIFY`).

The last-used pattern is remembered per tab, and all subscribe/publish lifecycle
events are recorded in the query log.

> The AI assistant can also publish/subscribe via its `publish_notify` and
> `subscribe_channel` tools - both gated by [approval](ai-safety.md).

## Related

- [Querying & editing data](querying-and-editing.md)
- [AI assistant](ai-assistant.md)
