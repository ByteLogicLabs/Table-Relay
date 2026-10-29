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

/** PostgreSQL 16 syntax through Brain DB's PostgreSQL session (pgjdbc 42.7 on Android), as the query editor runs it. */
@RunWith(AndroidJUnit4::class)
class PostgresSyntaxTest : SyntaxSuite() {
    private val port = args.getString("pgPort", "25432").toInt()
    private lateinit var s: DbSession

    private fun profile(readOnly: Boolean = false) = ConnectionProfile(
        name = "syntax", driver = Driver.POSTGRES, host = host, port = port, user = "brain", password = "brainpass",
        database = "shop", sslMode = SslMode.PREFERRED, readOnly = readOnly,
    )

    @Before
    fun open() {
        requireServer(port)
        s = openSession(profile(), env)
        s.ok("DROP SCHEMA IF EXISTS syntax_test CASCADE; CREATE SCHEMA syntax_test")
    }

    @After
    fun close() {
        if (::s.isInitialized) {
            runCatching { s.execute("DROP SCHEMA IF EXISTS syntax_test CASCADE") }
            s.close()
        }
        log("PostgreSQL: $statements statements so far")
    }

    @Test
    fun showAndSet() {
        val all = s.table("SHOW ALL")
        assertTrue("SHOW ALL lists hundreds of settings", all.rows.size > 300)
        assertEquals(listOf("name", "setting", "description"), all.columns.map { it.name })
        assertTrue((s.scalar("SHOW server_version") as String).startsWith("16"))
        listOf("SHOW search_path", "SHOW TimeZone", "SHOW transaction_isolation", "SHOW work_mem", "SHOW max_connections", "SHOW ALL").forEach {
            classify(it, SqlDialect.POSTGRES, reading = true, pageable = false)
            s.ok(it)
        }
        s.ok("SET search_path TO sales, public")
        assertEquals("sales, public", s.scalar("SHOW search_path"))
        assertEquals("400", s.scalar("SELECT COUNT(*) FROM invoices").toString())
        s.ok("RESET search_path; SET work_mem = '8MB'; SET TIME ZONE 'Asia/Jakarta'")
        assertEquals("8MB", s.scalar("SHOW work_mem"))
        assertEquals("Asia/Jakarta", s.scalar("SHOW TimeZone"))
        assertEquals("5s", s.ok("BEGIN; SET LOCAL statement_timeout = '5s'; SHOW statement_timeout; COMMIT")[2].table!!.rows[0][0])
        assertEquals("0", s.scalar("SHOW statement_timeout"))
        classify("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", SqlDialect.POSTGRES, reading = false)
        classify("SET ROLE postgres", SqlDialect.POSTGRES, reading = false)
    }

    @Test
    fun explain() {
        listOf(
            "EXPLAIN SELECT * FROM customers WHERE id = 1", "EXPLAIN ANALYZE SELECT COUNT(*) FROM customers",
            "EXPLAIN (FORMAT JSON, COSTS OFF) SELECT * FROM sales.invoices WHERE issued > now() - interval '30 days'",
            "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT city, count(*) FROM customers GROUP BY city",
        ).forEach { sql ->
            classify(sql, SqlDialect.POSTGRES, reading = true, pageable = false)
            assertTrue(sql, s.table(sql).rows.isNotEmpty())
        }
        classify("EXPLAIN ANALYZE DELETE FROM customers", SqlDialect.POSTGRES, reading = false)
    }

    @Test
    fun queries() {
        val queries = mapOf(
            "SELECT city, count(*) AS n, round(avg(balance), 2) AS avg_balance FROM customers GROUP BY city ORDER BY n DESC" to 4,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT sum(i) FROM n" to 1,
            "SELECT id, city, row_number() OVER (PARTITION BY city ORDER BY id) AS rn, sum(balance) OVER w FROM customers WINDOW w AS (ORDER BY id ROWS 2 PRECEDING) LIMIT 7" to 7,
            "SELECT c.id, i.amount FROM customers c CROSS JOIN LATERAL (SELECT amount FROM sales.invoices WHERE customer_id = c.id ORDER BY amount DESC LIMIT 1) i LIMIT 5" to 5,
            "SELECT DISTINCT ON (city) city, id FROM customers ORDER BY city, id" to 4,
            "SELECT count(*) FILTER (WHERE active) AS active, count(*) FILTER (WHERE NOT active) AS inactive FROM customers" to 1,
            "SELECT g, g * 2 AS double FROM generate_series(1, 25) g" to 25,
            "SELECT ARRAY[1, 2, 3] AS arr, unnest(ARRAY['a', 'b']) AS letter" to 2,
            "SELECT meta->>'score' AS score, meta @> '{\"vip\": true}' AS vip, jsonb_path_query_first(meta, '$.score') AS q FROM customers WHERE meta IS NOT NULL LIMIT 3" to 3,
            "SELECT name ~* '^customer 1' AS re, name ILIKE '%10%' AS il, email::text, id::bigint, '42'::int + 1 AS cast FROM customers LIMIT 2" to 2,
            "SELECT now() - interval '1 day' AS yesterday, date_trunc('month', now()) AS m, gen_random_uuid() AS u" to 1,
            "SELECT string_agg(city, ',' ORDER BY city) AS cities, array_agg(DISTINCT city) AS arr FROM customers" to 1,
            "VALUES (1, 'a'), (2, 'b'), (3, 'c')" to 3,
            "TABLE sales.invoices" to 400,
            "SELECT * FROM customers ORDER BY id OFFSET 10 FETCH FIRST 3 ROWS ONLY" to 3,
            "SELECT \"name\" AS \"Mixed Case; Name\" FROM \"customers\" WHERE \"id\" = 3" to 1,
        )
        queries.forEach { (sql, rows) ->
            classify(sql, SqlDialect.POSTGRES, reading = true)
            assertEquals(sql, rows, s.table(sql).rows.size)
        }
        assertEquals(BigDecimal("55"), BigDecimal(s.scalar("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT sum(i) FROM n").toString()))
        assertEquals("Customer 3", s.scalar("SELECT \"name\" AS \"Mixed Case; Name\" FROM \"customers\" WHERE \"id\" = 3"))
    }

    @Test
    fun typesComeBackReadable() {
        s.ok(
            """
            CREATE TYPE syntax_test.mood AS ENUM ('sad', 'ok', 'happy');
            CREATE TYPE syntax_test.pair AS (a int, b text);
            CREATE TABLE syntax_test.types (
              id serial PRIMARY KEY, sm smallint, i int, bi bigint, num numeric(12, 3), r real, d double precision, m money,
              b boolean, t text, vc varchar(20), ch char(3), bin bytea, dt date, tm time, tmz timetz, ts timestamp, tstz timestamptz,
              iv interval, u uuid, j json, jb jsonb, ia int[], ta text[], ip inet, cidr cidr, mac macaddr, pt point, bx box,
              tsv tsvector, x xml, mood syntax_test.mood, pr syntax_test.pair, rng int4range, nul text
            );
            INSERT INTO syntax_test.types (sm, i, bi, num, r, d, m, b, t, vc, ch, bin, dt, tm, tmz, ts, tstz, iv, u, j, jb, ia, ta, ip, cidr, mac, pt, bx, tsv, x, mood, pr, rng)
            VALUES (1, 2, 9007199254740993, 1234.567, 1.5, 2.25, 9.99, true, 'Halo 👋', 'v', 'abc', '\xCAFE', '2026-10-22', '23:59:58',
                    '10:00+07', '2026-10-22 01:02:03.456', '2026-10-22 01:02:03+07', '1 day 02:03:04', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
                    '{"a": 1}', '{"b": [1, 2]}', '{1,2,3}', '{"x","y z"}', '192.168.1.10', '10.0.0.0/8', '08:00:2b:01:02:03', '(1,2)',
                    '((0,0),(1,1))', to_tsvector('english', 'brain databases'), '<a>1</a>', 'happy', ROW(1, 'one'), '[1,10)')
            """.trimIndent(),
        )
        val row = s.table("SELECT * FROM syntax_test.types")
        val r = { c: String -> row.value(0, c) }
        assertEquals(9007199254740993L, (r("bi") as Number).toLong())
        assertEquals(BigDecimal("1234.567"), r("num"))
        assertEquals(true, r("b"))
        assertEquals("Halo 👋", r("t"))
        assertEquals("abc", r("ch"))
        assertArrayEquals(byteArrayOf(-54, -2), r("bin") as ByteArray)
        assertEquals("2026-10-22", r("dt"))
        assertEquals("23:59:58", r("tm"))
        assertTrue(r("ts").toString().startsWith("2026-10-22 01:02:03.456"))
        assertEquals("1 day 02:03:04", r("iv"))
        assertEquals("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", r("u").toString())
        assertEquals(JsonText("{\"a\": 1}"), r("j"))
        assertEquals(JsonText("{\"b\": [1, 2]}"), r("jb"))
        assertEquals("{1,2,3}", r("ia"))
        assertEquals("{x,\"y z\"}", r("ta"))
        assertEquals("192.168.1.10", r("ip").toString())
        // point is java.awt.Point in pgjdbc, which Android lacks: its text comes back instead of a crash
        assertEquals("(1,2)", r("pt").toString())
        assertEquals("<a>1</a>", r("x").toString())
        assertEquals("happy", r("mood"))
        assertEquals("(1,one)", r("pr").toString())
        assertEquals("[1,10)", r("rng").toString())
        assertEquals(null, r("nul"))
        // Grid edits cast typed text to each column's type (stringtype=unspecified)
        val ref = TableRef("shop", "syntax_test", "types")
        val key = mapOf("id" to row.value(0, "id"))
        listOf("i" to "42", "num" to "3.5", "b" to "false", "dt" to "2027-01-01", "u" to "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
            "jb" to "{\"c\": true}", "ia" to "{4,5}", "ip" to "10.1.2.3", "mood" to "sad", "iv" to "2 hours", "tstz" to "2027-01-01 00:00:00+00",
        ).forEach { (column, value) -> s.updateCell(ref, key, column, CellInput.Text(value)) }
        val after = s.table("SELECT i, num, b, dt, jb::text, ia::text, mood::text FROM syntax_test.types")
        assertEquals(listOf("42", "3.500", "false", "2027-01-01", "{\"c\": true}", "{4,5}", "sad"), after.rows[0].map { it.toString() })
    }

    @Test
    fun dataChangesAndReturning() {
        s.ok("CREATE TABLE syntax_test.t (id int PRIMARY KEY, name text UNIQUE, qty int DEFAULT 0)")
        assertEquals(3, s.table("INSERT INTO syntax_test.t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c') RETURNING id").rows.size)
        s.ok("INSERT INTO syntax_test.t AS x (id, name) VALUES (1, 'a') ON CONFLICT (id) DO UPDATE SET qty = x.qty + 5")
        s.ok("INSERT INTO syntax_test.t (id, name) VALUES (9, 'a') ON CONFLICT DO NOTHING")
        assertEquals("5", s.scalar("SELECT qty FROM syntax_test.t WHERE id = 1").toString())
        assertEquals(2L, s.ok("UPDATE syntax_test.t SET qty = qty + 1 WHERE id > 1").single().affected)
        s.ok("CREATE TABLE syntax_test.u (id int, bonus int); INSERT INTO syntax_test.u VALUES (2, 10), (3, 20)")
        s.ok("UPDATE syntax_test.t SET qty = t.qty + u.bonus FROM syntax_test.u u WHERE u.id = t.id")
        assertEquals("21", s.scalar("SELECT qty FROM syntax_test.t WHERE id = 3").toString())
        s.ok(
            "MERGE INTO syntax_test.t t USING syntax_test.u u ON t.id = u.id " +
                "WHEN MATCHED THEN UPDATE SET qty = 0 WHEN NOT MATCHED THEN INSERT (id, name) VALUES (u.id, 'merged')",
        )
        assertEquals("0", s.scalar("SELECT qty FROM syntax_test.t WHERE id = 2").toString())
        assertEquals(1, s.table("DELETE FROM syntax_test.t t USING syntax_test.u u WHERE u.id = t.id AND u.bonus = 20 RETURNING t.id").rows.size)
        classify("DELETE FROM syntax_test.t", SqlDialect.POSTGRES, reading = false, destructive = true)
        s.fails("INSERT INTO syntax_test.t (id, name) VALUES (1, 'z')", "duplicate key")
    }

    @Test
    fun schemaFunctionsAndProcedures() {
        s.ok(
            """
            CREATE TABLE syntax_test.ddl (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);
            ALTER TABLE syntax_test.ddl ADD COLUMN memo varchar(50) NOT NULL DEFAULT '';
            ALTER TABLE syntax_test.ddl RENAME COLUMN note TO body;
            CREATE INDEX CONCURRENTLY ddl_memo_idx ON syntax_test.ddl (memo);
            CREATE SEQUENCE syntax_test.seq START 100;
            CREATE MATERIALIZED VIEW syntax_test.mv AS SELECT city, count(*) FROM public.customers GROUP BY city;
            REFRESH MATERIALIZED VIEW syntax_test.mv;
            COMMENT ON TABLE syntax_test.ddl IS 'semicolons; in; comments';
            CREATE FUNCTION syntax_test.add(a int, b int) RETURNS int LANGUAGE plpgsql AS ${'$'}${'$'}
            BEGIN
              IF a IS NULL THEN RETURN b; END IF;
              RETURN a + b;
            END;
            ${'$'}${'$'};
            CREATE FUNCTION syntax_test.label(n int) RETURNS text LANGUAGE sql IMMUTABLE AS ${'$'}fn${'$'} SELECT CASE WHEN n > 1 THEN 'many; really' ELSE 'one' END ${'$'}fn${'$'};
            CREATE FUNCTION syntax_test.twice(n int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT n * 2; END;
            CREATE PROCEDURE syntax_test.bump(INOUT n int) LANGUAGE plpgsql AS ${'$'}${'$'} BEGIN n := n + 1; END ${'$'}${'$'};
            DO ${'$'}${'$'} BEGIN RAISE NOTICE 'hello from DO; block'; END ${'$'}${'$'};
            """.trimIndent(),
        )
        assertEquals("5", s.scalar("SELECT syntax_test.add(2, 3)").toString())
        assertEquals("many; really", s.scalar("SELECT syntax_test.label(2)"))
        assertEquals("8", s.scalar("SELECT syntax_test.twice(4)").toString())
        assertEquals("100", s.scalar("SELECT nextval('syntax_test.seq')").toString())
        assertEquals("2", s.table("CALL syntax_test.bump(1)").rows[0][0].toString())
        // RAISE NOTICE arrives as the statement's message
        val notice = s.ok("DO \$\$ BEGIN RAISE NOTICE 'visible notice'; END \$\$").single()
        assertTrue("notice shown: ${notice.message}", notice.message.orEmpty().contains("visible notice"))
        assertTrue(s.ok("VACUUM (ANALYZE) syntax_test.ddl").single().ok)
        val definition = s.definition(DbObject("add", ObjectKind.ROUTINE, schema = "syntax_test"))
        assertTrue(definition.orEmpty().contains("RETURN a + b"))
        classify("DROP SCHEMA syntax_test CASCADE", SqlDialect.POSTGRES, reading = false, destructive = true)
    }

    @Test
    fun transactionsRecoverFromErrors() {
        s.ok("CREATE TABLE syntax_test.tx (id int PRIMARY KEY)")
        s.ok("BEGIN; INSERT INTO syntax_test.tx VALUES (1); ROLLBACK")
        assertEquals("0", s.scalar("SELECT count(*) FROM syntax_test.tx").toString())
        s.ok("BEGIN; INSERT INTO syntax_test.tx VALUES (2); SAVEPOINT a; INSERT INTO syntax_test.tx VALUES (3); ROLLBACK TO SAVEPOINT a; COMMIT")
        assertEquals("1", s.scalar("SELECT count(*) FROM syntax_test.tx").toString())
        // An error inside BEGIN … leaves the transaction failed: it is rolled back so the session (and the grid) work on
        val error = s.fails("BEGIN; INSERT INTO syntax_test.tx VALUES (5); INSERT INTO syntax_test.tx VALUES (2)", "duplicate key")
        assertTrue(error.contains("rolled back"))
        assertEquals("1", s.scalar("SELECT count(*) FROM syntax_test.tx").toString())
        assertEquals(1, s.browse(TableRef("shop", "syntax_test", "tx"), BrowseRequest()).table.rows.size)
    }

    @Test
    fun commentsAndQuoting() {
        val results = s.ok(
            """
            -- line comment; with a semicolon
            /* block; comment /* nested in postgres */ still comment */
            SELECT 'it''s; -- not a comment' AS a, E'tab\there\n' AS b, ${'$'}${'$'}dollar; 'quoted' ${'$'}${'$'} AS c, ${'$'}q${'$'}a ${'$'}${'$'} inside${'$'}q${'$'} AS d;
            SELECT 'C:\' AS path;
            SELECT U&'\0441\043B\043E\043D' AS unicode
            """.trimIndent(),
        )
        assertEquals(3, results.size)
        val first = results[0].table!!
        assertEquals("it's; -- not a comment", first.value(0, "a"))
        assertEquals("tab\there\n", first.value(0, "b"))
        assertEquals("dollar; 'quoted' ", first.value(0, "c"))
        assertEquals("a \$\$ inside", first.value(0, "d"))
        assertEquals("C:\\", results[1].table!!.rows[0][0])
        assertEquals("слон", results[2].table!!.rows[0][0])
    }

    @Test
    fun errorsLeaveTheSessionUsable() {
        s.fails("SELEC 1", "syntax error")
        s.fails("SELECT * FROM no_such_table", "does not exist")
        s.fails("\\dt", "syntax error")
        s.fails("COPY customers TO STDOUT", "COPY")
        s.fails("SELECT 1/0", "division by zero")
        assertEquals("1", s.scalar("SELECT 1").toString())
        assertEquals(2, s.execute("SELECT 1; SELECT * FROM nope; SELECT 3").size)
    }

    @Test
    fun notifyFromTheEditor() {
        s.ok("LISTEN syntax_ch; NOTIFY syntax_ch, 'payload; with semicolon'; SELECT pg_notify('syntax_ch', 'second'); UNLISTEN syntax_ch")
    }

    @Test
    fun autoPaging() {
        val total = s.scalar("SELECT count(*) FROM customers").toString().toInt()
        val stmt = pageableSelect("SELECT id, name FROM customers ORDER BY id", SqlDialect.POSTGRES)!!
        assertEquals(51, s.table(pagedSql(stmt, 0, 50)).rows.size)
        val lastPage = (total - 1) / 50
        val last = s.table(pagedSql(stmt, lastPage, 50))
        assertEquals(total - lastPage * 50, last.rows.size)
        listOf(
            "SELECT * FROM customers LIMIT 5", "SELECT * FROM customers FETCH FIRST 5 ROWS ONLY", "SELECT * FROM customers FOR UPDATE",
            "SELECT * INTO syntax_test.copy FROM customers", "SHOW ALL", "TABLE customers",
        ).forEach { assertEquals(it, null, pageableSelect(it, SqlDialect.POSTGRES)) }
    }

    @Test
    fun readOnlyConnectionsRefuseWritesTwice() {
        s.ok("CREATE SEQUENCE syntax_test.ro_seq")
        openSession(profile(readOnly = true), env).use { ro ->
            assertTrue(ro.table("SHOW ALL").rows.size > 300)
            assertEquals("on", ro.scalar("SHOW transaction_read_only"))
            ro.fails("INSERT INTO customers (name) VALUES ('x')", "read-only")
            ro.fails("SELECT * INTO syntax_test.copy FROM customers", "read-only")
            ro.fails("EXPLAIN ANALYZE DELETE FROM customers", "read-only")
            // A function that writes, called from a SELECT, passes the check but not the server
            ro.fails("SELECT nextval('syntax_test.ro_seq')", "read-only transaction")
            ro.fails("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", "read-only")
            assertEquals("1", ro.scalar("SELECT 1").toString())
        }
    }

    @Test
    fun aLongQueryCanBeStopped() {
        var results: List<StatementResult>? = null
        val runner = thread { results = s.execute("SELECT pg_sleep(20)") }
        Thread.sleep(1500)
        val start = System.currentTimeMillis()
        s.cancel()
        runner.join(10_000)
        assertFalse("pg_sleep(20) should stop when cancelled", runner.isAlive)
        assertTrue(System.currentTimeMillis() - start < 8000)
        assertTrue(results!!.single().error.orEmpty().contains("cancel", ignoreCase = true))
        assertEquals("1", s.scalar("SELECT 1").toString())
    }

    @Test
    fun switchingDatabases() {
        s.useDatabase("analytics")
        assertEquals("analytics", s.currentDatabase)
        assertEquals("analytics", s.scalar("SELECT current_database()"))
        s.useDatabase("shop")
        assertEquals("shop", s.scalar("SELECT current_database()"))
    }
}
