package com.brainfactory.db.update

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the licence on the device. The token is encrypted with a key in the Android Keystore, which never leaves it,
 * so a copy of the app's files is no use without the device.
 */
class LicenceStore(context: Context) {
    private val prefs = context.getSharedPreferences("licence", Context.MODE_PRIVATE)

    /** The saved licence, or null when there is none, it has expired or it can't be decrypted any more. */
    fun load(): Licence? {
        val email = prefs.getString(KEY_EMAIL, null) ?: return null
        val expiresAt = prefs.getString(KEY_EXPIRES, null).orEmpty()
        if (expired(expiresAt)) return null
        val token = runCatching { decrypt(prefs.getString(KEY_TOKEN, null) ?: return null) }.getOrNull() ?: return null
        return Licence(token, email, expiresAt)
    }

    fun save(licence: Licence) {
        prefs.edit()
            .putString(KEY_TOKEN, encrypt(licence.token))
            .putString(KEY_EMAIL, licence.email)
            .putString(KEY_EXPIRES, licence.expiresAt)
            .apply()
    }

    /** Forgets the licence but keeps the email, which the sign-in screen offers again. */
    fun clear() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_EXPIRES).apply()
    }

    /** The email last signed in with, or "". */
    fun lastEmail(): String = prefs.getString(KEY_EMAIL, null).orEmpty()

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    /** IV and ciphertext, base64, joined by a colon. */
    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(text.toByteArray())
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val (iv, data) = stored.split(':').map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        return String(cipher.doFinal(data))
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "braindb_licence"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_TOKEN = "token"
        private const val KEY_EMAIL = "email"
        private const val KEY_EXPIRES = "expiresAt"

        /** The server gives expiry times in Jakarta time; an unreadable one counts as not expired (the server decides). */
        fun expired(expiresAt: String, now: Long = System.currentTimeMillis()): Boolean {
            val format = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("Asia/Jakarta") }
            val time = runCatching { format.parse(expiresAt)?.time }.getOrNull() ?: return false
            return now >= time
        }
    }
}
