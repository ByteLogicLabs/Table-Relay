# Workspace & navigation

How you move around the app: tabs, the connection rail, favorites, tags, and the
schema sidebar.

## Tabs

Everything you open is a tab: data browse, SQL/query, table structure, diagrams,
routines, triggers, and realtime subscriptions. Tabs show status badges (an
unsaved-changes dot, a loading spinner). Right-click a tab for **close**, **close
others**, **close left/right**. Close the active tab with `Cmd/Ctrl+W`.

Open tabs, the active tab per connection, focused tile, and panel widths are
persisted, so your layout survives a reload.

## Connection rail (left)

A vertical list of your open connections. Click a tile to switch focus. The
rail's width is set in **Settings → Appearance → Sidebar**:

- **Auto** - collapsed, expands on hover (default)
- **Expanded** - always wide
- **Collapsed** - always narrow

Tiles can be reordered by drag and drop. An **SSH** badge marks tunneled
connections. Right-click a tile for edit, copy info, and disconnect actions.

## Schema sidebar

For the focused connection, the sidebar shows a tree of schemas, tables, views,
functions, procedures, and triggers. Filter by name with the search box, and
right-click any item to open its data, view its structure, open it in a query,
or open its ERD. A refresh button reloads the schema.

## Favorites (home screen)

When no connection is open, the home screen shows your **favorites**: star a
connection to pin it, and group favorites with drag-and-drop into named groups
(create/rename/delete). Each favorite has quick connect/edit/delete actions.

## Tags

Connections can carry **multiple colored tags** (gray, blue, green, red, purple,
yellow, cyan, pink) for organizing many servers. Tags show on the connection in
the rail and pickers.

## Database picker (PostgreSQL)

On PostgreSQL, where one connection can host several databases, the database
picker switches between them without reconnecting. (On MySQL/SQLite a database
and a schema are the same thing.)

## Related

- [Connections](connections.md)
- [Settings](settings.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
