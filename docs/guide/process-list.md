# Process list

Monitor and kill active server processes/connections. Available on **MySQL,
PostgreSQL, MongoDB, and Redis** (not SQLite, which is a local file).

## Using it

- Open the process list for a connection to see active processes - columns vary
  by driver but typically include id, user, command/state, time, and the running
  statement.
- **Select** one or more rows and **kill** them - useful for clearing a stuck or
  long-running query.
- **Auto-refresh** can be toggled to keep the list live, or refresh on demand.

Availability is driven by each adapter's `process_list` capability.

## Related

- [Querying & editing data](querying-and-editing.md)
