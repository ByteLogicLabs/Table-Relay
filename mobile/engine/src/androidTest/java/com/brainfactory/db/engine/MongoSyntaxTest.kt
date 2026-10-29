package com.brainfactory.db.engine

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.bson.types.ObjectId
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** mongosh syntax through Brain DB's MongoDB session (the Java sync driver 4.11 on Android). */
@RunWith(AndroidJUnit4::class)
class MongoSyntaxTest : SyntaxSuite() {
    private val port = args.getString("mongoPort", "27117").toInt()
    private val authPort = args.getString("mongoAuthPort", "27118").toInt()
    private lateinit var s: DbSession

    private fun profile(readOnly: Boolean = false) = ConnectionProfile(
        name = "syntax", driver = Driver.MONGO, host = host, port = port, database = "shop", sslMode = SslMode.DISABLE, readOnly = readOnly,
    )

    @Before
    fun open() {
        requireServer(port)
        s = openSession(profile(), env)
        s.ok("db.syntax_test.drop()")
    }

    @After
    fun close() {
        if (::s.isInitialized) {
            runCatching { s.execute("db.syntax_test.drop(); db.syntax_renamed.drop()") }
            s.close()
        }
        log("MongoDB: $statements statements so far")
    }

    @Test
    fun showUseAndDatabaseHelpers() {
        assertTrue(s.table("show dbs").rows.any { it[0] == "shop" })
        assertTrue(s.table("show collections").rows.any { it[0] == "customers" })
        assertEquals("shop", s.ok("db.getName()").single().message)
        listOf(
            "db.stats()", "db.serverStatus()", "db.hostInfo()", "db.hello()", "db.isMaster()", "db.getCollectionNames()",
            "db.getCollectionInfos()", "db.runCommand({ ping: 1 })", "db.runCommand({ buildInfo: 1 })", "db.adminCommand({ listDatabases: 1 })",
            "db.currentOp()", "rs.status()", "rs.conf()", "db.customers.stats()", "db.customers.getIndexes()",
        ).forEach { s.ok(it) }
        assertTrue(s.ok("db.version()").single().message.orEmpty().startsWith("7."))
        assertTrue(s.table("rs.status()").rows.isNotEmpty())
        s.ok("use logs")
        assertEquals("logs", s.currentDatabase)
        assertEquals(2, s.table("db.access.find()").rows.size)
        s.ok("use shop")
        assertEquals(2, s.table("db.getSiblingDB('logs').access.find({})").rows.size)
        assertEquals(640, s.table("db.getCollection('customers').find()").rows.size)
    }

    @Test
    fun findSyntax() {
        val finds = mapOf(
            "db.customers.find({ age: { \$gt: 60 } })" to 84,
            "db.customers.find({ age: { \$gte: 60 } }).count()" to -1,
            "db.customers.find({ city: { \$in: ['Medan', 'Jakarta'] } }, { name: 1, city: 1, _id: 0 }).sort({ name: 1 }).limit(5)" to 5,
            "db.customers.find({ name: /^pelanggan 1/i }).limit(3)" to 3,
            "db.customers.find({ name: { \$regex: '^Pelanggan 2', \$options: 'i' } }).skip(2).limit(4)" to 4,
            "db.customers.find({ vip: { \$exists: true } }).sort({ age: -1, name: 1 }).limit(10)" to 10,
            "db.customers.find({ 'address.zip': '10005' })" to 1,
            "db.customers.find({ orders: { \$elemMatch: { qty: { \$gte: 3 } } } }).limit(2)" to 2,
            "db.customers.find({ \$or: [{ city: 'Medan' }, { age: { \$lt: 20 } }], active: true }).limit(7)" to 7,
            "db.customers.find({ \$expr: { \$gt: ['\$age', 66] } })" to -1,
            "db.customers.find({ joined: { \$gte: ISODate('2025-06-01T00:00:00Z') } }).limit(5)" to 5,
            "db.customers.find({ _id: { \$type: 'objectId' } }).limit(1).pretty()" to 1,
            "db.customers.find().sort({ _id: -1 }).limit(1).toArray()" to 1,
            "db.customers.findOne({ city: 'Bandung' })" to 1,
            "db.customers.findOne({ city: 'Bandung' }, { name: 1 })" to 1,
        )
        finds.forEach { (cmd, rows) ->
            assertTrue("reading: $cmd", runCatching { parseShell(cmd) }.isSuccess)
            val result = s.ok(cmd).single()
            if (rows >= 0) assertEquals(cmd, rows, result.table!!.rows.size) else assertTrue(cmd, result.message != null || result.table != null)
        }
        assertEquals("640 documents", s.ok("db.customers.countDocuments({})").single().message)
        assertEquals("640 documents", s.ok("db.customers.estimatedDocumentCount()").single().message)
        assertEquals(4, s.table("db.customers.distinct('city')").rows.size)
        assertEquals(2, s.table("db.customers.distinct('city', { city: { \$in: ['Medan', 'Bandung'] } })").rows.size)
        // .explain() gives the plan as one document
        assertTrue(s.table("db.customers.find({ email: 'p1@example.com' }).explain()").columns.any { it.name == "queryPlanner" })
    }

    @Test
    fun aggregateSyntax() {
        val pipelines = mapOf(
            "db.customers.aggregate([{ \$group: { _id: '\$city', n: { \$sum: 1 }, avgAge: { \$avg: '\$age' } } }, { \$sort: { n: -1 } }])" to 4,
            "db.customers.aggregate([{ \$match: { active: true } }, { \$unwind: '\$orders' }, { \$group: { _id: '\$orders.sku', qty: { \$sum: '\$orders.qty' } } }])" to 4,
            "db.customers.aggregate([{ \$project: { name: 1, decade: { \$multiply: [{ \$floor: { \$divide: ['\$age', 10] } }, 10] } } }, { \$limit: 3 }])" to 3,
            "db.customers.aggregate([{ \$facet: { cities: [{ \$sortByCount: '\$city' }], total: [{ \$count: 'n' }] } }])" to 1,
            "db.customers.aggregate([{ \$bucket: { groupBy: '\$age', boundaries: [18, 30, 50, 70], default: 'other' } }])" to 4,
            "db.customers.aggregate([{ \$limit: 2 }, { \$lookup: { from: 'events', pipeline: [{ \$limit: 1 }], as: 'ev' } }])" to 2,
            "db.customers.aggregate([{ \$count: 'all' }])" to 1,
        )
        pipelines.forEach { (cmd, rows) -> assertEquals(cmd, rows, s.table(cmd).rows.size) }
        assertTrue(s.table("db.customers.aggregate([{ \$match: { age: 30 } }]).explain()").rows.isNotEmpty())
    }

    @Test
    fun writeSyntax() {
        val id = ObjectId()
        val inserted = s.ok(
            "db.syntax_test.insertOne({ _id: ObjectId('${id.toHexString()}'), name: 'satu', n: NumberLong(5), price: NumberDecimal('9.99'), " +
                "at: ISODate('2026-10-22T01:02:03Z'), tags: ['a', 'b'], nested: { x: 1, y: [1, 2, { z: true }] } })",
        ).single()
        assertTrue(inserted.message.orEmpty().contains(id.toHexString()))
        assertEquals(3L, s.ok("db.syntax_test.insertMany([{ name: 'dua', n: 2 }, { name: 'tiga', n: 3 }, { name: 'empat', n: 4 }])").single().affected)
        s.ok(
            """
            db.syntax_test.updateOne({ name: 'dua' }, { ${'$'}set: { city: 'Medan' }, ${'$'}inc: { n: 10 }, ${'$'}push: { tags: 'x' } })
            db.syntax_test.updateOne({ name: 'lima' }, { ${'$'}set: { n: 5 } }, { upsert: true })
            db.syntax_test.updateMany({ n: { ${'$'}gte: 3 } }, [{ ${'$'}set: { big: { ${'$'}gt: ['${'$'}n', 4] } } }])
            db.syntax_test.updateMany({}, { ${'$'}unset: { nested: '' } })
            db.syntax_test.replaceOne({ name: 'tiga' }, { name: 'tiga', replaced: true })
            """.trimIndent(),
        )
        assertEquals("12", s.table("db.syntax_test.findOne({ name: 'dua' })").value(0, "n").toString())
        assertEquals(true, s.table("db.syntax_test.findOne({ name: 'tiga' })").value(0, "replaced"))
        val after = s.table("db.syntax_test.findOneAndUpdate({ name: 'empat' }, { \$set: { n: 40 } }, { returnDocument: 'after' })")
        assertEquals("40", after.value(0, "n").toString())
        assertEquals(1L, s.ok("db.syntax_test.findOneAndDelete({ name: 'lima' })").single().affected)
        assertEquals(1L, s.ok("db.syntax_test.deleteOne({ name: 'empat' })").single().affected)
        assertTrue(s.ok("db.syntax_test.createIndex({ name: 1 }, { unique: true, name: 'name_unique' })").single().message.orEmpty().contains("name_unique"))
        s.fails("db.syntax_test.insertOne({ name: 'dua' })", "duplicate key")
        assertEquals(2, s.table("db.syntax_test.getIndexes()").rows.size)
        s.ok("db.syntax_test.dropIndex('name_unique'); db.syntax_test.renameCollection('syntax_renamed'); db.syntax_renamed.drop()")
        assertFalse(s.table("show collections").rows.any { it[0] == "syntax_renamed" })
        assertEquals(2, analyzeMongoDestructive("db.syntax_test.drop()\ndb.syntax_test.deleteMany({})").size)
    }

    @Test
    fun commentsSemicolonsAndErrors() {
        val results = s.ok(
            """
            // a comment; with a semicolon
            db.customers.find({ name: 'Pelanggan 1' }) // trailing comment
            db.customers.countDocuments({ city: 'Medan' }); db.customers.findOne({ note: "a; b // c" })
            """.trimIndent(),
        )
        assertEquals(3, results.size)
        s.fails("db.customers.frobnicate()", "isn't supported")
        s.fails("db.customers.find({ age: { \$gt: } })", "valid")
        s.fails("db.runCommand({ noSuchCommand: 1 })", "no such command")
        s.fails("SELECT * FROM customers", "start with db.")
        assertEquals("640 documents", s.ok("db.customers.countDocuments()").single().message)
    }

    @Test
    fun autoPagingFind() {
        val cmd = pageableFind("db.customers.find({ active: true }).sort({ _id: 1 })")!!
        val total = s.ok("db.customers.countDocuments({ active: true })").single().message!!.substringBefore(' ').toInt()
        assertEquals(101, s.table(pagedFind(cmd, 0, 100)).rows.size)
        val lastPage = (total - 1) / 100
        assertEquals(total - lastPage * 100, s.table(pagedFind(cmd, lastPage, 100)).rows.size)
        assertEquals(null, pageableFind("db.customers.find().limit(3)"))
    }

    @Test
    fun readOnlyConnections() {
        openSession(profile(readOnly = true), env).use { ro ->
            assertEquals(640, ro.table("db.customers.find()").rows.size)
            assertTrue(ro.table("db.customers.aggregate([{ \$count: 'n' }])").rows.isNotEmpty())
            ro.ok("db.serverStatus(); rs.status(); show dbs")
            ro.fails("db.customers.insertOne({ x: 1 })", "read-only")
            ro.fails("db.customers.deleteMany({})", "read-only")
            ro.fails("db.runCommand({ drop: 'customers' })", "read-only")
            ro.fails("db.customers.aggregate([{ \$out: 'copy' }])", "read-only")
        }
        assertEquals("640 documents", s.ok("db.customers.countDocuments()").single().message)
    }

    @Test
    fun signInWithScram() {
        requireServer(authPort)
        val profile = ConnectionProfile(name = "auth", driver = Driver.MONGO, host = host, port = authPort, user = "brain", password = "brainpass", sslMode = SslMode.DISABLE)
        openSession(profile, env).use { a ->
            a.useDatabase("shop")
            assertEquals(640, a.table("db.customers.find()").rows.size)
        }
        val wrong = profile.copy(password = "nope")
        val error = runCatching { openSession(wrong, env).close() }.exceptionOrNull()
        assertTrue("wrong password refused: $error", error?.message.orEmpty().contains("Sign-in refused"))
    }
}
