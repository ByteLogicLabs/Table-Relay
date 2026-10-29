package com.brainfactory.db.host

import android.system.Os
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject

/** A version of an engine the repository offers: its package and everything that package needs. */
data class EngineRelease(val engine: Engine, val debVersion: String, val packages: List<DebPackage>, val arch: String) {
    val version: String get() = upstreamVersion(debVersion)
    val downloadSize: Long get() = packages.sumOf { it.size }
    /** The installation it becomes (see [Installation.id]). */
    val installId: String get() = installId(engine, debVersion)
}

/** An engine version unpacked under engines/<id>/, described by its install.json. */
data class Installation(
    val engine: Engine,
    val debVersion: String,
    val arch: String,
    /** "name version" of each package it was unpacked from. */
    val packages: List<String>,
    val bytes: Long,
    val installedAt: Long,
    val root: File,
) {
    /** "postgresql-18.6": the directory's name, and what a server records it runs on. */
    val id: String get() = root.name
    val version: String get() = upstreamVersion(debVersion)
    val lib: File get() = File(root, "lib")
    val major: Int get() = version.substringBefore('.').toIntOrNull() ?: 0

    internal fun toJson(): JSONObject = JSONObject().put("engine", engine.name).put("debVersion", debVersion).put("arch", arch)
        .put("packages", JSONArray(packages)).put("bytes", bytes).put("installedAt", installedAt)

    companion object {
        internal fun read(root: File): Installation? = runCatching {
            val json = JSONObject(File(root, INFO).readText())
            val packages = json.getJSONArray("packages")
            Installation(
                engine = Engine.parse(json.getString("engine"))!!,
                debVersion = json.getString("debVersion"),
                arch = json.getString("arch"),
                packages = (0 until packages.length()).map { packages.getString(it) },
                bytes = json.optLong("bytes"),
                installedAt = json.optLong("installedAt"),
                root = root,
            )
        }.getOrNull()

        internal const val INFO = "install.json"
    }
}

internal fun installId(engine: Engine, debVersion: String) = engine.pkg + "-" + debVersion.substringAfter(':').replace(Regex("[^A-Za-z0-9.+_-]"), "_")

/** Downloads, checks and unpacks engines into [enginesDir]; [cacheDir] holds the downloads until they're unpacked. */
internal class Installer(private val enginesDir: File, private val cacheDir: File) {
    fun installed(): List<Installation> = enginesDir.listFiles().orEmpty()
        .filter { it.isDirectory && !it.name.startsWith(".") }
        .mapNotNull { Installation.read(it) }
        .sortedWith(compareBy<Installation> { it.engine.ordinal }.thenComparator { a, b -> compareDebVersions(b.debVersion, a.debVersion) })

    /** Removes what an interrupted install left behind. */
    fun cleanUp() {
        enginesDir.listFiles().orEmpty().filter { it.name.startsWith(".") }.forEach { it.deleteRecursively() }
        File(cacheDir, "debs").deleteRecursively()
    }

    /**
     * Downloads [release]'s packages (from the first of [mirrors] that answers), checks each against the SHA-256 the
     * signed index gives, and unpacks what the server needs. [progress] gets the bytes downloaded so far.
     */
    suspend fun install(release: EngineRelease, mirrors: List<AptRepository>, progress: (Long) -> Unit): Installation {
        val target = File(enginesDir, release.installId)
        Installation.read(target)?.let { return it }
        val staging = File(enginesDir, ".${release.installId}.partial").apply { deleteRecursively(); mkdirs() }
        val downloads = File(cacheDir, "debs").apply { mkdirs() }
        try {
            var done = 0L
            val files = release.packages.map { pkg ->
                val file = File(downloads, pkg.filename.substringAfterLast('/'))
                fetch(pkg, mirrors, file) { done += it; progress(done) }
                file
            }
            var bytes = 0L
            release.packages.zip(files).forEach { (pkg, file) ->
                coroutineContext.ensureActive()
                bytes += unpack(file, staging, if (pkg.name == release.engine.pkg) release.engine::keeps else ::keepsLibrary)
                file.delete()
            }
            val program = File(staging, release.engine.program)
            if (!program.isFile) throw HostException("The ${release.engine.label} package has no ${release.engine.program}.")
            val installation = Installation(release.engine, release.debVersion, release.arch, release.packages.map { "${it.name} ${it.version}" }, bytes, System.currentTimeMillis(), target)
            File(staging, Installation.INFO).writeText(installation.toJson().toString(2))
            target.deleteRecursively()
            if (!staging.renameTo(target)) throw HostException("The installation couldn't be moved into place.")
            return installation
        } finally {
            staging.deleteRecursively()
            downloads.listFiles()?.forEach { it.delete() }
        }
    }

    fun uninstall(installation: Installation) {
        // Renamed first, so a half-deleted installation never looks like a whole one.
        val doomed = File(enginesDir, ".${installation.id}.deleting")
        if (installation.root.renameTo(doomed)) doomed.deleteRecursively() else installation.root.deleteRecursively()
    }

    private suspend fun fetch(pkg: DebPackage, mirrors: List<AptRepository>, file: File, progress: (Long) -> Unit) {
        var last: Exception? = null
        for (mirror in mirrors) {
            val part = File(file.path + ".part")
            var counted = 0L
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                val connection = openUrl(mirror.url(pkg))
                try {
                    connection.inputStream.use { input ->
                        part.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                coroutineContext.ensureActive()
                                val n = input.read(buffer)
                                if (n < 0) break
                                counted += n
                                if (counted > pkg.size) throw HostException("${pkg.name} is bigger than the repository's index says.")
                                digest.update(buffer, 0, n)
                                output.write(buffer, 0, n)
                                progress(n.toLong())
                            }
                        }
                    }
                } finally {
                    connection.disconnect()
                }
                if (counted != pkg.size || digest.digest().toHex() != pkg.sha256) {
                    throw HostException("${pkg.name} didn't arrive intact: it doesn't match the SHA-256 in the repository's signed index.")
                }
                if (!part.renameTo(file)) throw IOException("${file.name} couldn't be saved.")
                return
            } catch (e: IOException) {
                last = e
                progress(-counted)
                part.delete()
            } catch (e: Exception) {
                part.delete()
                throw e
            }
        }
        throw HostException("${pkg.name} couldn't be downloaded: ${last?.message}", last)
    }

    /** Unpacks the files of [deb] that [keep] wants into [root]; returns the bytes written. */
    private fun unpack(deb: File, root: File, keep: (String) -> Boolean): Long {
        var bytes = 0L
        val rootPath = root.canonicalPath
        deb.inputStream().buffered().use { input ->
            readDebData(input) { tar ->
                readTar(tar) { entry, data ->
                    val path = termuxPath(entry.name) ?: return@readTar
                    if (path.isEmpty() || !keep(path)) return@readTar
                    if (path.split('/').any { it == ".." || it == "." || it.isEmpty() }) throw HostException("A package holds an unsafe path (${entry.name}).")
                    val target = File(root, path)
                    // Never write outside the installation, also not through a symlink an earlier entry made.
                    safeDirs(target.parentFile!!, root, rootPath)
                    when (entry.type) {
                        '5' -> safeDirs(target, root, rootPath)
                        '2' -> {
                            target.delete()
                            Os.symlink(linkTarget(entry.linkName, path), target.path)
                        }
                        '1' -> {
                            val source = termuxPath(entry.linkName)?.let { File(root, it) }
                            if (source != null && source.isFile) {
                                target.delete()
                                source.copyTo(target)
                                Os.chmod(target.path, fileMode(entry.mode))
                                bytes += source.length()
                            }
                        }
                        '0', '\u0000', '7' -> {
                            target.delete()
                            target.outputStream().use { data.copyTo(it, 64 * 1024) }
                            Os.chmod(target.path, fileMode(entry.mode))
                            bytes += entry.size
                        }
                    }
                }
            }
        }
        return bytes
    }

    /** Makes [dir] and its parents up to [root], checking at each level that it still lies inside [root]. */
    private fun safeDirs(dir: File, root: File, rootPath: String) {
        if (dir == root) return
        safeDirs(dir.parentFile ?: throw HostException("A package holds an unsafe path."), root, rootPath)
        if (!dir.exists()) {
            dir.mkdir()
            Os.chmod(dir.path, DIR_MODE)
        }
        val canonical = dir.canonicalPath
        if (canonical != rootPath && !canonical.startsWith("$rootPath/")) throw HostException("A package holds an unsafe path (${dir.name}).")
    }

    companion object {
        /** Where Termux installs: packages hold paths like ./data/data/com.termux/files/usr/bin/postgres. */
        private const val TERMUX_PREFIX = "data/data/com.termux/files/usr/"
        private val DIR_MODE = "700".toInt(8)

        /** [name] relative to Termux's usr/, or null when it lies elsewhere. */
        fun termuxPath(name: String): String? {
            val n = name.removePrefix("./").removePrefix("/").trimEnd('/')
            return when {
                n == TERMUX_PREFIX.trimEnd('/') -> ""
                n.startsWith(TERMUX_PREFIX) -> n.removePrefix(TERMUX_PREFIX)
                else -> null
            }
        }

        /** A symlink's target: an absolute one into Termux's usr/ becomes relative to the link, the rest stay. */
        fun linkTarget(link: String, path: String): String {
            if (!link.startsWith("/")) return link
            val target = termuxPath(link) ?: return link
            val from = path.split('/').dropLast(1)
            val to = target.split('/')
            var common = 0
            while (common < from.size && common < to.size - 1 && from[common] == to[common]) common++
            return (List(from.size - common) { ".." } + to.drop(common)).joinToString("/").ifEmpty { "." }
        }

        /** Unpacked files are read-only: nothing rewrites a server's programs once they are installed. */
        fun fileMode(tarMode: Int): Int = if (tarMode and "111".toInt(8) != 0) "555".toInt(8) else "444".toInt(8)
    }
}
