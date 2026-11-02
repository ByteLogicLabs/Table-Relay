-- Repurpose pinned_tables into the connection-rail tile store.
-- Each row = one (server, database) tile.
-- Removes the stale table/view/routine rows from the scrapped marks feature,
-- keeping only `object_kind = 'database'`. The table itself is renamed to
-- rail_tiles to match the new concept.
DELETE FROM pinned_tables WHERE object_kind != 'database';
ALTER TABLE pinned_tables RENAME TO rail_tiles;
