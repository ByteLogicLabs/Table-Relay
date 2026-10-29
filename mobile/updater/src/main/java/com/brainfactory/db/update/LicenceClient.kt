package com.brainfactory.db.update

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** The server refused a request; [message] is the server's own explanation, ready to show. */
class LicenceException(val status: Int, val code: String, message: String) : IOException(message)

/** A buyer's licence: the token that downloading updates needs, valid until [expiresAt] ("yyyy-MM-dd HH:mm:ss"). */
data class Licence(val token: String, val email: String, val expiresAt: String)

/**
 * Signing in for updates, against Brain Factory's licence API at [apiBase] (…/api/auth/otp): the buyer's email gets a
 * six-digit code (only when it has bought Brain DB), and the code buys a licence token. Plain JVM, so it's unit-tested.
 */
class LicenceClient(private val apiBase: String, private val userAgent: String) {

    /** Emails a code to [email]; returns the server's message. Throws [LicenceException] (e.g. "unlicensed") or IOException. */
    fun requestCode(email: String): String =
        post("request", JSONObject().put("email", email).put("app", APP)).optString("message")

    /** Trades [code] for the licence token. Throws [LicenceException] (e.g. "invalid_otp") or IOException. */
    fun verifyCode(email: String, code: String): Licence {
        val json = post("verify", JSONObject().put("email", email).put("otp", code))
        val token = json.optString("token").takeIf { it.isNotBlank() } ?: throw IOException("The server sent no licence token")
        return Licence(token, json.optString("email").ifBlank { email }, json.optString("expires_at"))
    }

    private fun post(path: String, body: JSONObject): JSONObject {
        val connection = (URL("$apiBase/$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", userAgent)
        }
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (status !in 200..299 || json == null || !json.optBoolean("success")) {
                throw LicenceException(
                    status,
                    json?.optString("error").orEmpty(),
                    json?.optString("message")?.takeIf { it.isNotBlank() } ?: "The server answered $status. Try again later.",
                )
            }
            return json
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        /** The app's id at the licence API. */
        const val APP = "brain-db"
    }
}
