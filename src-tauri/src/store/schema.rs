use rusqlite::Connection;
use rusqlite_migration::{M, Migrations};

use super::StoreError;

pub fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    // History, never rewritten. If a feature is removed, leave the migration
    // that created it in place so existing store.db files still match and
    // rusqlite_migration doesn't see a "DB ahead of code" version and abort.
    let migrations = Migrations::new(vec![
        M::up(include_str!("migrations/0001_initial.sql")),
        M::up(include_str!("migrations/0002_marks.sql")),
        M::up(include_str!("migrations/0003_rail_tiles.sql")),
        M::up(include_str!("migrations/0004_ai_settings.sql")),
    ]);
    migrations
        .to_latest(conn)
        .map_err(|e| StoreError::Migration(e.to_string()))
}
