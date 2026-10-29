package com.brainfactory.db.update

import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Runs [LicenceClient] against a local stand-in for the licence API, answering as the real one documents. */
class LicenceClientTest {
    private class Request(val method: String, val path: String, val headers: Map<String, String>, val body: JSONObject)

    private lateinit var server: ServerSocket
    private lateinit var client: LicenceClient
    private val requests = mutableListOf<Request>()

    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        client = LicenceClient("http://127.0.0.1:${server.localPort}/api/auth/otp", "BrainDB/1.2.3")
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                socket.use {
                    val input = it.getInputStream().bufferedReader()
                    val line = input.readLine().orEmpty().split(' ')
                    val headers = HashMap<String, String>()
                    while (true) {
                        val header = input.readLine().orEmpty()
                        if (header.isEmpty()) break
                        headers[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
                    }
                    val length = headers["content-length"]?.toInt() ?: 0
                    val body = JSONObject(String(CharArray(length).also { buffer -> input.read(buffer) }))
                    val request = Request(line.getOrElse(0) { "" }, line.getOrElse(1) { "" }, headers, body)
                    synchronized(requests) { requests += request }
                    val (status, answer) = answer(request.path, body)
                    val bytes = answer.toByteArray()
                    it.getOutputStream().apply {
                        write("HTTP/1.0 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\n\r\n".toByteArray())
                        write(bytes)
                        flush()
                    }
                }
            }
        }
    }

    /** The answers documented for app.brainfactory.id (and seen from it). */
    private fun answer(path: String, body: JSONObject): Pair<Int, String> = when {
        path.endsWith("/request") && body.getString("email") == "pembeli@example.com" ->
            200 to """{"success":true,"message":"Kode OTP berhasil dikirim ke pembeli@example.com. Berlaku selama 15 menit.","expires_in":900}"""
        path.endsWith("/request") ->
            403 to """{"success":false,"error":"unlicensed","message":"Email ini belum memiliki lisensi pembelian aplikasi di Brain Factory."}"""
        path.endsWith("/verify") && body.getString("otp") == "123456" ->
            200 to """{"success":true,"message":"Login berhasil. Lisensi aktif.","token":"abc123","token_type":"Bearer","expires_at":"2026-11-20 16:15:00","email":"pembeli@example.com"}"""
        else -> 401 to """{"success":false,"error":"invalid_otp","message":"Kode OTP salah. Sisa percobaan: 3"}"""
    }

    @After
    fun stop() = server.close()

    @Test
    fun requestsACodeForBrainDB() {
        assertEquals("Kode OTP berhasil dikirim ke pembeli@example.com. Berlaku selama 15 menit.", client.requestCode("pembeli@example.com"))
        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/otp/request", request.path)
        assertEquals("application/json", request.headers["content-type"])
        assertEquals("BrainDB/1.2.3", request.headers["user-agent"])
        assertEquals("pembeli@example.com", request.body.getString("email"))
        assertEquals("brain-db", request.body.getString("app"))
    }

    @Test
    fun anUnlicensedEmailGetsTheServersReason() {
        try {
            client.requestCode("someone@example.com")
            fail("expected a refusal")
        } catch (e: LicenceException) {
            assertEquals(403, e.status)
            assertEquals("unlicensed", e.code)
            assertEquals("Email ini belum memiliki lisensi pembelian aplikasi di Brain Factory.", e.message)
        }
    }

    @Test
    fun theRightCodeGivesALicence() {
        val licence = client.verifyCode("pembeli@example.com", "123456")
        assertEquals(Licence("abc123", "pembeli@example.com", "2026-11-20 16:15:00"), licence)
        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/otp/verify", request.path)
        assertEquals("application/json", request.headers["content-type"])
        assertEquals("pembeli@example.com", request.body.getString("email"))
        assertEquals("123456", request.body.getString("otp"))
    }

    @Test
    fun aWrongCodeIsRefused() {
        try {
            client.verifyCode("pembeli@example.com", "000000")
            fail("expected a refusal")
        } catch (e: LicenceException) {
            assertEquals(401, e.status)
            assertEquals("invalid_otp", e.code)
            assertEquals("Kode OTP salah. Sisa percobaan: 3", e.message)
        }
    }

    @Test
    fun expiryIsReadInJakartaTime() {
        // 2026-11-20 16:15:00 in Jakarta (UTC+7) is 09:15:00 UTC.
        val expiry = java.time.Instant.parse("2026-11-20T09:15:00Z").toEpochMilli()
        assertFalse(LicenceStore.expired("2026-11-20 16:15:00", expiry - 1000))
        assertTrue(LicenceStore.expired("2026-11-20 16:15:00", expiry))
        assertFalse(LicenceStore.expired("not a date", expiry))
    }
}
