package com.brainfactory.db.engine

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * Connection exports in Table Relay's format, so connections move between the desktop app and the phone: a JSON
 * `{ "version": 1, "connections": [ … ] }`, encrypted with a password as RNCryptor v3 (desktop's `.dtab`):
 *
 *   byte 0 version (3) · byte 1 options (1, password) · 8-byte encryption salt · 8-byte HMAC salt · 16-byte IV ·
 *   AES-256-CBC ciphertext (PKCS#7) · HMAC-SHA256 of everything before it. Keys are PBKDF2-HMAC-SHA1, 10,000 rounds.
 */
object ConnectionTransfer {
    private const val HEADER = 1 + 1 + 8 + 8 + 16
    private const val HMAC_LEN = 32

    class BadPassword : Exception("Wrong password, or the file isn't a Table Relay / Brain DB export.")

    fun isEncrypted(data: ByteArray) = data.size >= HEADER + HMAC_LEN && data[0] == 3.toByte() && data[1] == 1.toByte()

    fun encrypt(plain: ByteArray, password: String): ByteArray {
        val random = SecureRandom()
        val encSalt = ByteArray(8).also(random::nextBytes)
        val hmacSalt = ByteArray(8).also(random::nextBytes)
        val iv = ByteArray(16).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(password, encSalt), "AES"), IvParameterSpec(iv)) }
        val body = byteArrayOf(3, 1) + encSalt + hmacSalt + iv + cipher.doFinal(plain)
        return body + hmac(key(password, hmacSalt), body)
    }

    fun decrypt(data: ByteArray, password: String): ByteArray {
        if (!isEncrypted(data)) throw BadPassword()
        val encSalt = data.copyOfRange(2, 10)
        val hmacSalt = data.copyOfRange(10, 18)
        val iv = data.copyOfRange(18, 34)
        val signed = data.copyOfRange(0, data.size - HMAC_LEN)
        val tag = data.copyOfRange(data.size - HMAC_LEN, data.size)
        if (!MessageDigest.isEqual(hmac(key(password, hmacSalt), signed), tag)) throw BadPassword()
        return try {
            Cipher.getInstance("AES/CBC/PKCS5Padding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(key(password, encSalt), "AES"), IvParameterSpec(iv)) }
                .doFinal(signed, HEADER, signed.size - HEADER)
        } catch (e: Exception) {
            throw BadPassword()
        }
    }

    private fun key(password: String, salt: ByteArray): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(PBEKeySpec(password.toCharArray(), salt, 10_000, 256)).encoded

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

    fun toJson(profiles: List<ConnectionProfile>): String =
        JSONObject().put("version", 1).put("connections", JSONArray(profiles.map { it.toJson() })).toString(2)

    /** The connections in an export's JSON (a bare array works too); entries with an unknown driver are skipped. */
    fun fromJson(text: String): List<ConnectionProfile> {
        val trimmed = text.trim()
        val array = if (trimmed.startsWith("[")) JSONArray(trimmed) else JSONObject(trimmed).optJSONArray("connections") ?: JSONArray()
        return (0 until array.length()).mapNotNull { i -> array.optJSONObject(i)?.let { ConnectionProfile.fromJson(it) } }
    }
}
