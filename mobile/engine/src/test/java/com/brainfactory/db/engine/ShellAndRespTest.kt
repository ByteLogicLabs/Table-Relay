package com.brainfactory.db.engine

import java.io.ByteArrayInputStream
import org.bson.Document
import org.bson.types.ObjectId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellAndRespTest {

    @Test
    fun splitsShellCommandsOnSemicolonsAndNewCommandLines() {
        val text = """
            db.users.find({ a: ";" })  // a comment; really
            db.users.aggregate([
              { ${'$'}match: { x: 1 } }
            ]); show collections
            use other
        """.trimIndent()
        val parts = splitShell(text)
        assertEquals(4, parts.size)
        assertEquals("db.users.find({ a: \";\" })", parts[0])
        assertTrue(parts[1].startsWith("db.users.aggregate(["))
        assertEquals("show collections", parts[2])
        assertEquals("use other", parts[3])
    }

    @Test
    fun parsesCollectionCallsAndChains() {
        val c = parseShell("db.orders.find({ total: { \$gt: 10 } }, { _id: 0 }).sort({ total: -1 }).limit(5);") as ShellCommand.OnCollection
        assertEquals("orders", c.collection)
        assertEquals("find", c.call.name)
        assertEquals(listOf("{ total: { \$gt: 10 } }", "{ _id: 0 }"), c.call.args)
        assertEquals(listOf("sort", "limit"), c.chain.map { it.name })
        val g = parseShell("db.getSiblingDB('logs').getCollection(\"access-2026\").countDocuments({})") as ShellCommand.OnCollection
        assertEquals("logs", g.database)
        assertEquals("access-2026", g.collection)
        val dotted = parseShell("db.system.profile.find()") as ShellCommand.OnCollection
        assertEquals("system.profile", dotted.collection)
        val bracket = parseShell("db['weird name'].findOne()") as ShellCommand.OnCollection
        assertEquals("weird name", bracket.collection)
        val onDb = parseShell("db.runCommand({ ping: 1 })") as ShellCommand.OnDatabase
        assertEquals("runCommand", onDb.call.name)
        assertEquals(ShellCommand.Use("shop", "use shop"), parseShell("use shop"))
        assertEquals(ShellCommand.Show("dbs", "show dbs"), parseShell("show dbs"))
        assertThrows(DbException::class.java) { parseShell("SELECT 1") }
        assertThrows(DbException::class.java) { parseShell("db.users") }
    }

    @Test
    fun splitsArgumentsOnTopLevelCommasOnly() {
        assertEquals(listOf("{ a: [1, 2] }", "'x,y'", "fn(1, 2)"), splitArgs("{ a: [1, 2] }, 'x,y', fn(1, 2)"))
        assertEquals(emptyList<String>(), splitArgs(""))
    }

    @Test
    fun flagsMongoCommandsThatCantBeUndone() {
        val found = analyzeMongoDestructive("db.a.drop()\ndb.b.deleteMany({})\ndb.b.deleteMany({ x: 1 })\ndb.c.updateMany({}, { \$set: { y: 1 } })\ndb.dropDatabase()")
        assertEquals(listOf("DROP", "DELETE", "UPDATE", "DROP"), found.map { it.kind })
    }

    @Test
    fun readsShellValues() {
        assertEquals(42, parseValue("42"))
        assertEquals(true, parseValue("true"))
        assertNull(parseValue("null"))
        assertEquals("plain text", parseValue("plain text"))
        assertEquals(ObjectId("6ad901b1da714d8d89dbd106"), parseValue("ObjectId(\"6ad901b1da714d8d89dbd106\")"))
        assertEquals(Document("a", 1), parseValue("{ a: 1 }"))
        assertEquals(listOf(1, 2), parseValue("[1, 2]"))
    }

    @Test
    fun documentsBecomeAGridWithIdFirst() {
        val id = ObjectId("6ad901b1da714d8d89dbd106")
        val table = documentsTable(listOf(Document("name", "Ayu").append("_id", id), Document("_id", 2).append("tags", listOf("a"))))
        assertEquals(listOf("_id", "name", "tags"), table.columns.map { it.name })
        assertTrue(table.columns[0].key)
        assertEquals(TaggedValue("ObjectId(\"6ad901b1da714d8d89dbd106\")", id), table.rows[0][0])
        assertEquals(Absent, table.rows[0][2])
        assertEquals(JsonText("[\"a\"]"), table.rows[1][2])
        assertEquals(id, rawOf(table.rows[0][0]))
    }

    @Test
    fun splitsRedisCliArguments() {
        assertEquals(listOf("SET", "quoted key", "hello world"), splitRedisArgs("SET \"quoted key\" \"hello world\""))
        assertEquals(listOf("SET", "k", "it's"), splitRedisArgs("SET k 'it\\'s'"))
        assertEquals(listOf("SET", "k", "a\nb", "\u0001"), splitRedisArgs("SET k \"a\\nb\" \"\\x01\""))
        assertEquals(listOf("GET", "x"), splitRedisArgs("  GET   x  "))
        assertThrows(DbException::class.java) { splitRedisArgs("GET \"open") }
        assertEquals(listOf("FLUSHALL"), analyzeRedisDestructive("GET a\nflushall\n").map { it.kind })
    }

    @Test
    fun decodesBinaryRedisValuesAsHex() {
        assertEquals("héllo", decodeRedisText("héllo".toByteArray()))
        assertEquals("0xff00", decodeRedisText(byteArrayOf(-1, 0)))
    }

    @Test
    fun parsesRespReplies() {
        val reply = "*3\r\n\$3\r\nfoo\r\n:42\r\n*2\r\n+OK\r\n\$-1\r\n"
        val value = readResp(reply)
        val items = (value as Resp.Multi).items!!
        assertEquals("foo", (items[0] as Resp.Bulk).text)
        assertEquals(Resp.Integer(42), items[1])
        val inner = (items[2] as Resp.Multi).items!!
        assertEquals(Resp.Simple("OK"), inner[0])
        assertNull((inner[1] as Resp.Bulk).bytes)
        assertEquals(Resp.Error("ERR nope"), readResp("-ERR nope\r\n"))
    }

    private fun readResp(text: String): Resp = RespReader(ByteArrayInputStream(text.toByteArray())).read()
}
