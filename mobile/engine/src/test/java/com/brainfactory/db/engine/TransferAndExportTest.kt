package com.brainfactory.db.engine

import java.io.StringWriter
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.postgresql.util.PGPropertyMaxResultBufferParser

class TransferAndExportTest {

    /**
     * A Table Relay connections export, encrypted with the password "brain" by an independent RNCryptor v3
     * implementation (Python's cryptography package), with fixed salts and IV.
     */
    private val desktopExport = "AwEAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eH5p5JqiRIiN5E/G5GSKDl6UePukLrXwVGXV/W37+RZVUH+PitjR4WmrMjkCn+/RANL4YtbMwpNSPC3L70xilV8JROOKzeMMMIdyxoCc/panJCPu01w/5XcrHmTIswmQ1wYUOp0bw90i6NtrXvFhDgjfsJR8PIHM1Nc69Oj4PkzJQgoN0xnPS9pwV9SNDvtfsRJQ305x9n2Rx3Db02pAgbKXnWh1KAPx5ukh0Sv8BOxdEcyHQosYG0tLfPSccWKJIbua7gB6+qDd01w5AFvpwaQxBUVNDzHPpaNh52YcIUIpbcJEkTGW36GxtrcYJlzEsOLKTb5oPGQegWwHVjRx5R0qNdtjpia0qiPECGzCkY0N+32z1wp474nTBqGGLwd+dByYHVP1ZDPsaaY31FMN77VOAqBYqoiZepARDatN6GbM4UtKeO1yeioKSx1V7HBiPvDPeuy0BaBtB4CmnIE+89gA8meqAd8mhzcC6CQT3ftQFy7Kyl7Tqmq7OrJblkCuwGwxntmZMFztZ1JeYRBiK0SMojBLaOAG9ABbQ9/rt6nM1Q7y7FPOnl9LTwmna6XfixNCC3AuIXBv/8fTZkR2vVsk="

    @Test
    fun readsADesktopExport() {
        val data = Base64.getDecoder().decode(desktopExport)
        assertTrue(ConnectionTransfer.isEncrypted(data))
        val profiles = ConnectionTransfer.fromJson(String(ConnectionTransfer.decrypt(data, "brain")))
        assertEquals(1, profiles.size)
        val p = profiles.single()
        assertEquals("Prod", p.name)
        assertEquals(Driver.POSTGRES, p.driver)
        assertEquals("db.example.com", p.host)
        assertEquals(SslMode.REQUIRED, p.sslMode)
        assertTrue(p.favorite)
        assertEquals(0xFF3B82F6, p.color)
        val ssh = p.ssh!!
        assertEquals("jump.example.com", ssh.host)
        assertEquals(2222, ssh.port)
        assertEquals(SshAuth.KEY, ssh.auth)
        // The desktop's key file path doesn't come along; the key has to be pasted in once.
        assertEquals("", ssh.privateKey)
        assertThrows(ConnectionTransfer.BadPassword::class.java) { ConnectionTransfer.decrypt(data, "wrong") }
    }

    @Test
    fun encryptsWhatItCanDecrypt() {
        val profiles = listOf(
            ConnectionProfile(name = "A", driver = Driver.MYSQL, host = "h", user = "u", password = "p", database = "d"),
            ConnectionProfile(name = "B", driver = Driver.REDIS, host = "r", port = 6380, ssh = SshConfig("j", 22, "me", SshAuth.PASSWORD, "pw")),
        )
        val blob = ConnectionTransfer.encrypt(ConnectionTransfer.toJson(profiles).toByteArray(), "secret")
        val back = ConnectionTransfer.fromJson(String(ConnectionTransfer.decrypt(blob, "secret")))
        assertEquals(profiles, back)
        assertFalse(ConnectionTransfer.isEncrypted("{\"version\":1}".toByteArray()))
    }

    @Test
    fun readsPlainExportsAndBareArrays() {
        val json = """[{"driver":"MongoDB","host":"mongodb+srv://u:p@c.example.net/app","name":"Atlas"},{"driver":"Oracle","host":"x"}]"""
        val list = ConnectionTransfer.fromJson(json)
        assertEquals(1, list.size)
        assertTrue(list[0].usesUri)
        assertEquals("MongoDB · c.example.net", list[0].summary)
    }

    @Test
    fun parsesConnectionUrls() {
        val pg = parseConnectionUrl("postgres://app:p%40ss@db.example.com:6543/orders?sslmode=require")!!
        assertEquals(Driver.POSTGRES, pg.driver)
        assertEquals("app", pg.user)
        assertEquals("p@ss", pg.password)
        assertEquals(6543, pg.port)
        assertEquals("orders", pg.database)
        assertEquals(SslMode.REQUIRED, pg.sslMode)
        val my = parseConnectionUrl("mysql://root@localhost/shop")!!
        assertEquals(3306, my.port)
        assertEquals("", my.password)
        assertEquals(SslMode.REQUIRED, parseConnectionUrl("rediss://:pw@cache:6380/2")!!.sslMode)
        assertEquals("2", parseConnectionUrl("redis://:pw@cache:6380/2")!!.database)
        assertTrue(parseConnectionUrl("mongodb+srv://u:p@cluster0.example.net/app")!!.usesUri)
        assertEquals("/data/x.db", parseConnectionUrl("sqlite:///data/x.db")!!.database)
        assertNull(parseConnectionUrl("ftp://nope"))
        assertNull(parseConnectionUrl("not a url"))
    }

    @Test
    fun exportsEachFormat() {
        val columns = listOf("id", "name", "meta", "photo")
        val rows = listOf(
            listOf(1L, "Ayu, \"A\"", JsonText("{\"vip\":true}"), byteArrayOf(1, 2)),
            listOf(2L, null, null, null),
        )
        fun export(format: ExportFormat, dialect: SqlDialect = SqlDialect.MYSQL): String {
            val out = StringWriter()
            val e = ResultExporter(format, columns, out, dialect, "users")
            e.begin(); rows.forEach(e::row); e.end()
            return out.toString()
        }
        assertEquals("id,name,meta,photo\n1,\"Ayu, \"\"A\"\"\",\"{\"\"vip\"\":true}\",0x0102\n2,,,\n", export(ExportFormat.CSV))
        assertEquals("id\tname\tmeta\tphoto\n1\tAyu, \"A\"\t{\"vip\":true}\t0x0102\n2\t\t\t\n", export(ExportFormat.TSV))
        assertEquals(
            "[\n  {\"id\":1,\"name\":\"Ayu, \\\"A\\\"\",\"meta\":{\"vip\":true},\"photo\":\"0x0102\"},\n  {\"id\":2,\"name\":null,\"meta\":null,\"photo\":null}\n]\n",
            export(ExportFormat.JSON),
        )
        assertEquals(2, export(ExportFormat.NDJSON).trim().lines().size)
        assertEquals(
            "INSERT INTO \"users\" (\"id\", \"name\", \"meta\", \"photo\") VALUES (1, 'Ayu, \"A\"', '{\"vip\":true}', '\\x0102');\n" +
                "INSERT INTO \"users\" (\"id\", \"name\", \"meta\", \"photo\") VALUES (2, NULL, NULL, NULL);\n",
            export(ExportFormat.SQL, SqlDialect.POSTGRES),
        )
    }

    @Test
    fun profileJsonRoundTrips() {
        val p = ConnectionProfile(
            name = "N", driver = Driver.SQLITE, database = "/x/y.db", port = 0, color = 0xFFEF4444, readOnly = true,
            ssh = null, sslMode = SslMode.DISABLE,
        )
        assertEquals(p, ConnectionProfile.fromJson(p.toJson()))
        assertEquals(Driver.MYSQL, Driver.parse("mariadb"))
        assertEquals(Driver.POSTGRES, Driver.parse("PostgreSQL"))
        assertEquals(SslMode.VERIFY_CA, SslMode.parse("verify-full"))
    }

    @Test
    fun maxResultBufferWithoutJavaManagement() {
        val max = Runtime.getRuntime().maxMemory()
        assertEquals(-1, PGPropertyMaxResultBufferParser.parseProperty(null))
        assertEquals(10L shl 20, PGPropertyMaxResultBufferParser.parseProperty("10M"))
        assertEquals((0.1 * max).toLong(), PGPropertyMaxResultBufferParser.parseProperty("10percent"))
        assertEquals((0.9 * max).toLong(), PGPropertyMaxResultBufferParser.parseProperty("100p"))
        assertThrows(org.postgresql.util.PSQLException::class.java) { PGPropertyMaxResultBufferParser.parseProperty("lots") }
    }

    @Test
    fun readsMysqlGeometries() {
        fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        // SRID 0, little-endian POINT(1 2)
        assertEquals("POINT(1 2)", mysqlGeometryToWkt(hex("00000000" + "01" + "01000000" + "000000000000F03F" + "0000000000000040")))
        // SRID 4326, LINESTRING(0 0, 1.5 2)
        assertEquals(
            "SRID=4326;LINESTRING(0 0, 1.5 2)",
            mysqlGeometryToWkt(hex("E6100000" + "01" + "02000000" + "02000000" + "0000000000000000" + "0000000000000000" + "000000000000F83F" + "0000000000000040")),
        )
        // MULTIPOINT((3 4)) with a big-endian part
        assertEquals("MULTIPOINT((3 4))", mysqlGeometryToWkt(hex("00000000" + "01" + "04000000" + "01000000" + "00" + "00000001" + "4008000000000000" + "4010000000000000")))
        assertEquals(null, mysqlGeometryToWkt(hex("00010203")))
    }

    @Test
    fun formatsBytes() {
        assertEquals("512 B", formatBytes(512))
        assertEquals("1.5 KB", formatBytes(1536))
        assertEquals("304.0 KB", formatBytes(311296))
    }
}
