package com.brainfactory.db.engine

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** redis-cli syntax through Brain DB's Redis session (its own RESP client). Keys it makes start with "syntax:". */
@RunWith(AndroidJUnit4::class)
class RedisSyntaxTest : SyntaxSuite() {
    private val port = args.getString("redisPort", "26379").toInt()
    private lateinit var s: RedisSession

    private fun profile(readOnly: Boolean = false) = ConnectionProfile(
        name = "syntax", driver = Driver.REDIS, host = host, port = port, password = "brainpass", database = "0", sslMode = SslMode.DISABLE, readOnly = readOnly,
    )

    @Before
    fun open() {
        requireServer(port)
        s = openSession(profile(), env) as RedisSession
        cleanUp()
    }

    @After
    fun close() {
        if (::s.isInitialized) {
            cleanUp()
            s.close()
        }
        log("Redis: $statements statements so far")
    }

    private fun cleanUp() {
        val keys = s.scan("syntax:*", "0", 100_000).second.map { it.name }
        if (keys.isNotEmpty()) s.delete(keys)
    }

    private fun reply(line: String): StatementResult = s.ok(line).single()

    @Test
    fun serverCommands() {
        val info = s.table("INFO")
        assertEquals(listOf("section", "field", "value"), info.columns.map { it.name })
        assertTrue(info.rows.any { it[1] == "redis_version" && (it[2] as String).startsWith("7.") })
        assertTrue(s.table("INFO keyspace").rows.any { it[1] == "db0" })
        val config = s.table("CONFIG GET maxmemory*")
        assertEquals(listOf("parameter", "value"), config.columns.map { it.name })
        assertTrue(config.rows.any { it[0] == "maxmemory-policy" })
        val clients = s.table("CLIENT LIST")
        assertTrue(clients.columns.any { it.name == "addr" } && clients.rows.isNotEmpty())
        listOf(
            "PING" to "PONG", "ECHO \"halo dunia\"" to null, "DBSIZE" to null, "TIME" to null, "LASTSAVE" to null, "ROLE" to null,
            "CLIENT GETNAME" to null, "SLOWLOG GET 5" to null, "COMMAND COUNT" to null, "INFO server" to null, "MEMORY USAGE greeting" to null,
            "OBJECT ENCODING counter" to null, "TYPE user:1" to "hash", "EXISTS greeting counter nope" to "(integer) 2",
        ).forEach { (line, expect) ->
            val r = reply(line)
            if (expect != null) assertEquals(line, expect, r.message)
        }
        assertEquals("halo dunia", s.table("ECHO \"halo dunia\"").rows[0][0])
    }

    @Test
    fun dataTypes() {
        val lines = """
            SET syntax:s "hello world"
            APPEND syntax:s "!"
            STRLEN syntax:s
            SETRANGE syntax:s 0 H
            GETRANGE syntax:s 0 4
            INCR syntax:n
            INCRBY syntax:n 41
            DECR syntax:n
            MSET syntax:a 1 syntax:b 2
            MGET syntax:a syntax:b syntax:missing
            SETEX syntax:tmp 100 temp
            SETNX syntax:a again
            GETDEL syntax:b
            HSET syntax:h name Ayu city Jakarta age 30
            HINCRBY syntax:h age 1
            HDEL syntax:h city
            HKEYS syntax:h
            HLEN syntax:h
            RPUSH syntax:l a b c
            LPUSH syntax:l z
            LSET syntax:l 1 A
            LREM syntax:l 1 c
            LRANGE syntax:l 0 -1
            LPOP syntax:l
            SADD syntax:set kopi teh gula teh
            SREM syntax:set gula
            SISMEMBER syntax:set kopi
            SCARD syntax:set
            ZADD syntax:z 10 a 30 c 20 b
            ZINCRBY syntax:z 5 a
            ZRANK syntax:z c
            ZSCORE syntax:z b
            ZCOUNT syntax:z 0 20
            XADD syntax:x * type login user ayu
            XADD syntax:x * type logout user ayu
            XLEN syntax:x
            EXPIRE syntax:s 300
            TTL syntax:s
            PERSIST syntax:s
            RENAME syntax:a syntax:a2
            COPY syntax:a2 syntax:a3
            UNLINK syntax:a3
        """.trimIndent()
        val results = s.ok(lines)
        assertEquals(lines.lines().size, results.size)
        assertEquals("Hello world!", s.table("GET syntax:s").rows[0][0])
        assertEquals("(integer) 41", reply("GET syntax:n").let { "(integer) " + it.table!!.rows[0][0] })
        assertEquals(listOf("1", "(nil)", "(nil)"), s.table("MGET syntax:a2 syntax:b syntax:missing").rows.map { it[1].toString() })
        val hash = s.table("HGETALL syntax:h")
        assertEquals(listOf("field", "value"), hash.columns.map { it.name })
        assertEquals(mapOf("name" to "Ayu", "age" to "31"), hash.rows.associate { it[0] to it[1] })
        assertEquals(listOf("A", "b"), s.table("LRANGE syntax:l 0 -1").rows.map { it[1] })
        val zset = s.table("ZRANGE syntax:z 0 -1 WITHSCORES")
        assertEquals(listOf("member", "score"), zset.columns.map { it.name })
        assertEquals(listOf("a" to "15", "b" to "20", "c" to "30"), zset.rows.map { it[0] to it[1] })
        assertEquals(2, s.table("XRANGE syntax:x - +").rows.size)
        assertEquals(2, s.table("SMEMBERS syntax:set").rows.size)
        // The key browser and key view read them as the types they are
        assertEquals("hash", s.scan("syntax:h", "0", 100_000).second.single().type)
        assertTrue(s.value("syntax:z") is RedisValue.ZSetV)
        assertTrue(s.value("syntax:x") is RedisValue.StreamV)
    }

    @Test
    fun keysTransactionsAndScripts() {
        s.ok("MSET syntax:k1 a syntax:k2 b syntax:k3 c")
        assertEquals(3, s.table("KEYS syntax:k*").rows.size)
        val scan = s.table("SCAN 0 MATCH syntax:k* COUNT 1000")
        assertEquals(2, scan.rows.size)
        // MULTI … EXEC on the console's one connection
        val tx = s.ok("MULTI\nSET syntax:t 1\nINCR syntax:t\nEXEC")
        assertEquals("QUEUED", tx[1].message)
        assertEquals(2, tx[3].table!!.rows.size)
        assertEquals("2", s.table("GET syntax:t").rows[0][0])
        s.ok("MULTI\nSET syntax:t 100\nDISCARD")
        assertEquals("2", s.table("GET syntax:t").rows[0][0])
        val script = s.table("EVAL \"return {1, 2, 'three', redis.call('GET', KEYS[1])}\" 1 syntax:t")
        assertEquals(listOf("1", "2", "three", "2"), script.rows.map { it[1].toString() })
        assertEquals("(integer) 0", reply("PUBLISH syntax:channel hello").message)
    }

    @Test
    fun databasesQuotingAndErrors() {
        s.ok("SELECT 2")
        assertEquals("db2", s.currentDatabase)
        assertEquals("yes", s.table("GET other:db").rows[0][0])
        s.ok("SELECT 0")
        assertEquals("db0", s.currentDatabase)
        s.ok("SET \"syntax:quoted key\" 'it\\'s \"fine\"'")
        assertEquals("it's \"fine\"", s.table("GET \"syntax:quoted key\"").rows[0][0])
        s.ok("SET syntax:bin \"\\x00\\xff\"")
        assertTrue((s.table("GET syntax:bin").rows[0][0] as String).startsWith("0x"))
        s.fails("NOSUCHCOMMAND x", "unknown command")
        s.fails("HSET syntax:l2 a 1\nLPUSH syntax:l2 x", "WRONGTYPE")
        s.fails("GET \"unbalanced", "Unbalanced quotes")
        s.fails("SUBSCRIBE news", "Pub/Sub")
        s.fails("MONITOR", "Pub/Sub")
        assertEquals("PONG", reply("PING").message)
        assertEquals(listOf("FLUSHDB", "FLUSHALL"), analyzeRedisDestructive("flushdb\nGET a\nFLUSHALL").map { it.kind })
    }

    @Test
    fun readOnlyConnections() {
        (openSession(profile(readOnly = true), env) as RedisSession).use { ro ->
            assertTrue(ro.table("INFO").rows.isNotEmpty())
            ro.ok("GET greeting\nHGETALL user:1\nSCAN 0 COUNT 10\nTTL greeting")
            ro.fails("SET syntax:ro 1", "read-only")
            ro.fails("FLUSHDB", "read-only")
            ro.fails("CONFIG SET maxmemory 1", "read-only")
            assertTrue(ro.table("CONFIG GET maxmemory").rows.isNotEmpty())
            assertTrue(ro.table("CLIENT LIST").rows.isNotEmpty())
        }
    }
}
