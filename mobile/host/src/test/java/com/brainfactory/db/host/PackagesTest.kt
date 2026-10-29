package com.brainfactory.db.host

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PackagesTest {
    private fun fixture(name: String) = File(javaClass.getResource("/fixtures/$name")!!.toURI())

    @Test
    fun debianVersionsCompareAsDpkgDoes() {
        fun less(a: String, b: String) {
            assertTrue("$a < $b", compareDebVersions(a, b) < 0)
            assertTrue("$b > $a", compareDebVersions(b, a) > 0)
        }
        assertEquals(0, compareDebVersions("1.0", "1.0"))
        assertEquals(0, compareDebVersions("0:1.0", "1.0"))
        assertEquals(0, compareDebVersions("1.01", "1.1"))
        less("1.0~rc1", "1.0")
        less("1.0", "1.0a")
        less("1.9", "1.10")
        less("8.9.9", "8.10.2")
        less("2.0", "1:1.0")
        less("1.0-1", "1.0-2")
        less("9.1.2-2", "9.1.2-10")
        less("1.0", "1.0+really1")
        less("6.6.20260307", "6.6.20260307+really6.5.20250830")
        less("13.0.2", "2:10.0")
    }

    @Test
    fun upstreamVersionDropsEpochAndRevision() {
        assertEquals("8.10.2", upstreamVersion("1:8.10.2"))
        assertEquals("9.1.2", upstreamVersion("9.1.2-2"))
        assertEquals("18.6", upstreamVersion("18.6"))
        assertEquals("2026.10.20", upstreamVersion("1:2026.10.20-1"))
    }

    private val index = """
        Package: postgresql
        Version: 18.6
        Depends: libicu, openssl (>= 3.0) | libressl, zlib
        Filename: pool/main/p/postgresql/postgresql_18.6_x86_64.deb
        Size: 6558960
        SHA256: 84A149A2D661FAFA0E26BC8917C03A71CFC441848B4FC915F315718313DCE22B
        Installed-Size: 30548
        Description: Object-relational SQL database
         with a second line

        Package: postgresql
        Version: 17.9
        Depends: libicu
        Filename: pool/main/p/postgresql/postgresql_17.9_x86_64.deb
        Size: 100
        SHA256: 00

        Package: libicu
        Version: 78.3
        Depends: libc++
        Filename: pool/main/libi/libicu/libicu_78.3_x86_64.deb
        Size: 10
        SHA256: 01

        Package: libc++
        Version: 30
        Filename: pool/main/libc/libc++/libc++_30_x86_64.deb
        Size: 10
        SHA256: 02

        Package: libressl
        Version: 4.0
        Filename: pool/main/libr/libressl/libressl_4.0_x86_64.deb
        Size: 10
        SHA256: 03

        Package: zlib
        Version: 1.3.2
        Depends: libc++
        Filename: pool/main/z/zlib/zlib_1.3.2_x86_64.deb
        Size: 10
        SHA256: 04

        Package: broken
        Version: 1.0
        Description: no Filename, so it can't be downloaded
    """.trimIndent()

    @Test
    fun parsesAnIndexNewestFirst() {
        val packages = parsePackages(index)
        assertEquals(listOf("18.6", "17.9"), packages.getValue("postgresql").map { it.version })
        val pg = packages.getValue("postgresql").first()
        assertEquals(listOf(listOf("libicu"), listOf("openssl", "libressl"), listOf("zlib")), pg.depends)
        assertEquals("84a149a2d661fafa0e26bc8917c03a71cfc441848b4fc915f315718313dce22b", pg.sha256)
        assertEquals(30548L * 1024, pg.installedSize)
        assertNull(packages["broken"])
    }

    @Test
    fun resolvesDependenciesOnce() {
        val packages = parsePackages(index)
        val closure = resolveDependencies(packages, packages.getValue("postgresql").first())
        assertEquals(listOf("postgresql", "libicu", "libressl", "zlib", "libc++"), closure.map { it.name })
        val missing = runCatching { resolveDependencies(packages, packages.getValue("postgresql").first().copy(depends = listOf(listOf("nope")))) }
        assertTrue(missing.exceptionOrNull()?.message.orEmpty().contains("nope"))
    }

    @Test
    fun checksTheReleaseSignature() {
        val release = fixture("Release").readBytes()
        val signature = fixture("Release.gpg").readBytes()
        val keys = File("src/main/assets/termux-autobuilds.gpg").inputStream().let(AptRepository::loadKeys)
        assertTrue(verifySignature(release, signature, keys))
        val tampered = release.copyOf().also { it[200] = (it[200] + 1).toByte() }
        assertFalse(verifySignature(tampered, signature, keys))
        assertFalse(verifySignature(release, "not a signature".toByteArray(), keys))
        val hashes = releaseHashes(String(release))
        assertEquals("faa9bc7b5be9b8d82520062c44d28b25c824c682b062e9af9357ab29bd9b0227", hashes["main/binary-x86_64/Packages.gz"])
        // The SHA256 section only, not the MD5Sum or SHA1 ones listing the same files
        assertEquals(64, hashes.getValue("main/binary-aarch64/Packages").length)
    }

    @Test
    fun readsADebsData() {
        val entries = mutableListOf<String>()
        var library = ByteArray(0)
        fixture("libandroid-glob_0.6-3_x86_64.deb").inputStream().buffered().use { input ->
            readDebData(input) { tar ->
                readTar(tar) { entry, data ->
                    entries += "${entry.type} ${entry.name}"
                    if (entry.name.endsWith("libandroid-glob.so")) library = data.readBytes()
                }
            }
        }
        assertTrue(entries.contains("0 ./data/data/com.termux/files/usr/lib/libandroid-glob.so"))
        assertTrue(entries.contains("5 ./data/data/com.termux/files/usr/include/"))
        assertEquals(10616, library.size)
        assertEquals(listOf(0x7f, 'E'.code, 'L'.code, 'F'.code), library.take(4).map { it.toInt() })
    }

    @Test
    fun mapsTermuxPaths() {
        assertEquals("bin/postgres", Installer.termuxPath("./data/data/com.termux/files/usr/bin/postgres"))
        assertEquals("", Installer.termuxPath("./data/data/com.termux/files/usr/"))
        assertNull(Installer.termuxPath("./data/data/com.termux/files/home/x"))
        assertEquals("libz.so.1.3.2", Installer.linkTarget("/data/data/com.termux/files/usr/lib/libz.so.1.3.2", "lib/libz.so"))
        assertEquals("../lib/x.so", Installer.linkTarget("/data/data/com.termux/files/usr/lib/x.so", "bin/x"))
        assertEquals("mariadbd", Installer.linkTarget("mariadbd", "bin/mysqld"))
        assertEquals("/system/bin/sh", Installer.linkTarget("/system/bin/sh", "bin/sh"))
        assertEquals("555".toInt(8), Installer.fileMode("700".toInt(8)))
        assertEquals("444".toInt(8), Installer.fileMode("600".toInt(8)))
    }

    @Test
    fun keepsOnlyWhatServersNeed() {
        assertTrue(Engine.POSTGRESQL.keeps("bin/initdb"))
        assertTrue(Engine.POSTGRESQL.keeps("share/postgresql/postgres.bki"))
        assertFalse(Engine.POSTGRESQL.keeps("include/postgresql/server/c.h"))
        assertFalse(Engine.POSTGRESQL.keeps("share/man/man1/psql.1.gz"))
        assertTrue(Engine.MARIADB.keeps("bin/mariadbd"))
        assertFalse(Engine.MARIADB.keeps("bin/mariadb-client-test"))
        assertTrue(Engine.MARIADB.keeps("lib/mysql/plugin/auth_ed25519.so"))
        assertTrue(Engine.REDIS.keeps("bin/redis-server"))
        assertFalse(Engine.REDIS.keeps("bin/redis-cli"))
        assertTrue(keepsLibrary("lib/ossl-modules/legacy.so"))
        assertFalse(keepsLibrary("lib/pkgconfig/zlib.pc"))
        assertFalse(keepsLibrary("share/terminfo/x/xterm"))
    }

    @Test
    fun serverPasswordsAndRecords() {
        assertNull(LocalServer.passwordProblem("it's a \\ \"test\""))
        assertEquals("A password can't contain line breaks.", LocalServer.passwordProblem("two\nlines"))
        val server = LocalServer(name = "pg", engine = Engine.POSTGRESQL, install = "postgresql-18.6", port = 5433, password = "x'y", lan = true)
        assertEquals(server, LocalServer.fromJson(server.toJson()))
        assertEquals("18.6", LocalHost.versionOf("postgresql-18.6"))
        assertEquals("valkey-9.1.2-2", installId(Engine.VALKEY, "9.1.2-2"))
        assertEquals("redis-8.10.2", installId(Engine.REDIS, "1:8.10.2"))
        // MySQL's PASSWORD('password'), as MariaDB's bootstrap gets it
        assertEquals("*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19", EngineRuntime.Mariadb.nativePasswordHash("password"))
    }
}
