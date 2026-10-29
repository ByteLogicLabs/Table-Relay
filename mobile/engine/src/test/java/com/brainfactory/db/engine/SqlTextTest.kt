package com.brainfactory.db.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SqlTextTest {

    @Test
    fun splitsOnSemicolonsOutsideQuotesAndComments() {
        val sql = """
            SELECT 'a;b' AS x; -- a comment; with a semicolon
            SELECT "c;d" FROM t /* block; comment */;
            SELECT `e;f` FROM u
        """.trimIndent()
        val parts = splitSql(sql, SqlDialect.MYSQL)
        assertEquals(3, parts.size)
        assertEquals("SELECT 'a;b' AS x", parts[0])
        assertTrue(parts[1].startsWith("-- a comment"))
        assertTrue(parts[1].endsWith("/* block; comment */"))
        assertEquals("SELECT `e;f` FROM u", parts[2])
    }

    @Test
    fun keepsPostgresDollarQuotedBodiesWhole() {
        val sql = "CREATE FUNCTION f() RETURNS int AS \$\$ BEGIN RETURN 1; END; \$\$ LANGUAGE plpgsql; SELECT f();"
        val parts = splitSql(sql, SqlDialect.POSTGRES)
        assertEquals(2, parts.size)
        assertTrue(parts[0].contains("RETURN 1; END;"))
        assertEquals("SELECT f()", parts[1])
        val tagged = splitSql("DO \$body\$ BEGIN PERFORM 1; END \$body\$; SELECT 2", SqlDialect.POSTGRES)
        assertEquals(2, tagged.size)
    }

    @Test
    fun mysqlHashCommentsAndBackslashEscapes() {
        val parts = splitSql("SELECT 'it\\'s; fine'; # trailing; comment\nSELECT 2", SqlDialect.MYSQL)
        assertEquals(listOf("SELECT 'it\\'s; fine'", "# trailing; comment\nSELECT 2"), parts)
    }

    @Test
    fun dropsStatementsThatAreOnlyComments() {
        // The semicolon inside the -- comment doesn't end a statement; the comment-only one at the end is dropped.
        assertEquals(listOf("-- nothing here;\nSELECT 1"), splitSql("-- nothing here;\nSELECT 1; /* also nothing */;", SqlDialect.SQLITE))
    }

    @Test
    fun findsTheStatementUnderTheCursor() {
        val sql = "SELECT 1;\nSELECT 2;\nSELECT 3"
        assertEquals("SELECT 1", statementAt(sql, 3, SqlDialect.MYSQL)?.text)
        assertEquals("SELECT 2", statementAt(sql, sql.indexOf("2"), SqlDialect.MYSQL)?.text)
        assertEquals("SELECT 3", statementAt(sql, sql.length, SqlDialect.MYSQL)?.text)
    }

    @Test
    fun flagsDestructiveStatementsLikeTableRelay() {
        val found = analyzeDestructive(
            "DELETE FROM a; DELETE FROM a WHERE id = 1; UPDATE b SET x = 1; UPDATE b SET x = 1 WHERE y = 2; " +
                "TRUNCATE c; DROP TABLE d; ALTER TABLE e DROP COLUMN f; SELECT 1",
            SqlDialect.MYSQL,
        )
        assertEquals(listOf("DELETE", "UPDATE", "TRUNCATE", "DROP", "ALTER_DROP"), found.map { it.kind })
        assertEquals("DROP TABLE is irreversible", found[3].detail)
        // A WHERE in a comment doesn't make it safe
        assertEquals(1, analyzeDestructive("DELETE FROM a -- WHERE id = 1", SqlDialect.MYSQL).size)
        // A column named "somewhere" isn't a WHERE
        assertEquals(1, analyzeDestructive("UPDATE a SET somewhere = 1", SqlDialect.POSTGRES).size)
    }

    @Test
    fun readOnlyStatements() {
        assertTrue(isReadOnlyStatement("SELECT * FROM t", SqlDialect.MYSQL))
        assertTrue(isReadOnlyStatement("  -- why\n show tables", SqlDialect.MYSQL))
        assertTrue(isReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x", SqlDialect.POSTGRES))
        assertTrue(isReadOnlyStatement("PRAGMA table_info(t)", SqlDialect.SQLITE))
        assertFalse(isReadOnlyStatement("PRAGMA foreign_keys = ON", SqlDialect.SQLITE))
        assertFalse(isReadOnlyStatement("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", SqlDialect.POSTGRES))
        assertFalse(isReadOnlyStatement("INSERT INTO t VALUES (1)", SqlDialect.MYSQL))
        assertFalse(isReadOnlyStatement("DROP TABLE t", SqlDialect.MYSQL))
    }

    @Test
    fun quotesAndLiteralsPerDialect() {
        assertEquals("`a``b`", SqlDialect.MYSQL.quote("a`b"))
        assertEquals("\"a\"\"b\"", SqlDialect.POSTGRES.quote("a\"b"))
        assertEquals("'it''s \\\\'", SqlDialect.MYSQL.literal("it's \\"))
        assertEquals("'it''s \\'", SqlDialect.POSTGRES.literal("it's \\"))
        assertEquals("TRUE", SqlDialect.POSTGRES.literal(true))
        assertEquals("1", SqlDialect.SQLITE.literal(true))
        assertEquals("X'0aff'", SqlDialect.MYSQL.literal(byteArrayOf(10, -1)))
        assertEquals("'\\x0aff'", SqlDialect.POSTGRES.literal(byteArrayOf(10, -1)))
        assertEquals("NULL", SqlDialect.MYSQL.literal(null))
        assertEquals("`shop`.`users`", SqlDialect.MYSQL.qualified(TableRef("shop", null, "users")))
        assertEquals("\"sales\".\"invoices\"", SqlDialect.POSTGRES.qualified(TableRef("db", "sales", "invoices")))
    }
}
