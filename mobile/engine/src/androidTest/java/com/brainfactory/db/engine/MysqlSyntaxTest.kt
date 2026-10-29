package com.brainfactory.db.engine

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.math.BigDecimal
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** MySQL 8 syntax through Brain DB's MySQL session (MariaDB Connector/J 3 on Android), as the query editor runs it. */
@RunWith(AndroidJUnit4::class)
class MysqlSyntaxTest : SyntaxSuite() {
    private val port = args.getString("mysqlPort", "23306").toInt()
    private lateinit var s: DbSession

    private fun profile(readOnly: Boolean = false, database: String = "shop") = ConnectionProfile(
        name = "syntax", driver = Driver.MYSQL, host = host, port = port, user = "root", password = "brainroot",
        database = database, sslMode = SslMode.PREFERRED, readOnly = readOnly,
    )

    @Before
    fun open() {
        requireServer(port)
        s = openSession(profile(), env)
        s.ok("DROP DATABASE IF EXISTS syntax_test; CREATE DATABASE syntax_test; USE shop")
    }

    @After
    fun close() {
        if (::s.isInitialized) {
            runCatching { s.execute("DROP DATABASE IF EXISTS syntax_test") }
            s.close()
        }
        log("MySQL: $statements statements so far")
    }

    @Test
    fun showStatements() {
        val vars = s.table("SHOW VARIABLES")
        assertTrue("SHOW VARIABLES gives hundreds of rows", vars.rows.size > 300)
        assertEquals(listOf("Variable_name", "Value"), vars.columns.map { it.name })
        assertEquals("151", s.table("SHOW VARIABLES LIKE 'max_connections'").value(0, "Value"))
        assertEquals(1, s.table("SHOW GLOBAL VARIABLES WHERE Variable_name = 'version'").rows.size)
        assertTrue(s.table("SHOW SESSION STATUS LIKE 'Threads%'").rows.isNotEmpty())
        assertTrue(s.table("SHOW GLOBAL STATUS").rows.size > 300)
        val statements = listOf(
            "SHOW PROCESSLIST", "SHOW FULL PROCESSLIST", "SHOW DATABASES", "SHOW SCHEMAS", "SHOW TABLES", "SHOW FULL TABLES",
            "SHOW TABLES FROM shop LIKE 'c%'", "SHOW TABLE STATUS", "SHOW TABLE STATUS LIKE 'orders'", "SHOW COLUMNS FROM customers",
            "SHOW FULL COLUMNS FROM customers", "SHOW FIELDS FROM orders", "SHOW INDEX FROM customers", "SHOW KEYS FROM orders",
            "SHOW CREATE TABLE customers", "SHOW CREATE VIEW order_summary", "SHOW CREATE PROCEDURE seed_customers",
            "SHOW CREATE FUNCTION order_total", "SHOW CREATE TRIGGER trg_orders_audit", "SHOW CREATE DATABASE shop",
            "SHOW TRIGGERS", "SHOW TRIGGERS FROM shop LIKE 'orders'", "SHOW PROCEDURE STATUS WHERE Db = 'shop'",
            "SHOW FUNCTION STATUS WHERE Db = 'shop'", "SHOW EVENTS", "SHOW GRANTS", "SHOW GRANTS FOR CURRENT_USER",
            "SHOW PRIVILEGES", "SHOW ENGINES", "SHOW STORAGE ENGINES", "SHOW ENGINE INNODB STATUS", "SHOW CHARACTER SET",
            "SHOW CHARSET LIKE 'utf8%'", "SHOW COLLATION LIKE 'utf8mb4_0900%'", "SHOW PLUGINS", "SHOW OPEN TABLES",
            "SHOW OPEN TABLES FROM shop", "SHOW BINARY LOGS", "SHOW BINARY LOG STATUS", "SHOW REPLICAS", "SHOW STATUS",
            "SHOW PROFILES", "SHOW CREATE USER CURRENT_USER", "SHOW WARNINGS", "SHOW ERRORS", "SHOW COUNT(*) WARNINGS",
        )
        statements.forEach { sql ->
            classify(sql, SqlDialect.MYSQL, reading = true, pageable = false)
            s.ok(sql)
        }
        // SHOW ENGINE INNODB STATUS is one long text cell
        val innodb = s.table("SHOW ENGINE INNODB STATUS")
        assertTrue((innodb.value(0, "Status") as String).length > 1000)
        // Warnings from the statement before are shown by SHOW WARNINGS in the same run (same connection)
        val warn = s.ok("SELECT CAST('12abc' AS SIGNED) AS n; SHOW WARNINGS")
        assertEquals(12L, warn[0].table!!.rows[0][0].toString().toLong())
        assertTrue(warn[1].table!!.rows.isNotEmpty())
    }

    @Test
    fun describeAndExplain() {
        listOf(
            "DESCRIBE customers", "DESC orders", "DESCRIBE customers email", "EXPLAIN SELECT * FROM customers WHERE id = 1",
            "EXPLAIN FORMAT=JSON SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id",
            "EXPLAIN FORMAT=TREE SELECT * FROM customers WHERE city = 'Bandung'", "EXPLAIN ANALYZE SELECT COUNT(*) FROM orders",
            "EXPLAIN customers",
        ).forEach { sql ->
            classify(sql, SqlDialect.MYSQL, reading = true, pageable = false)
            assertTrue(sql, s.table(sql).rows.isNotEmpty())
        }
        classify("EXPLAIN ANALYZE DELETE FROM orders WHERE id = 1", SqlDialect.MYSQL, reading = false)
    }

    @Test
    fun variablesAndSession() {
        assertEquals("42", s.ok("SET @x = 41; SELECT @x + 1 AS y").last().table!!.rows[0][0].toString())
        val info = s.table("SELECT @@version AS v, @@sql_mode AS m, @@session.time_zone AS tz, DATABASE() AS db, CURRENT_USER() AS u")
        assertTrue((info.value(0, "v") as String).startsWith("8."))
        assertEquals("shop", info.value(0, "db"))
        s.ok("SET SESSION sql_mode = 'TRADITIONAL'; SET NAMES utf8mb4; SET @json = '{\"a\": [1, 2, 3]}'")
        assertEquals("2", s.scalar("SELECT JSON_EXTRACT(@json, '$.a[1]')").toString())
        assertEquals("STRICT_TRANS_TABLES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,TRADITIONAL,NO_ENGINE_SUBSTITUTION", s.scalar("SELECT @@sql_mode"))
        listOf("SET @a = 1", "SET NAMES utf8mb4", "SET SESSION sql_mode = ''").forEach { classify(it, SqlDialect.MYSQL, reading = true) }
        listOf("SET GLOBAL max_connections = 200", "SET PERSIST max_connections = 200", "SET @@GLOBAL.max_connections = 200").forEach {
            classify(it, SqlDialect.MYSQL, reading = false)
        }
    }

    @Test
    fun queries() {
        val queries = mapOf(
            "SELECT c.city, COUNT(*) AS n, AVG(o.qty) AS avg_qty FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.city HAVING n > 10 ORDER BY n DESC" to 5,
            "SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE qty >= 4) AND city IS NOT NULL LIMIT 5" to 5,
            "WITH big AS (SELECT customer_id, SUM(qty) AS q FROM orders GROUP BY customer_id) SELECT * FROM big WHERE q > 4 ORDER BY q DESC LIMIT 3" to 3,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT SUM(i) AS total FROM n" to 1,
            "SELECT id, city, ROW_NUMBER() OVER (PARTITION BY city ORDER BY id) AS rn, LAG(id) OVER w AS prev FROM customers WINDOW w AS (ORDER BY id) LIMIT 7" to 7,
            "SELECT 'a' AS x UNION ALL SELECT 'b' UNION SELECT 'a'" to 2,
            "SELECT profile->>'$.tier' AS tier, JSON_LENGTH(profile->'$.tags') AS tags FROM customers WHERE profile IS NOT NULL LIMIT 4" to 4,
            "SELECT first_name REGEXP '^A' AS a, CASE WHEN active THEN 'yes' ELSE 'no' END AS act, IF(city IS NULL, '-', city) AS c, COALESCE(birth_date, '1900-01-01') AS b FROM customers LIMIT 2" to 2,
            "SELECT DATE_FORMAT(NOW(), '%Y') AS y, DATE_ADD('2026-01-31', INTERVAL 1 MONTH) AS d, TIMESTAMPDIFF(DAY, '2026-01-01', '2026-10-22') AS days" to 1,
            "SELECT 1 + 1 AS two FROM DUAL" to 1,
            "TABLE products" to 4,
            "VALUES ROW(1, 'one'), ROW(2, 'two')" to 2,
            "SELECT * FROM customers ORDER BY id DESC LIMIT 2 OFFSET 5" to 2,
            "SELECT SQL_CALC_FOUND_ROWS id FROM customers LIMIT 1" to 1,
            "SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) FROM customers" to 1,
            "SELECT GROUP_CONCAT(sku ORDER BY sku SEPARATOR '|') AS skus FROM products" to 1,
        )
        queries.forEach { (sql, rows) ->
            classify(sql, SqlDialect.MYSQL, reading = true)
            assertEquals(sql, rows, s.table(sql).rows.size)
        }
        assertEquals("BK-001|BK-002|BK-003|BK-004", s.scalar("SELECT GROUP_CONCAT(sku ORDER BY sku SEPARATOR '|') FROM products"))
        assertEquals(BigDecimal("55"), BigDecimal(s.scalar("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT SUM(i) FROM n").toString()))
    }

    @Test
    fun typesComeBackReadable() {
        s.ok(
            """
            CREATE TABLE syntax_test.types (
              id INT AUTO_INCREMENT PRIMARY KEY, big BIGINT, amount DECIMAL(10,2), dbl DOUBLE, flt FLOAT, bits BIT(3), flag TINYINT(1),
              b BOOL, d DATE, dt DATETIME(3), ts TIMESTAMP NULL, t TIME, y YEAR, c CHAR(3), v VARCHAR(40), tx TEXT, bl BLOB,
              vb VARBINARY(8), e ENUM('a','b'), st SET('x','y'), j JSON, g POINT NULL, u VARCHAR(20)
            ) DEFAULT CHARSET = utf8mb4;
            INSERT INTO syntax_test.types (big, amount, dbl, flt, bits, flag, b, d, dt, ts, t, y, c, v, tx, bl, vb, e, st, j, g, u)
            VALUES (9007199254740993, 1234.50, 1.5, 2.25, b'101', 1, TRUE, '2026-10-22', '2026-10-22 01:02:03.456', '2026-10-22 01:02:03',
                    '23:59:58', 2026, 'abc', 'Halo 👋 dunia', REPEAT('x', 5000), X'00FF10', X'CAFE', 'b', 'x,y', '{"k": [1, {"n": null}]}',
                    ST_GeomFromText('POINT(1 2)'), NULL)
            """.trimIndent(),
        )
        val row = s.table("SELECT * FROM syntax_test.types")
        val r = { c: String -> row.value(0, c) }
        assertEquals(9007199254740993L, (r("big") as Number).toLong())
        assertEquals(BigDecimal("1234.50"), r("amount"))
        assertEquals(1.5, (r("dbl") as Number).toDouble(), 0.0)
        assertEquals(1, (r("flag") as Number).toInt())
        assertEquals("2026-10-22", r("d"))
        assertTrue(r("dt").toString().startsWith("2026-10-22 01:02:03.456"))
        assertEquals("23:59:58", r("t"))
        assertEquals("Halo 👋 dunia", r("v"))
        assertEquals(5000, (r("tx") as String).length)
        assertArrayEquals(byteArrayOf(0, -1, 16), r("bl") as ByteArray)
        assertEquals("b", r("e"))
        assertEquals("x,y", r("st"))
        assertEquals(JsonText("{\"k\": [1, {\"n\": null}]}"), r("j"))
        assertEquals("POINT(1 2)", r("g"))
        assertEquals(null, r("u"))
        // The grid's own reads and edits on the same table
        val ref = TableRef("syntax_test", null, "types")
        val page = s.browse(ref, BrowseRequest(limit = 10))
        assertEquals(listOf("id"), page.keyColumns)
        s.updateCell(ref, mapOf("id" to page.table.rows[0][0]), "v", CellInput.Text("diubah ✓"))
        s.updateCell(ref, mapOf("id" to page.table.rows[0][0]), "u", CellInput.Text("x"))
        s.updateCell(ref, mapOf("id" to page.table.rows[0][0]), "u", CellInput.Null)
        assertEquals("diubah ✓", s.scalar("SELECT v FROM syntax_test.types"))
        assertEquals(null, s.scalar("SELECT u FROM syntax_test.types"))
    }

    @Test
    fun dataChanges() {
        s.ok("CREATE TABLE syntax_test.t (id INT PRIMARY KEY, name VARCHAR(20), qty INT DEFAULT 0, UNIQUE KEY (name))")
        assertEquals(3L, s.ok("INSERT INTO syntax_test.t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')").single().affected)
        assertEquals(2L, s.ok("INSERT INTO syntax_test.t (id, name, qty) SELECT id + 10, CONCAT(name, '2'), 5 FROM syntax_test.t WHERE id < 3").single().affected)
        assertEquals(0L, s.ok("INSERT IGNORE INTO syntax_test.t (id, name) VALUES (1, 'dup')").single().affected)
        s.ok("REPLACE INTO syntax_test.t (id, name) VALUES (3, 'c3')")
        s.ok("INSERT INTO syntax_test.t (id, name) VALUES (1, 'a') ON DUPLICATE KEY UPDATE qty = qty + 7")
        assertEquals("7", s.scalar("SELECT qty FROM syntax_test.t WHERE id = 1").toString())
        assertEquals(2L, s.ok("UPDATE syntax_test.t SET qty = qty + 1 WHERE id > 10").single().affected)
        s.ok("UPDATE syntax_test.t a JOIN syntax_test.t b ON b.id = a.id + 10 SET a.qty = b.qty WHERE a.id < 3")
        assertEquals(1L, s.ok("DELETE FROM syntax_test.t WHERE id > 10 ORDER BY id LIMIT 1").single().affected)
        classify("DELETE FROM syntax_test.t", SqlDialect.MYSQL, reading = false, destructive = true)
        classify("UPDATE syntax_test.t SET name = 'where'", SqlDialect.MYSQL, reading = false, destructive = true)
        assertEquals(4L, s.ok("DELETE FROM syntax_test.t").single().affected)
        s.fails("INSERT INTO syntax_test.t (id, name) VALUES (1, 'x'), (2, 'x')", "Duplicate entry")
    }

    @Test
    fun schemaChanges() {
        s.ok(
            """
            CREATE TABLE IF NOT EXISTS syntax_test.ddl (id INT PRIMARY KEY);
            ALTER TABLE syntax_test.ddl ADD COLUMN note VARCHAR(10) NULL AFTER id, ADD INDEX idx_note (note);
            ALTER TABLE syntax_test.ddl MODIFY note VARCHAR(50) NOT NULL DEFAULT '';
            ALTER TABLE syntax_test.ddl RENAME COLUMN note TO memo;
            CREATE INDEX idx_memo2 ON syntax_test.ddl (memo(5));
            RENAME TABLE syntax_test.ddl TO syntax_test.ddl2;
            CREATE VIEW syntax_test.v AS SELECT id, memo FROM syntax_test.ddl2;
            TRUNCATE TABLE syntax_test.ddl2;
            DROP VIEW syntax_test.v;
            DROP TABLE IF EXISTS syntax_test.ddl2;
            """.trimIndent(),
        )
        classify("DROP TABLE x", SqlDialect.MYSQL, reading = false, destructive = true)
        classify("TRUNCATE TABLE x", SqlDialect.MYSQL, reading = false, destructive = true)
        classify("ALTER TABLE x DROP COLUMN y", SqlDialect.MYSQL, reading = false, destructive = true)
        classify("ALTER TABLE x ADD COLUMN y INT", SqlDialect.MYSQL, reading = false)
    }

    @Test
    fun routinesWithAndWithoutDelimiter() {
        val withDelimiter = """
            USE syntax_test;
            DELIMITER //
            CREATE PROCEDURE fill(IN n INT)
            BEGIN
              DECLARE i INT DEFAULT 0;
              CREATE TABLE IF NOT EXISTS nums (v INT);
              WHILE i < n DO
                INSERT INTO nums VALUES (i);
                SET i = i + 1;
              END WHILE;
              SELECT COUNT(*) AS filled FROM nums;
            END //
            DELIMITER ;
            CALL fill(5);
        """.trimIndent()
        val results = s.ok(withDelimiter)
        assertEquals(3, results.size)
        assertEquals("5", results.last().table!!.rows[0][0].toString())
        // No DELIMITER: the BEGIN … END body (with IF, CASE, LOOP) stays one statement
        s.ok(
            """
            CREATE FUNCTION grade(score INT) RETURNS VARCHAR(10) DETERMINISTIC
            BEGIN
              DECLARE g VARCHAR(10);
              IF score >= 90 THEN SET g = 'A';
              ELSEIF score >= 70 THEN SET g = 'B';
              ELSE SET g = 'C';
              END IF;
              RETURN CASE WHEN g = 'A' THEN CONCAT(g, '+') ELSE g END;
            END;
            CREATE TRIGGER nums_bi BEFORE INSERT ON nums FOR EACH ROW
            BEGIN
              IF NEW.v < 0 THEN SET NEW.v = 0; END IF;
            END;
            INSERT INTO nums VALUES (-5);
            """.trimIndent(),
        )
        assertEquals("A+", s.scalar("SELECT grade(95)"))
        assertEquals("B", s.scalar("SELECT grade(75)"))
        assertEquals("0", s.scalar("SELECT MIN(v) FROM nums").toString())
        assertTrue(s.ok("SHOW CREATE FUNCTION grade").single().table!!.rows.isNotEmpty())
        // A procedure returning two result sets: the first is shown
        s.ok("CREATE PROCEDURE two() BEGIN SELECT 1 AS a; SELECT 2 AS b; END")
        assertEquals("a", s.ok("CALL two()").single().table!!.columns[0].name)
        s.ok("DROP TRIGGER nums_bi; DROP FUNCTION grade; DROP PROCEDURE fill; DROP PROCEDURE two; USE shop")
        assertEquals("shop", s.currentDatabase)
    }

    @Test
    fun transactionsAndPreparedStatements() {
        s.ok("CREATE TABLE syntax_test.tx (id INT PRIMARY KEY) ENGINE = InnoDB")
        s.ok("START TRANSACTION; INSERT INTO syntax_test.tx VALUES (1); ROLLBACK")
        assertEquals("0", s.scalar("SELECT COUNT(*) FROM syntax_test.tx").toString())
        s.ok("BEGIN; INSERT INTO syntax_test.tx VALUES (2); SAVEPOINT sp; INSERT INTO syntax_test.tx VALUES (3); ROLLBACK TO SAVEPOINT sp; COMMIT")
        assertEquals("2", s.scalar("SELECT GROUP_CONCAT(id) FROM syntax_test.tx").toString())
        val prepared = s.ok("PREPARE q FROM 'SELECT ? * 2 AS doubled'; SET @n = 21; EXECUTE q USING @n; DEALLOCATE PREPARE q")
        assertEquals("42", prepared[2].table!!.rows[0][0].toString())
    }

    @Test
    fun commentsAndQuoting() {
        val sql = """
            -- a line comment; with a semicolon
            # a hash comment; too
            /* a block
               comment; */
            SELECT 'it''s; -- not a comment' AS a, "double; quoted" AS b, `customers`.`first_name` AS `the name; really`
            FROM customers /* inline; */ WHERE id = 2; # trailing
            SELECT 'back\\slash and \'quote\'' AS c;
            /*!40101 SELECT 'executable comment' AS d */;
        """.trimIndent()
        val results = s.ok(sql)
        assertEquals(3, results.size)
        val first = results[0].table!!
        assertEquals("it's; -- not a comment", first.value(0, "a"))
        assertEquals("double; quoted", first.value(0, "b"))
        assertEquals("Budi", first.value(0, "the name; really"))
        assertEquals("back\\slash and 'quote'", results[1].table!!.rows[0][0])
        assertEquals("executable comment", results[2].table!!.rows[0][0])
        assertEquals(1, s.table("SELECT * FROM `shop`.`customers` WHERE `id` = 1").rows.size)
    }

    @Test
    fun errorsLeaveTheSessionUsable() {
        s.fails("SELEC 1", "error in your SQL syntax")
        s.fails("SELECT * FROM no_such_table", "doesn't exist")
        s.fails("SELECT no_such_column FROM customers", "Unknown column")
        s.fails("SELECT 1; SELECT * FROM nope; SELECT 3", "doesn't exist")
        s.fails("LOAD DATA LOCAL INFILE '/etc/hosts' INTO TABLE syntax_test.x", "")
        s.fails("DELIMITER", "")
        assertEquals("1", s.scalar("SELECT 1").toString())
        // A run stops at the first error: the statement after it doesn't run
        assertEquals(2, s.execute("SELECT 1; SELECT * FROM nope; SELECT 3").size)
    }

    @Test
    fun useSwitchesTheDatabase() {
        s.ok("USE inventory")
        assertEquals("inventory", s.currentDatabase)
        assertEquals("inventory", s.scalar("SELECT DATABASE()"))
        assertTrue(s.objects().any { it.name == "warehouses" })
        s.ok("USE shop")
        assertEquals("shop", s.currentDatabase)
    }

    @Test
    fun autoPaging() {
        val total = s.scalar("SELECT COUNT(*) FROM customers").toString().toInt()
        val stmt = pageableSelect("SELECT * FROM customers ORDER BY id;", SqlDialect.MYSQL)!!
        val first = s.table(pagedSql(stmt, 0, 100))
        assertEquals("page 1 brings the extra row that tells there's more", 101, first.rows.size)
        val lastPage = (total - 1) / 100
        val last = s.table(pagedSql(stmt, lastPage, 100))
        assertEquals(total - lastPage * 100, last.rows.size)
        assertEquals("row numbers follow on", (lastPage * 100 + 1).toString(), last.rows[0][0].toString())
        listOf("SELECT * FROM customers LIMIT 10", "SHOW VARIABLES", "SELECT * FROM customers FOR UPDATE", "SELECT id INTO @x FROM customers LIMIT 1").forEach {
            assertEquals(it, null, pageableSelect(it, SqlDialect.MYSQL))
        }
        // Without paging a big result is cut at the editor's row cap, and says so
        val capped = s.ok("SELECT * FROM customers", maxRows = 1000).single().table!!
        assertEquals(1000, capped.rows.size)
        assertTrue(capped.truncated)
        assertFalse(s.ok("SELECT * FROM customers", maxRows = 5000).single().table!!.truncated)
    }

    @Test
    fun readOnlyConnectionsRefuseWritesTwice() {
        // A function that writes, which a SELECT can call: only the server can see that it writes.
        s.ok(
            "CREATE TABLE syntax_test.written (v INT); " +
                "CREATE FUNCTION syntax_test.writer() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO syntax_test.written VALUES (1); RETURN 1; END",
        )
        openSession(profile(readOnly = true), env).use { ro ->
            assertTrue(ro.table("SHOW VARIABLES").rows.size > 300)
            assertTrue(ro.table("SELECT COUNT(*) FROM customers").rows.isNotEmpty())
            ro.fails("SELECT syntax_test.writer()", "READ ONLY")
            ro.fails("INSERT INTO products (sku, name, price) VALUES ('X', 'x', 1)", "read-only")
            ro.fails("SET GLOBAL max_connections = 100", "read-only")
            // The server refuses writes too, in case a check misses one
            assertEquals("1", ro.scalar("SELECT @@session.transaction_read_only").toString())
            ro.fails("SET SESSION TRANSACTION READ WRITE", "read-only")
            ro.fails("PREPARE w FROM 'DELETE FROM products'", "read-only")
        }
        assertEquals("nothing was written", "0", s.scalar("SELECT COUNT(*) FROM syntax_test.written").toString())
    }

    @Test
    fun aLongQueryCanBeStopped() {
        var results: List<StatementResult>? = null
        val runner = thread { results = s.execute("SELECT SLEEP(20)") }
        Thread.sleep(1500)
        val start = System.currentTimeMillis()
        s.cancel()
        runner.join(10_000)
        assertFalse("SELECT SLEEP(20) should stop when cancelled", runner.isAlive)
        assertTrue("stopped in seconds", System.currentTimeMillis() - start < 8000)
        // MySQL answers a killed SLEEP with 1 (interrupted) or an error; either way the session goes on
        assertTrue(results!!.isNotEmpty())
        assertEquals("1", s.scalar("SELECT 1").toString())
    }
}
