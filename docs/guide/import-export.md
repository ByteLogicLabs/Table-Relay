# Import & export

Table Relay moves three different things in and out: **connections**, **data
(rows)**, and **query results**.

## Import connections

Recreate connection profiles from a Table Relay connections export instead of
re-entering them. See [Connections → importing](connections.md#importing-connections)
for details.

## Import data

Load rows into the active connection's current database from a file:

- `.sql` - runs the statements
- `.csv` - column-mapped rows
- `.json` - array of records

Available where the driver's manifest declares import support (document stores
like MongoDB ingest CSV/JSON via inserts).

## Export

Export a **query result** or a **whole connection** to:

- **CSV**, **TSV**
- **JSON**, **NDJSON**
- **Excel**
- **SQL** `INSERT` statements

Exports show a progress dialog and can be cancelled - useful for large tables.

## Related

- [Connections](connections.md)
- [Querying & editing data](querying-and-editing.md)
