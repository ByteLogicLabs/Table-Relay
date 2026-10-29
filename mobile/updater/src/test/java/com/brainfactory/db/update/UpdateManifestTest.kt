package com.brainfactory.db.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestTest {
    private val manifestUrl = "https://app.brainfactory.id/semver/brain-db/version.rc"

    @Test
    fun readsTheDocumentedManifest() {
        // The version.rc draft from the API document, as app.brainfactory.id serves it.
        val update = parseUpdateManifest(
            """{
              "version": "1.0.0",
              "versionCode": 1000000,
              "url": "https://app.brainfactory.id/semver/brain-db/BrainDB-1.0.0.apk",
              "size": 0,
              "sha256": "",
              "notes": "- Rilis Resmi Brain DB 1.0.0\n- Editor foto dan desain grafis profesional untuk Android\n- Fitur login OTP email dan auto-update terproteksi",
              "released": "2026-10-21T08:00:00Z",
              "minSdk": 26
            }""",
            manifestUrl,
        )!!
        assertEquals("1.0.0", update.version)
        assertEquals(1000000L, update.versionCode)
        assertEquals("https://app.brainfactory.id/semver/brain-db/BrainDB-1.0.0.apk", update.apkUrl)
        assertEquals(0L, update.size)
        assertEquals("", update.sha256)
        assertTrue(update.notes.startsWith("- Rilis Resmi Brain DB 1.0.0\n"))
        assertEquals(update.apkUrl, update.pageUrl)
        // Installed 0.2.0 (versionCode 2000) sees it as newer; 1.0.0 itself doesn't.
        assertTrue(update.isNewerThan(2000, "0.2.0"))
        assertFalse(update.isNewerThan(1000000, "1.0.0"))
    }

    @Test
    fun readsAllFields() {
        val update = parseUpdateManifest(
            """{"version":"1.0.2","versionCode":1000002,"url":"https://cdn.example.com/BrainDB-1.0.2.apk",
               "size":42,"sha256":"ABCDEF","notes":"- Fixes","page":"https://www.brainfactory.id/photo"}""",
            manifestUrl,
        )!!
        assertEquals("1.0.2", update.version)
        assertEquals(1000002L, update.versionCode)
        assertEquals("https://cdn.example.com/BrainDB-1.0.2.apk", update.apkUrl)
        assertEquals(42L, update.size)
        assertEquals("abcdef", update.sha256)
        assertEquals("- Fixes", update.notes)
        assertEquals("https://www.brainfactory.id/photo", update.pageUrl)
    }

    @Test
    fun resolvesARelativeApkNextToTheManifest() {
        val update = parseUpdateManifest("""{"version":"v1.0.0","url":"BrainDB-1.0.0.apk"}""", manifestUrl)!!
        assertEquals("1.0.0", update.version)
        assertEquals("https://app.brainfactory.id/semver/brain-db/BrainDB-1.0.0.apk", update.apkUrl)
        assertEquals(update.apkUrl, update.pageUrl)
        assertEquals(0L, update.versionCode)
        assertEquals("", update.sha256)
    }

    @Test
    fun noApkMeansNoUpdate() {
        assertNull(parseUpdateManifest("""{"version":"1.0.0"}""", manifestUrl))
        assertNull(parseUpdateManifest("""{"url":"a.apk"}""", manifestUrl))
    }

    @Test
    fun comparesByVersionCodeWhenGiven() {
        val update = AppUpdate("1.0.0", 1000000, "u", 0, "", "", "u")
        assertTrue(update.isNewerThan(2000, "0.2.0"))
        assertFalse(update.isNewerThan(1000000, "1.0.0"))
        assertFalse(update.isNewerThan(1000001, "1.0.1"))
    }

    @Test
    fun comparesByNameWithoutVersionCode() {
        val update = AppUpdate("1.0.10", 0, "u", 0, "", "", "u")
        assertTrue(update.isNewerThan(1000009, "1.0.9"))
        assertFalse(update.isNewerThan(1000010, "1.0.10-debug"))
        assertTrue(compareVersions("0.10.0", "0.9.2") > 0)
        assertEquals(0, compareVersions("v1.0", "1.0.0"))
    }
}
