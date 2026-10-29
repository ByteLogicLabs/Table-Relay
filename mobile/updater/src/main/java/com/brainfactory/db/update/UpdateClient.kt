package com.brainfactory.db.update

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject

/** The network side of updating: fetching the version manifest (version.rc) and downloading the APK it names. Plain JVM, so it's unit-tested. */
class UpdateClient(private val manifestUrl: String, private val userAgent: String) {

    /** The update the manifest offers (newer or not), or null when it names none. */
    fun fetchManifest(): Pair<AppUpdate?, String> {
        val connection = open(manifestUrl)
        try {
            if (connection.responseCode != 200) throw IOException("Update server answered ${connection.responseCode}")
            val json = connection.inputStream.bufferedReader().use { it.readText() }
            return parseUpdateManifest(json, manifestUrl) to json
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Downloads [update]'s APK to [target] with the licence [token], reporting progress from 0 to 1. Throws, leaving
     * no file behind, when the download's size or SHA-256 doesn't match the manifest, or [LicenceException] when the
     * server wants a (new) licence or the account hasn't bought the app (401 / 403; [LicenceException.code] tells which).
     */
    fun download(update: AppUpdate, target: File, token: String?, onProgress: (Float) -> Unit) {
        val connection = open(update.apkUrl)
        if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
        try {
            when (val status = connection.responseCode) {
                200 -> Unit
                401, 403 -> throw refusal(connection, status)
                else -> throw IOException("Download answered $status")
            }
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: update.size
            val digest = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var lastReport = 0L
            connection.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        digest.update(buffer, 0, n)
                        done += n
                        if (total > 0 && done - lastReport > 1_000_000) {
                            lastReport = done
                            onProgress(done.toFloat() / total)
                        }
                    }
                }
            }
            if (update.size > 0 && done != update.size) throw IOException("Downloaded $done bytes, expected ${update.size}")
            val sum = digest.digest().joinToString("") { "%02x".format(it) }
            if (update.sha256.isNotEmpty() && sum != update.sha256) throw IOException("The download doesn't match its SHA-256")
        } catch (e: Exception) {
            target.delete()
            throw e
        } finally {
            connection.disconnect()
        }
    }

    /**
     * The server's reason for refusing the download, from its JSON error ("unauthorized": no token, "invalid_token":
     * a wrong or expired one, "unlicensed": the account hasn't bought Brain DB).
     */
    private fun refusal(connection: HttpURLConnection, status: Int): LicenceException {
        val code = runCatching { JSONObject(connection.errorStream.bufferedReader().use { it.readText() }).optString("error") }
            .getOrNull().orEmpty().ifBlank { if (status == 401) "unauthorized" else "unlicensed" }
        return if (needsSignIn(status, code)) LicenceException(status, code, "Sign in again to download updates.")
        else LicenceException(status, code, "This account hasn't bought Brain DB, so it can't download updates.")
    }

    private fun open(url: String) = (URL(url).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = true
        connectTimeout = 15_000
        readTimeout = 30_000
        useCaches = false
        setRequestProperty("User-Agent", userAgent)
    }
}

/** Whether a refused download wants the user to sign in again (no, a wrong or an expired token) rather than to buy the app. */
fun needsSignIn(status: Int, code: String): Boolean = status == 401 || code == "invalid_token" || code == "unauthorized"
