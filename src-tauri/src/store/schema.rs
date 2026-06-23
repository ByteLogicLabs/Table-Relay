use rusqlite::Connection;
use rusqlite_migration::{M, Migrations, SchemaVersion};

use super::StoreError;

pub fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    // History, never rewritten. If a feature is removed, leave the migration
    // that created it in place so existing store.db files still match and
    // rusqlite_migration doesn't see a "DB ahead of code" version and abort.
    let defs = vec![
        M::up(include_str!("migrations/0001_initial.sql")),
        M::up(include_str!("migrations/0002_marks.sql")),
        M::up(include_str!("migrations/0003_rail_tiles.sql")),
        M::up(include_str!("migrations/0004_ai_settings.sql")),
        M::up(include_str!("migrations/0005_ai_conversations.sql")),
        M::up(include_str!("migrations/0006_app_state.sql")),
        M::up(include_str!("migrations/0007_connection_tags.sql")),
        M::up(include_str!("migrations/0008_connection_tags_multi.sql")),
    ];
    // Latest schema version == number of migrations (version is 1-based index).
    let known_latest = defs.len();
    let migrations = Migrations::new(defs);

    // DB-ahead-of-code tolerance. If a newer build (e.g. one installed by the
    // auto-updater) already migrated this store to a schema version higher than
    // this binary knows about, `to_latest` would try to migrate DOWN — and since
    // our migrations define no `.down()`, that errors. An older build then
    // treated that error as "corrupt" and WIPED the store. That's the data loss.
    //
    // A newer store is a strict superset: every table/column this build needs was
    // created by an earlier migration the newer store also ran. Extra columns or
    // tables the old code doesn't know about are simply ignored by SQLite. So when
    // the DB is ahead, the safe and correct action is to PROCEED WITHOUT MIGRATING
    // rather than fail (and certainly rather than reset).
    let current = match migrations.current_version(conn) {
        Ok(SchemaVersion::Inside(v)) => usize::from(v),
        Ok(SchemaVersion::Outside(v)) => usize::from(v),
        Ok(SchemaVersion::NoneSet) => 0,
        Err(e) => return Err(StoreError::Migration(e.to_string())),
    };
    if current > known_latest {
        // Newer store opened by an older build — read/write it as-is.
        crate::log::write_line(
            "store",
            &format!(
                "store schema v{current} is newer than this build's v{known_latest}; \
                 proceeding without migration (newer schema is a superset)"
            ),
        );
        return Ok(());
    }

    migrations
        .to_latest(conn)
        .map_err(|e| StoreError::Migration(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Backward-compat guard: an OLDER build opening a store written by a NEWER
    /// build (DB schema version ahead of code) must NOT error and must NOT lose
    /// data — it should proceed and read its data back untouched. This is the
    /// exact scenario (auto-updater bumps the schema, then an older/dev build
    /// runs) that previously wiped users' connections.
    #[test]
    fn db_ahead_of_code_is_tolerated() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Bring the DB to our current latest, then simulate a FUTURE migration by
        // bumping user_version past what this build knows and adding a column the
        // old code is unaware of.
        migrate(&mut conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN future_field TEXT;
             PRAGMA user_version = 999;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO connections (id, name, driver, host, port, ssh_enabled, is_favorite, created_at, updated_at) \
             VALUES ('1','keep','mysql','h',3306,0,0,0,0)",
            [],
        )
        .unwrap();

        // The older build opens it again: must succeed without resetting.
        migrate(&mut conn).expect("DB-ahead store must open, not error");

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM connections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "existing rows must be preserved, not wiped");
    }

    /// A normal (not-ahead) store still migrates to latest as before.
    #[test]
    fn fresh_db_migrates_to_latest() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        // The tags column from the latest migration must exist.
        let has_tags: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name='tags'",
                [],
                |r| r.get::<_, i64>(0).map(|c| c > 0),
            )
            .unwrap();
        assert!(has_tags, "latest migration (tags column) must be applied");
    }
}
