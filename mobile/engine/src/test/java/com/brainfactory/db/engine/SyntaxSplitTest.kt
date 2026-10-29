package com.brainfactory.db.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The statement splitter on the syntax routines, triggers and dialect-specific strings bring. */
class SyntaxSplitTest {

    @Test
    fun mysqlDelimiterLines() {
        val sql = """
            DELIMITER //
            CREATE PROCEDURE p(IN n INT)
            BEGIN
              SELECT 1;
              SELECT n;
            END //
            DELIMITER ;
            CALL p(5);
            SELECT 'done';
        """.trimIndent()
        val parts = splitSql(sql, SqlDialect.MYSQL)
        assertEquals(3, parts.size)
        assertTrue(parts[0].startsWith("CREATE PROCEDURE p(IN n INT)"))
        assertTrue(parts[0].endsWith("END"))
        assertTrue(parts[0].contains("SELECT 1;\n  SELECT n;"))
        assertEquals("CALL p(5)", parts[1])
        assertEquals("SELECT 'done'", parts[2])
    }

    @Test
    fun mysqlDelimiterWithDollarsAndAComment() {
        val sql = "-- routines\nDELIMITER $$\nCREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END$$\nDELIMITER ;\nSELECT f();"
        assertEquals(listOf("CREATE FUNCTION f() RETURNS INT DETERMINISTIC BEGIN RETURN 1; END", "SELECT f()"), splitSql(sql, SqlDialect.MYSQL))
    }

    @Test
    fun routineBodiesStayWholeWithoutDelimiter() {
        val sql = """
            CREATE DEFINER=`root`@`%` PROCEDURE count_up(OUT total INT)
            BEGIN
              DECLARE i INT DEFAULT 0;
              lbl: LOOP
                SET i = i + 1;
                IF i >= 3 THEN LEAVE lbl; END IF;
              END LOOP lbl;
              WHILE i < 5 DO SET i = i + 1; END WHILE;
              REPEAT SET i = i + 1; UNTIL i > 6 END REPEAT;
              CASE i WHEN 7 THEN SET total = i; ELSE SET total = 0; END CASE;
              SELECT CASE WHEN i > 1 THEN 'many' ELSE 'few' END AS how;
              BEGIN
                SELECT 'nested';
              END;
            END;
            SELECT 'after';
        """.trimIndent()
        val parts = splitSql(sql, SqlDialect.MYSQL)
        assertEquals(2, parts.size)
        assertTrue(parts[0].trimEnd().endsWith("END"))
        assertEquals("SELECT 'after'", parts[1])
    }

    @Test
    fun triggersWithBlocks() {
        val sqlite = "CREATE TRIGGER t_ins AFTER INSERT ON a BEGIN INSERT INTO b VALUES (new.id); UPDATE c SET n = n + 1; END; SELECT 1;"
        assertEquals(2, splitSql(sqlite, SqlDialect.SQLITE).size)
        val mysql = "CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW BEGIN SET NEW.x = 1; SET NEW.y = 2; END; SELECT 2"
        assertEquals(2, splitSql(mysql, SqlDialect.MYSQL).size)
        val oneLine = "CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW INSERT INTO log VALUES (1); SELECT 3"
        assertEquals(2, splitSql(oneLine, SqlDialect.MYSQL).size)
        val event = "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM a WHERE x < NOW(); OPTIMIZE TABLE a; END; SELECT 4"
        assertEquals(2, splitSql(event, SqlDialect.MYSQL).size)
    }

    @Test
    fun postgresBeginAtomicAndDollarBodies() {
        val atomic = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT f();"
        assertEquals(listOf("CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END", "SELECT f()"), splitSql(atomic, SqlDialect.POSTGRES))
        val plpgsql = "CREATE OR REPLACE FUNCTION g() RETURNS trigger AS \$body\$ BEGIN IF x THEN RETURN NULL; END IF; RETURN NEW; END; \$body\$ LANGUAGE plpgsql; SELECT 1"
        assertEquals(2, splitSql(plpgsql, SqlDialect.POSTGRES).size)
        // $1 is a parameter, not a dollar quote
        assertEquals(2, splitSql("PREPARE q AS SELECT \$1 + 1; EXECUTE q(2)", SqlDialect.POSTGRES).size)
    }

    @Test
    fun postgresNestsBlockComments() {
        val sql = "/* outer /* inner; */ still; comment */ SELECT 1; SELECT 2"
        assertEquals(2, splitSql(sql, SqlDialect.POSTGRES).size)
        assertTrue(isReadOnlyStatement(splitSql(sql, SqlDialect.POSTGRES)[0], SqlDialect.POSTGRES))
        // MySQL doesn't nest: the comment ends at the first */
        assertEquals(3, splitSql("/* a /* b */ SELECT 1; */ SELECT 2; SELECT 3", SqlDialect.MYSQL).size)
    }

    @Test
    fun transactionsAreNotBlocks() {
        assertEquals(3, splitSql("BEGIN; INSERT INTO t VALUES (1); COMMIT;", SqlDialect.SQLITE).size)
        assertEquals(4, splitSql("START TRANSACTION; UPDATE t SET a = 1 WHERE id = 2; SAVEPOINT s; ROLLBACK;", SqlDialect.MYSQL).size)
        assertEquals(3, splitSql("BEGIN; SELECT 1; END;", SqlDialect.POSTGRES).size)
    }

    @Test
    fun columnsNamedLikeKeywordsDontOpenBlocks() {
        val sql = "CREATE TABLE schedule (event VARCHAR(10), begin DATETIME, `end` DATETIME, `case` INT); SELECT 1; SELECT 2"
        assertEquals(3, splitSql(sql, SqlDialect.MYSQL).size)
        assertEquals(2, splitSql("SELECT begin FROM schedule; SELECT CASE WHEN 1 THEN 2 END", SqlDialect.MYSQL).size)
    }

    @Test
    fun dialectStrings() {
        // PostgreSQL: a backslash is plain text in '…' but escapes in E'…'
        assertEquals(2, splitSql("SELECT 'C:\\'; SELECT 2", SqlDialect.POSTGRES).size)
        assertEquals(2, splitSql("SELECT E'it\\'s; fine'; SELECT 2", SqlDialect.POSTGRES).size)
        // MySQL: backslash escapes, and "double quotes" are strings
        assertEquals(2, splitSql("SELECT \"a\\\"; b\"; SELECT 2", SqlDialect.MYSQL).size)
        // SQLite: [bracket] and `backtick` identifiers
        assertEquals(2, splitSql("SELECT [a;b], `c;d` FROM t; SELECT 2", SqlDialect.SQLITE).size)
    }

    @Test
    fun commentsAreStrippedButNotInsideStrings() {
        fun squeeze(s: String) = s.replace(Regex("\\s+"), " ").trim()
        assertEquals("SELECT '-- not a comment', 1 FROM t", squeeze(stripSqlComments("SELECT '-- not a comment', /* x */ 1 -- end\n FROM t", SqlDialect.MYSQL)))
        assertEquals("SELECT 1", squeeze(stripSqlComments("SELECT 1 # mysql comment", SqlDialect.MYSQL)))
        assertEquals("SELECT '#'", squeeze(stripSqlComments("SELECT '#' -- x", SqlDialect.POSTGRES)))
        // A comment between two words leaves them apart
        assertEquals("SELECT 1", squeeze(stripSqlComments("SELECT/**/1", SqlDialect.SQLITE)))
        // MySQL's executable comments and hints run, so they stay
        assertEquals("/*!40101 SET NAMES utf8mb4 */", stripSqlComments("/*!40101 SET NAMES utf8mb4 */", SqlDialect.MYSQL))
        assertEquals("SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1", stripSqlComments("SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1", SqlDialect.MYSQL))
        val masked = maskSqlLiterals("UPDATE t SET note = 'where?' -- WHERE", SqlDialect.MYSQL)
        assertEquals("UPDATE t SET note = ", masked.substring(0, 20))
        assertFalse(masked.contains("WHERE", ignoreCase = true))
    }

    @Test
    fun keywordsInStringsDontCount() {
        assertEquals(listOf("UPDATE"), analyzeDestructive("UPDATE t SET note = 'no where clause'", SqlDialect.MYSQL).map { it.kind })
        assertTrue(analyzeDestructive("DELETE FROM t WHERE note = 'all'", SqlDialect.MYSQL).isEmpty())
        assertTrue(analyzeDestructive("SELECT 'DROP TABLE x'", SqlDialect.POSTGRES).isEmpty())
    }

    @Test
    fun readOnlyChecks() {
        val reading = listOf(
            "SHOW VARIABLES", "SHOW VARIABLES LIKE 'max%'", "SHOW GLOBAL STATUS", "SHOW FULL PROCESSLIST", "SHOW CREATE TABLE t",
            "SHOW ENGINE INNODB STATUS", "DESCRIBE t", "DESC t", "EXPLAIN SELECT 1", "EXPLAIN ANALYZE SELECT * FROM t",
            "SET @x = 1", "SET NAMES utf8mb4", "SET SESSION sql_mode = ''", "USE shop", "SELECT a INTO @x FROM t",
            "SELECT 'DELETE FROM t'", "WITH x AS (SELECT 1) SELECT * FROM x", "TABLE t", "VALUES (1)", "PRAGMA table_info(t)",
            "HELP 'select'",
        )
        reading.forEach { assertTrue(it, isReadOnlyStatement(it, SqlDialect.MYSQL)) }
        val writing = listOf(
            "SET GLOBAL max_connections = 10", "SET PERSIST x = 1", "SET @@GLOBAL.x = 1", "SET SESSION TRANSACTION READ WRITE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", "SET transaction_read_only = 0", "SET ROLE admin",
            "EXPLAIN ANALYZE DELETE FROM t", "EXPLAIN ANALYZE UPDATE t SET a = 1", "SELECT * INTO t2 FROM t",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'", "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "PRAGMA journal_mode = WAL", "INSERT INTO t VALUES (1)", "CALL p()", "DO \$\$ BEGIN END \$\$", "BEGIN", "LOCK TABLES t READ",
        )
        writing.forEach { assertFalse(it, isReadOnlyStatement(it, SqlDialect.MYSQL)) }
    }

    @Test
    fun pageableSelects() {
        assertEquals("SELECT * FROM customers", pageableSelect("SELECT * FROM customers;", SqlDialect.MYSQL))
        assertEquals("SELECT * FROM t", pageableSelect("-- all of them\nSELECT * FROM t -- trailing\n", SqlDialect.MYSQL)?.trim())
        assertEquals("SELECT * FROM t WHERE a = 'limit 5'", pageableSelect("SELECT * FROM t WHERE a = 'limit 5'", SqlDialect.POSTGRES))
        assertEquals("WITH x AS (SELECT 1 AS a) SELECT * FROM x", pageableSelect("WITH x AS (SELECT 1 AS a) SELECT * FROM x", SqlDialect.POSTGRES))
        listOf(
            "SELECT * FROM t LIMIT 5", "SELECT * FROM t OFFSET 5", "SELECT * FROM t FETCH FIRST 5 ROWS ONLY", "SELECT * FROM t FOR UPDATE",
            "SELECT * FROM t LOCK IN SHARE MODE", "SELECT a INTO @x FROM t", "SELECT * FROM (SELECT * FROM t LIMIT 3) x",
            "SELECT 1; SELECT 2", "SHOW VARIABLES", "UPDATE t SET a = 1", "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "PRAGMA table_info(t)", "EXPLAIN SELECT * FROM t",
        ).forEach { assertNull(it, pageableSelect(it, SqlDialect.POSTGRES)) }
        assertEquals("SELECT * FROM t LIMIT 101 OFFSET 200", pagedSql("SELECT * FROM t", 2, 100))
    }

    @Test
    fun pageableFinds() {
        assertEquals("db.users.find({ age: { \$gt: 1 } }).sort({ age: -1 })", pageableFind("db.users.find({ age: { \$gt: 1 } }).sort({ age: -1 });"))
        assertEquals("db.users.find()", pageableFind("db.users.find()"))
        assertNull(pageableFind("db.users.find().limit(5)"))
        assertNull(pageableFind("db.users.find().skip(5)"))
        assertNull(pageableFind("db.users.find().count()"))
        assertNull(pageableFind("db.users.aggregate([])"))
        assertNull(pageableFind("db.a.find()\ndb.b.find()"))
        assertEquals("db.users.find().skip(50).limit(26)", pagedFind("db.users.find()", 2, 25))
    }
}
