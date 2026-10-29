package com.brainfactory.db.update

import java.net.URI
import org.json.JSONObject

/** A version offered by the version manifest (version.rc). */
data class AppUpdate(
    val version: String,
    /** 0 when the manifest doesn't give one; versions are then compared by name. */
    val versionCode: Long,
    val apkUrl: String,
    /** Bytes; 0 when unknown. */
    val size: Long,
    /** Lower-case hex SHA-256 of the APK; empty when the manifest doesn't give one. */
    val sha256: String,
    val notes: String,
    /** Where to download the APK by hand: the manifest's page, or else the APK itself. */
    val pageUrl: String,
)

/**
 * Reads the version manifest (version.rc), as the release workflow writes it:
 *
 * ```
 * { "version": "1.0.0", "versionCode": 1000000, "url": "https://…/BrainDB-1.0.0.apk",
 *   "size": 120456789, "sha256": "…", "notes": "…", "released": "2026-10-21T08:00:00Z", "page": "https://…" }
 * ```
 *
 * `url` and `page` may be relative to the manifest's own [manifestUrl]. Returns null when no APK is named.
 */
fun parseUpdateManifest(json: String, manifestUrl: String): AppUpdate? {
    val manifest = JSONObject(json)
    val version = manifest.optString("version").removePrefix("v").takeIf { it.isNotBlank() } ?: return null
    val url = manifest.optString("url").takeIf { it.isNotBlank() } ?: return null
    val base = URI(manifestUrl)
    val apkUrl = base.resolve(url).toString()
    return AppUpdate(
        version = version,
        versionCode = manifest.optLong("versionCode"),
        apkUrl = apkUrl,
        size = manifest.optLong("size"),
        sha256 = manifest.optString("sha256").lowercase(),
        notes = manifest.optString("notes"),
        pageUrl = manifest.optString("page").takeIf { it.isNotBlank() }?.let { base.resolve(it).toString() } ?: apkUrl,
    )
}

/** Whether this is newer than the installed version: by version code when the manifest has one, else by name. */
fun AppUpdate.isNewerThan(installedCode: Long, installedName: String): Boolean =
    if (versionCode > 0) versionCode > installedCode else compareVersions(version, installedName) > 0

/** Compares dotted versions numerically: 0.10.0 > 0.9.2; a "-debug" or similar suffix is ignored. */
fun compareVersions(a: String, b: String): Int {
    fun parts(v: String) = v.removePrefix("v").substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    val x = parts(a)
    val y = parts(b)
    for (i in 0 until maxOf(x.size, y.size)) {
        val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
        if (d != 0) return d
    }
    return 0
}
