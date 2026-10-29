package com.brainfactory.db.engine

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** SQLite syntax through Brain DB's SQLite session, which is Android's own SQLite (the device's version). */
@RunWith(AndroidJUnit4::class)
class SqliteSyntaxTest : SyntaxSuite() {
    private val file = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "syntax.db")
    private lateinit var s: DbSession

    private fun profile(readOnly: Boolean = false) = ConnectionProfile(name = "syntax", driver = Driver.SQLITE, database = file.path, port = 0, readOnly = readOnly)

    @Before
    fun open() {
        file.delete()
        s = openSession(profile(), env)
        s.ok(
            """
            CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, score REAL, photo BLOB, born TEXT);
            CREATE TABLE notes (body TEXT);
            CREATE TABLE audit (what TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
            INSERT INTO people (name, city, score, born) SELECT 'Orang ' || i, CASE i % 3 WHEN 0 THEN 'Jakarta' WHEN 1 THEN 'Bandung' ELSE NULL END, i * 1.5, '2000-01-01' FROM n;
            """.trimIndent(),
        )
    }

    @After
    fun close() {
        if (::s.isInitialized) s.close()
        file.delete()
        log("SQLite: $statements statements so far")
    }

    @Test
    fun pragmasAndIntrospection() {
        log("Device SQLite " + s.scalar("SELECT sqlite_version()"))
        listOf(
            "PRAGMA table_info(people)", "PRAGMA table_xinfo(people)", "PRAGMA index_list(people)", "PRAGMA foreign_key_list(people)",
            "PRAGMA database_list", "PRAGMA journal_mode", "PRAGMA page_size", "PRAGMA page_count", "PRAGMA encoding",
            "PRAGMA integrity_check", "PRAGMA quick_check", "PRAGMA compile_options", "PRAGMA user_version", "PRAGMA foreign_keys",
            "SELECT * FROM sqlite_master", "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
            "EXPLAIN QUERY PLAN SELECT * FROM people WHERE id = 5", "EXPLAIN SELECT 1",
        ).forEach { sql ->
            classify(sql, SqlDialect.SQLITE, reading = true, pageable = sql.startsWith("SELECT"))
            s.ok(sql)
        }
        assertEquals(6, s.table("PRAGMA table_info(people)").rows.size)
        assertEquals("ok", s.scalar("PRAGMA integrity_check"))
        s.ok("PRAGMA user_version = 7")
        assertEquals("7", s.scalar("PRAGMA user_version").toString())
        classify("PRAGMA user_version = 7", SqlDialect.SQLITE, reading = false)
    }

    @Test
    fun queries() {
        val queries = mapOf(
            "SELECT city, COUNT(*) AS n, ROUND(AVG(score), 2) AS avg FROM people GROUP BY city ORDER BY n DESC" to 3,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT SUM(i) FROM n" to 1,
            "SELECT id, ROW_NUMBER() OVER (PARTITION BY city ORDER BY id) AS rn FROM people LIMIT 5" to 5,
            "SELECT * FROM people WHERE name LIKE 'Orang 1%' AND city IS NOT NULL" to 75,
            "SELECT name, CASE WHEN score > 100 THEN 'high' ELSE 'low' END AS level, COALESCE(city, '-') AS c FROM people LIMIT 3" to 3,
            "SELECT date('now') AS today, strftime('%Y', '2026-10-22') AS y, typeof(score) AS t FROM people LIMIT 1" to 1,
            "SELECT group_concat(id, '|') FROM (SELECT id FROM people ORDER BY id LIMIT 3)" to 1,
            "VALUES (1, 'a'), (2, 'b')" to 2,
            "SELECT [name], `city`, \"score\" FROM [people] WHERE \"id\" = 1" to 1,
            "SELECT 1 UNION SELECT 2 UNION ALL SELECT 2" to 3,
        )
        queries.forEach { (sql, rows) ->
            classify(sql, SqlDialect.SQLITE, reading = true)
            assertEquals(sql, rows, s.table(sql).rows.size)
        }
        assertEquals("1|2|3", s.scalar("SELECT group_concat(id, '|') FROM (SELECT id FROM people ORDER BY id LIMIT 3)"))
    }

    @Test
    fun typesAndBlobs() {
        s.ok("INSERT INTO people (id, name, score, photo, born) VALUES (1000, 'Bit', 0.25, X'00FF7F', NULL)")
        val row = s.table("SELECT * FROM people WHERE id = 1000")
        assertEquals(1000L, row.value(0, "id"))
        assertEquals(0.25, row.value(0, "score") as Double, 0.0)
        assertArrayEquals(byteArrayOf(0, -1, 127), row.value(0, "photo") as ByteArray)
        assertEquals(null, row.value(0, "born"))
        assertEquals("Halo 👋", s.scalar("SELECT 'Halo 👋'"))
    }

    @Test
    fun triggersViewsUpsertAndReturning() {
        s.ok(
            """
            CREATE TRIGGER people_ai AFTER INSERT ON people
            BEGIN
              INSERT INTO audit (what) VALUES ('insert ' || NEW.name);
              UPDATE people SET score = COALESCE(NEW.score, 0) + 1 WHERE id = NEW.id;
            END;
            CREATE VIEW cities AS SELECT city, COUNT(*) AS n FROM people GROUP BY city;
            CREATE UNIQUE INDEX people_name ON people (name);
            INSERT INTO people (name) VALUES ('Baru');
            """.trimIndent(),
        )
        assertEquals("insert Baru", s.scalar("SELECT what FROM audit"))
        assertEquals("1.0", s.scalar("SELECT score FROM people WHERE name = 'Baru'").toString())
        assertEquals(3, s.table("SELECT * FROM cities").rows.size)
        s.ok("INSERT INTO people (name, score) VALUES ('Baru', 5) ON CONFLICT (name) DO UPDATE SET score = excluded.score * 10")
        assertEquals("50.0", s.scalar("SELECT score FROM people WHERE name = 'Baru'").toString())
        val returned = s.table("UPDATE people SET city = 'Bogor' WHERE name = 'Baru' RETURNING id, city")
        assertEquals("Bogor", returned.value(0, "city"))
        val deleted = s.table("DELETE FROM people WHERE name = 'Baru' RETURNING name")
        assertEquals("Baru", deleted.rows[0][0])
        s.ok("DROP VIEW cities; DROP TRIGGER people_ai; DROP INDEX people_name")
        assertTrue(s.definition(DbObject("people", ObjectKind.TABLE)).orEmpty().startsWith("CREATE TABLE people"))
    }

    @Test
    fun transactionsCommentsAndQuoting() {
        s.ok("BEGIN; INSERT INTO notes VALUES ('kept?'); ROLLBACK")
        assertEquals("0", s.scalar("SELECT COUNT(*) FROM notes").toString())
        s.ok("BEGIN TRANSACTION; INSERT INTO notes VALUES ('yes'); SAVEPOINT a; INSERT INTO notes VALUES ('no'); ROLLBACK TO a; COMMIT")
        assertEquals("1", s.scalar("SELECT COUNT(*) FROM notes").toString())
        // BEGIN and COMMIT as separate runs, as in the editor (on the session's one thread)
        s.ok("BEGIN")
        s.ok("INSERT INTO notes VALUES ('across runs')")
        assertEquals("2", s.scalar("SELECT COUNT(*) FROM notes").toString())
        s.ok("COMMIT")
        s.ok("DELETE FROM notes WHERE body = 'across runs'")
        val results = s.ok(
            """
            -- comment; with semicolon
            /* block; comment */
            INSERT INTO notes VALUES ('it''s; -- not a comment'), ('second; one');
            SELECT body FROM notes WHERE body LIKE '%;%' ORDER BY rowid
            """.trimIndent(),
        )
        assertEquals(2L, results[0].affected)
        assertEquals(listOf("it's; -- not a comment", "second; one"), results[1].table!!.rows.map { it[0] })
        // ATTACH, VACUUM and ANALYZE run as statements of their own
        s.ok("ATTACH DATABASE ':memory:' AS mem; CREATE TABLE mem.t (x); INSERT INTO mem.t VALUES (1); SELECT * FROM mem.t; DETACH DATABASE mem")
        s.ok("VACUUM; ANALYZE")
    }

    @Test
    fun gridEditsWithRowid() {
        val ref = TableRef(null, null, "notes")
        s.ok("INSERT INTO notes VALUES ('a'), ('b')")
        val page = s.browse(ref, BrowseRequest())
        assertEquals(listOf(SqliteSession.ROWID), page.keyColumns)
        s.updateCell(ref, mapOf(SqliteSession.ROWID to page.table.rows[1][0]), "body", CellInput.Text("b2"))
        s.insertRow(ref, mapOf("body" to CellInput.Text("c")))
        s.deleteRows(ref, listOf(mapOf(SqliteSession.ROWID to page.table.rows[0][0])))
        assertEquals(listOf("b2", "c"), s.table("SELECT body FROM notes ORDER BY rowid").rows.map { it[0] })
    }

    @Test
    fun errorsAndPaging() {
        s.fails("SELEC 1", "syntax error")
        s.fails("SELECT * FROM nope", "no such table")
        s.fails("INSERT INTO people (id, name) VALUES (1, 'dup')", "UNIQUE constraint failed")
        assertEquals("1", s.scalar("SELECT 1").toString())
        val stmt = pageableSelect("SELECT * FROM people ORDER BY id", SqlDialect.SQLITE)!!
        assertEquals(101, s.table(pagedSql(stmt, 0, 100)).rows.size)
        assertEquals(50, s.table(pagedSql(stmt, 2, 100)).rows.size)
        assertEquals(null, pageableSelect("PRAGMA table_info(people)", SqlDialect.SQLITE))
    }

    @Test
    fun readOnlyFile() {
        s.close()
        openSession(profile(readOnly = true), env).use { ro ->
            assertEquals("250", ro.scalar("SELECT COUNT(*) FROM people").toString())
            ro.fails("DELETE FROM people WHERE id = 1", "read-only")
            ro.fails("PRAGMA user_version = 3", "read-only")
        }
        s = openSession(profile(), env)
    }
}
