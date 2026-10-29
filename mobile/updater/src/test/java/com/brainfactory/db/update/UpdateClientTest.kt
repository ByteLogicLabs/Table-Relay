package com.brainfactory.db.update

import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Runs [UpdateClient] against a local HTTP server standing in for the update endpoint: version.rc is public, the APK
 * needs a licence token, and refusals carry the error codes app.brainfactory.id sends.
 */
class UpdateClientTest {
    private val apk = ByteArray(3_000_000) { (it % 251).toByte() }
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private var manifest = ""
    private lateinit var server: ServerSocket
    private lateinit var base: String
    /** Headers of the last APK request, lower-case names. */
    private val apkHeaders = HashMap<String, String>()

    /** A minimal HTTP/1.0 server: answers GET for version.rc and the APK, 404 otherwise. */
    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        base = "http://127.0.0.1:${server.localPort}/semver/brain-db/"
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                socket.use {
                    val input = it.getInputStream().bufferedReader()
                    val path = input.readLine().orEmpty().split(' ').getOrElse(1) { "" }
                    val headers = HashMap<String, String>()
                    while (true) {
                        val header = input.readLine().orEmpty()
                        if (header.isEmpty()) break
                        headers[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
                    }
                    val out = it.getOutputStream()
                    fun reply(status: String, body: ByteArray) {
                        out.write("HTTP/1.0 $status\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray())
                        out.write(body)
                    }
                    when (path.substringAfterLast('/')) {
                        "version.rc" -> reply("200 OK", manifest.toByteArray())
                        "BrainDB-1.0.1.apk" -> {
                            synchronized(apkHeaders) { apkHeaders.clear(); apkHeaders.putAll(headers) }
                            when (headers["authorization"]) {
                                null -> reply("401 Unauthorized", """{"error":"unauthorized","message":"Akses ditolak."}""".toByteArray())
                                "Bearer good" -> reply("200 OK", apk)
                                "Bearer unpaid" -> reply("403 Forbidden", """{"error":"unlicensed","message":"Belum membeli."}""".toByteArray())
                                else -> reply("403 Forbidden", """{"error":"invalid_token","message":"Token tidak valid."}""".toByteArray())
                            }
                        }
                        else -> reply("404 Not Found", ByteArray(0))
                    }
                    out.flush()
                }
            }
        }
    }

    @After
    fun stop() = server.close()

    private fun client() = UpdateClient(base + "version.rc", "BrainDB/0.2.0")

    @Test
    fun fetchesTheManifestAndDownloadsTheApkWithTheToken() {
        manifest = """{"version":"1.0.1","versionCode":1000001,"url":"BrainDB-1.0.1.apk","size":${apk.size},"sha256":"$sha256"}"""
        val (update, json) = client().fetchManifest()
        assertEquals(manifest, json)
        assertEquals(base + "BrainDB-1.0.1.apk", update!!.apkUrl)

        val target = File.createTempFile("update", ".apk")
        var progress = 0f
        client().download(update, target, "good") { progress = it }
        assertArrayEquals(apk, target.readBytes())
        assertTrue(progress > 0f)
        assertEquals("Bearer good", apkHeaders["authorization"])
        assertEquals("BrainDB/0.2.0", apkHeaders["user-agent"])
        target.delete()
    }

    private fun refusal(token: String?): LicenceException {
        manifest = """{"version":"1.0.1","url":"BrainDB-1.0.1.apk"}"""
        val target = File.createTempFile("update", ".apk")
        try {
            client().download(client().fetchManifest().first!!, target, token) {}
            fail("expected a refusal")
            throw AssertionError()
        } catch (e: LicenceException) {
            assertFalse(target.exists())
            return e
        }
    }

    @Test
    fun withoutATokenTheUserSignsInAgain() {
        val e = refusal(null)
        assertEquals(401, e.status)
        assertEquals("unauthorized", e.code)
        assertTrue(needsSignIn(e.status, e.code))
    }

    @Test
    fun aWrongOrExpiredTokenSignsInAgain() {
        val e = refusal("expired")
        assertEquals(403, e.status)
        assertEquals("invalid_token", e.code)
        assertTrue(needsSignIn(e.status, e.code))
    }

    @Test
    fun anAccountThatHasNotBoughtBrainDBIsToldSo() {
        val e = refusal("unpaid")
        assertEquals(403, e.status)
        assertEquals("unlicensed", e.code)
        assertFalse(needsSignIn(e.status, e.code))
        assertEquals("This account hasn't bought Brain DB, so it can't download updates.", e.message)
    }

    @Test
    fun rejectsADownloadThatDoesNotMatchItsSha256() {
        manifest = """{"version":"1.0.1","url":"BrainDB-1.0.1.apk","sha256":"${"0".repeat(64)}"}"""
        val target = File.createTempFile("update", ".apk")
        try {
            client().download(client().fetchManifest().first!!, target, "good") {}
            fail("expected a checksum error")
        } catch (e: IOException) {
            assertFalse(target.exists())
        }
    }

    @Test
    fun rejectsADownloadOfTheWrongSize() {
        manifest = """{"version":"1.0.1","url":"BrainDB-1.0.1.apk","size":5}"""
        val target = File.createTempFile("update", ".apk")
        try {
            client().download(client().fetchManifest().first!!, target, "good") {}
            fail("expected a size error")
        } catch (e: IOException) {
            assertFalse(target.exists())
        }
    }

    @Test
    fun aMissingApkIsAnError() {
        manifest = """{"version":"1.0.2","url":"BrainDB-1.0.2.apk"}"""
        val target = File.createTempFile("update", ".apk")
        try {
            client().download(client().fetchManifest().first!!, target, "good") {}
            fail("expected an error")
        } catch (e: IOException) {
            assertFalse(e is LicenceException)
            assertFalse(target.exists())
        }
    }

    @Test
    fun aManifestWithoutAnApkOffersNothing() {
        manifest = """{"version":"1.0.1"}"""
        assertNull(client().fetchManifest().first)
    }

    @Test(expected = IOException::class)
    fun aMissingManifestIsAnError() {
        UpdateClient(base + "missing.rc", "test").fetchManifest()
    }
}
