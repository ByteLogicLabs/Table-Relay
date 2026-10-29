package com.brainfactory.db.host

import android.os.Build
import android.os.Process
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.GZIPInputStream
import org.bouncycastle.openpgp.PGPPublicKeyRing
import org.bouncycastle.openpgp.PGPSignatureList
import org.bouncycastle.openpgp.PGPUtil
import org.bouncycastle.openpgp.bc.BcPGPObjectFactory
import org.bouncycastle.openpgp.operator.bc.BcKeyFingerprintCalculator
import org.bouncycastle.openpgp.operator.bc.BcPGPContentVerifierBuilderProvider

/**
 * An apt repository laid out as Termux's is (`dists/stable/main/binary-<arch>/`). Its index is trusted only as far as
 * apt trusts it: the Release file must carry a valid signature by one of [keys], the Packages index must match the
 * SHA-256 that Release lists for it, and each package must match the SHA-256 in the index.
 */
class AptRepository(val baseUrl: String, private val keys: PGPPublicKeyRing) {
    /** The packages built for [arch] ("aarch64", "x86_64", "arm", "i686"). */
    fun index(arch: String): Map<String, List<DebPackage>> {
        val release = download("$baseUrl/dists/stable/Release")
        val signature = download("$baseUrl/dists/stable/Release.gpg")
        if (!verifySignature(release, signature, keys)) throw HostException("The package repository's signature doesn't check out, so nothing was downloaded from it.")
        val path = "main/binary-$arch/Packages.gz"
        val expected = releaseHashes(String(release, Charsets.UTF_8))[path]
            ?: throw HostException("The package repository has no index for $arch.")
        val packages = download("$baseUrl/dists/stable/$path")
        if (sha256(packages) != expected) throw HostException("The package index doesn't match the repository's signed list.")
        return parsePackages(String(GZIPInputStream(packages.inputStream()).use { it.readBytes() }, Charsets.UTF_8))
    }

    fun url(pkg: DebPackage) = "$baseUrl/${pkg.filename}"

    companion object {
        /** Termux's main repository (Cloudflare first, its origin second), signed with the termux-autobuilds key. */
        val TERMUX_MIRRORS = listOf("https://packages-cf.termux.dev/apt/termux-main", "https://packages.termux.dev/apt/termux-main")

        /** Termux's package architecture for this process: the servers must match the app's own ABI. */
        val deviceArch: String
            get() {
                val abi = (if (Process.is64Bit()) Build.SUPPORTED_64_BIT_ABIS else Build.SUPPORTED_32_BIT_ABIS).firstOrNull() ?: Build.SUPPORTED_ABIS[0]
                return when {
                    abi.startsWith("arm64") -> "aarch64"
                    abi.startsWith("armeabi") -> "arm"
                    abi == "x86_64" -> "x86_64"
                    abi == "x86" -> "i686"
                    else -> throw HostException("Local servers aren't available for this phone's processor ($abi).")
                }
            }

        fun loadKeys(input: InputStream): PGPPublicKeyRing = input.use { PGPPublicKeyRing(PGPUtil.getDecoderStream(it), BcKeyFingerprintCalculator()) }
    }
}

/** Whether [signature] (a detached OpenPGP signature, binary or armoured) is a valid signature of [data] by [keys]. */
fun verifySignature(data: ByteArray, signature: ByteArray, keys: PGPPublicKeyRing): Boolean {
    val list = runCatching { BcPGPObjectFactory(PGPUtil.getDecoderStream(signature.inputStream())).nextObject() as? PGPSignatureList }.getOrNull() ?: return false
    return list.any { sig ->
        val key = keys.getPublicKey(sig.keyID) ?: return@any false
        if (key.hasRevocation()) return@any false
        runCatching {
            sig.init(BcPGPContentVerifierBuilderProvider(), key)
            sig.update(data)
            sig.verify()
        }.getOrDefault(false)
    }
}

/** A Release file's SHA256 section: path → hash. */
fun releaseHashes(release: String): Map<String, String> {
    val out = HashMap<String, String>()
    var inSha256 = false
    for (line in release.lines()) {
        if (line.isEmpty()) continue
        if (!line[0].isWhitespace()) {
            inSha256 = line.trimEnd() == "SHA256:"
            continue
        }
        if (!inSha256) continue
        val parts = line.trim().split(Regex("\\s+"))
        if (parts.size == 3) out[parts[2]] = parts[0].lowercase()
    }
    return out
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

internal fun openUrl(url: String): HttpURLConnection {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 20_000
    connection.readTimeout = 60_000
    connection.setRequestProperty("User-Agent", "BrainDB")
    if (connection.responseCode != 200) {
        val code = connection.responseCode
        connection.disconnect()
        throw IOException("$url answered HTTP $code")
    }
    return connection
}

private fun download(url: String): ByteArray {
    val connection = openUrl(url)
    try {
        return connection.inputStream.use { it.readBytes() }
    } finally {
        connection.disconnect()
    }
}
