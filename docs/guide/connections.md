# Connections

A *connection* is a saved profile for one database server. Connections live in
the left rail; opening one connects and loads its schema.

## Add a connection

1. Click **+ New connection** (in the rail or the "Open connection" picker).
2. Pick a driver: **MySQL, PostgreSQL, SQLite, MongoDB, or Redis**.
3. Fill in the fields. They change per driver - SQLite asks for a file path,
   the network drivers ask for host/port/user/password/database.
4. Click **Save**.

> **Saving does not connect or test.** Creating a connection only stores the
> profile. To connect, open it from the rail or the picker. (This is deliberate
> so adding many connections is fast and never blocks on a slow handshake.)

### Paste a connection string

The Add Connection form has a paste-to-fill field at the top. Paste a full URI
(for example `postgresql://user:pass@host:5432/db` or a
`mongodb+srv://…` string) and the fields populate from it. For MongoDB, the
full URI is kept in the host field so options like `authSource` are preserved.

## Edit, duplicate, delete

Right-click a connection (in the rail or the picker) for **Edit connection**,
**Copy info**, and **Delete**.

- **Copy info** copies the full connection - including credentials and a
  ready-to-use connection string - to your clipboard. (It puts the plaintext
  password on the system clipboard, so other apps can read it; use with care.)

## The connection sidebar (rail)

Open connections appear as tiles in the rail. Its width is configurable in
**Settings → Appearance → Sidebar**:

- **Auto** - collapsed, expands on hover (default)
- **Expanded** - always wide
- **Collapsed** - always narrow

Tiles can be reordered by drag and drop. A small **SSH** badge marks connections
that route through a tunnel (see [SSH tunnels](ssh-tunnels.md)).

## Open a database

For servers that host multiple databases, the **Open database** picker lists
them. The list is cached per connection and refreshed in the background, so
re-opening it is instant while still picking up new databases.

## Importing connections

You don't have to re-enter every server by hand. **Import connections** reads a
Table Relay connections export and recreates the profiles. A password prompt
fills in any secret the export doesn't carry. See [Import & export](import-export.md)
for data (rows) import/export.

## Related

- [SSH tunnels](ssh-tunnels.md)
- [Querying & editing data](querying-and-editing.md)
- Developer detail: [the encrypted store](../dev/store-encryption.md) (where profiles are kept)
