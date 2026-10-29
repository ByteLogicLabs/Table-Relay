package com.brainfactory.db.host

import android.content.Context
import android.system.Os
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The phone's local servers: the engine versions installed and the servers running on them. There is one per app
 * process, and its work runs on its own scope, so a download or a start carries on when the screen that asked for it
 * closes. The servers are child processes of the app: they run while the app's process does (Brain DB keeps a
 * foreground service up meanwhile) and stop with it.
 */
class LocalHost private constructor(context: Context) {
    private val app = context.applicationContext
    private val root = File(app.filesDir, "host")
    private val installer = Installer(File(root, "engines").apply { mkdirs() }, File(app.cacheDir, "host"))
    private val launcher = Launcher(app.applicationInfo.nativeLibraryDir)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _installs = MutableStateFlow(emptyList<Installation>())
    /** The engine versions on the phone. */
    val installs: StateFlow<List<Installation>> = _installs

    private val _states = MutableStateFlow<Map<String, ServerState>>(emptyMap())
    /** Each server's state by id; a server missing from it is stopped. */
    val states: StateFlow<Map<String, ServerState>> = _states

    private class Running(val process: Process, val pid: Int?, val runtime: EngineRuntime) {
        @Volatile var ready = false
        @Volatile var stopping = false
    }

    private val running = ConcurrentHashMap<String, Running>()
    private val locks = ConcurrentHashMap<String, Mutex>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val installLock = Mutex()

    @Volatile private var releaseCache: Pair<Long, List<EngineRelease>>? = null
    @Volatile private var mirrors: List<AptRepository> = emptyList()

    init {
        _installs.value = installer.installed()
        scope.launch {
            installLock.withLock { installer.cleanUp() }
            stopOrphans()
        }
    }

    fun state(id: String): ServerState = _states.value[id] ?: ServerState.Stopped
    fun dirs(id: String) = ServerDirs(File(root, "servers/$id"))
    fun installation(id: String): Installation? = _installs.value.firstOrNull { it.id == id }
    fun log(id: String): File = dirs(id).log

    /** Bytes [id]'s files take up. */
    fun diskUsage(id: String): Long = dirs(id).root.walkBottomUp().filter { it.isFile }.sumOf { it.length() }

    /**
     * The versions the package repository offers for this phone, each with what it needs. The index is fetched and
     * its signature checked once every ten minutes at most, unless [refresh].
     */
    suspend fun releases(refresh: Boolean = false): List<EngineRelease> = withContext(Dispatchers.IO) {
        releaseCache?.takeIf { !refresh && System.currentTimeMillis() - it.first < 10 * 60_000 }?.let { return@withContext it.second }
        val keys = app.assets.open("termux-autobuilds.gpg").let(AptRepository::loadKeys)
        val arch = AptRepository.deviceArch
        val repositories = AptRepository.TERMUX_MIRRORS.map { AptRepository(it, keys) }
        var last: Exception? = null
        for (repository in repositories) {
            try {
                val index = repository.index(arch)
                val releases = Engine.entries.flatMap { engine ->
                    index[engine.pkg].orEmpty().map { EngineRelease(engine, it.version, resolveDependencies(index, it), arch) }
                }
                mirrors = listOf(repository) + repositories.filter { it !== repository }
                releaseCache = System.currentTimeMillis() to releases
                return@withContext releases
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                last = e
            }
        }
        throw last as? HostException ?: HostException("The package repository couldn't be reached: ${last?.message}", last)
    }

    /** Downloads and unpacks [release] (one install at a time); [progress] gets the bytes downloaded so far. */
    suspend fun install(release: EngineRelease, progress: (Long) -> Unit = {}): Installation = withContext(Dispatchers.IO) {
        installLock.withLock {
            val repositories = mirrors.ifEmpty { releases().let { mirrors } }
            installer.install(release, repositories, progress).also { _installs.value = installer.installed() }
        }
    }

    fun uninstall(installation: Installation) {
        installer.uninstall(installation)
        _installs.value = installer.installed()
    }

    /**
     * Installs [server]'s engine when it isn't yet (from [release]), sets the server up on its first start, and
     * starts it; the outcome shows in [states]. Does nothing while an earlier launch of it is still under way.
     */
    fun launch(server: LocalServer, release: EngineRelease? = null): Job {
        jobs[server.id]?.takeIf { it.isActive }?.let { return it }
        val job = scope.launch {
            try {
                if (installation(server.install) == null) {
                    val wanted = release ?: releases().firstOrNull { it.installId == server.install }
                        ?: throw HostException("${server.engine.label} ${versionOf(server.install)} isn't installed, and the package repository no longer offers it.")
                    set(server.id, ServerState.Installing(0, wanted.downloadSize))
                    // Progress in whole percents: enough for the screen and the notification, which a state per
                    // 64 kB read would flood.
                    var shown = -1L
                    install(wanted) { done ->
                        val percent = done * 100 / wanted.downloadSize.coerceAtLeast(1)
                        if (percent != shown) {
                            shown = percent
                            set(server.id, ServerState.Installing(done, wanted.downloadSize))
                        }
                    }
                }
                start(server)
            } catch (e: CancellationException) {
                if (state(server.id) is ServerState.Installing) set(server.id, ServerState.Stopped)
                throw e
            } catch (e: Exception) {
                set(server.id, ServerState.Failed(describe(e)))
            }
        }
        jobs[server.id] = job
        return job
    }

    /** Sets [server] up if this is its first start, starts it and waits until it accepts connections. */
    suspend fun start(server: LocalServer) = withContext(Dispatchers.IO) {
        lock(server.id).withLock {
            if (running[server.id]?.process?.isAlive == true) return@withLock
            val install = installation(server.install)
                ?: throw HostException("${server.engine.label} ${versionOf(server.install)} isn't installed on this phone.").also { set(server.id, ServerState.Failed(it.message!!)) }
            val runtime = EngineRuntime.of(server.engine)
            val dirs = dirs(server.id).apply { make() }
            val ctx = RunContext(server, install, dirs, launcher)
            try {
                rotate(dirs.log)
                if (!dirs.initialized.exists()) {
                    if (!runtime.looksInitialized(dirs)) {
                        set(server.id, ServerState.Starting("Setting up its data directory…"))
                        dirs.log.appendText("\n=== ${now()} Brain DB sets up ${server.engine.label} ${install.version}\n")
                        runInterruptible { runtime.initialize(ctx) }
                    }
                    dirs.initialized.writeText(install.id)
                }
                if (!portFree(server.port, server.lan)) throw HostException("Port ${server.port} is in use by another program. Choose another port in the server's settings.")
                set(server.id, ServerState.Starting("Starting…"))
                dirs.log.appendText("\n=== ${now()} Brain DB starts ${server.engine.label} ${install.version} on port ${server.port}\n")
                val process = runtime.start(ctx).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(dirs.log)).start()
                process.outputStream.close()
                val r = Running(process, pidOf(process), runtime)
                running[server.id] = r
                watch(server.id, server.engine, r)
                val deadline = System.currentTimeMillis() + START_TIMEOUT_MS
                while (!runtime.ready(server.port, dirs, r.pid)) {
                    if (!process.isAlive) throw HostException("${server.engine.label} stopped while starting (exit code ${process.exitValue()}).\n" + logTail(dirs.log))
                    if (System.currentTimeMillis() > deadline) throw HostException("${server.engine.label} didn't start within ${START_TIMEOUT_MS / 1000} seconds.\n" + logTail(dirs.log))
                    delay(250)
                }
                r.ready = true
                set(server.id, ServerState.Running(r.pid, System.currentTimeMillis()))
            } catch (e: Throwable) {
                running.remove(server.id)?.let {
                    it.stopping = true
                    it.process.destroyForcibly()
                }
                set(server.id, if (e is CancellationException) ServerState.Stopped else ServerState.Failed(describe(e)))
                throw e
            }
        }
    }

    fun stopAsync(id: String): Job = scope.launch { stop(id) }

    /** Asks the server to shut down cleanly; after 30 seconds it is killed. A launch under way is cancelled. */
    suspend fun stop(id: String) = withContext(Dispatchers.IO) {
        jobs[id]?.takeIf { it.isActive }?.cancelAndJoin()
        lock(id).withLock {
            val r = running[id]
            if (r == null) {
                if (state(id) !is ServerState.Failed) set(id, ServerState.Stopped)
                return@withLock
            }
            r.stopping = true
            set(id, ServerState.Stopping)
            val pid = r.pid
            if (pid != null) runCatching { Os.kill(pid, r.runtime.stopSignal) } else r.process.destroy()
            if (!r.process.waitFor(30, TimeUnit.SECONDS)) {
                r.process.destroyForcibly()
                r.process.waitFor(5, TimeUnit.SECONDS)
            }
            running.remove(id)
            set(id, ServerState.Stopped)
        }
    }

    suspend fun stopAll() {
        (running.keys + jobs.filterValues { it.isActive }.keys).distinct().map { scope.async { stop(it) } }.awaitAll()
    }

    /** Stops [id] and deletes its data. */
    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        stop(id)
        dirs(id).root.deleteRecursively()
        _states.update { it - id }
    }

    private fun watch(id: String, engine: Engine, r: Running) = thread(name = "brain-db-$id", isDaemon = true) {
        val code = runCatching { r.process.waitFor() }.getOrDefault(-1)
        running.remove(id, r)
        when {
            r.stopping -> Unit
            // A server that dies while starting is reported by start().
            r.ready -> set(id, ServerState.Failed("${engine.label} stopped unexpectedly (exit code $code).\n" + logTail(dirs(id).log)))
        }
    }

    private fun set(id: String, state: ServerState) = _states.update { it + (id to state) }
    private fun lock(id: String) = locks.getOrPut(id) { Mutex() }

    /** Stops servers an earlier run of the app left running (it should have taken them down with it). */
    private fun stopOrphans() {
        File(root, "servers").listFiles().orEmpty().forEach { dir ->
            val dirs = ServerDirs(dir)
            for (runtime in listOf(EngineRuntime.Postgres, EngineRuntime.Mariadb, EngineRuntime.RedisLike)) {
                val pid = runCatching { runtime.pidFile(dirs).readLines().first().trim().toInt() }.getOrNull() ?: continue
                val cmdline = runCatching { File("/proc/$pid/cmdline").readText() }.getOrNull() ?: continue
                if (dir.path in cmdline || dir.canonicalPath in cmdline) runCatching { Os.kill(pid, runtime.stopSignal) }
            }
        }
    }

    companion object {
        private const val START_TIMEOUT_MS = 90_000L

        @Volatile private var instance: LocalHost? = null
        fun get(context: Context): LocalHost = instance ?: synchronized(this) { instance ?: LocalHost(context).also { instance = it } }

        /** "postgresql-18.6" → "18.6". */
        fun versionOf(installId: String): String = installId.substringAfter('-')

        fun describe(e: Throwable): String = (e as? HostException)?.message ?: listOfNotNull(e.javaClass.simpleName, e.message).joinToString(": ")

        /** Android's Process.toString() gives "Process[pid=1234, hasExited=false]". */
        private fun pidOf(process: Process): Int? = Regex("pid=(\\d+)").find(process.toString())?.groupValues?.get(1)?.toIntOrNull()

        private fun portFree(port: Int, lan: Boolean): Boolean = runCatching {
            ServerSocket().use {
                it.reuseAddress = true
                it.bind(InetSocketAddress(if (lan) "0.0.0.0" else "127.0.0.1", port))
            }
        }.isSuccess

        /** Keeps a server's log from growing without end: past 1 MB it moves to server.log.1. */
        private fun rotate(log: File) {
            if (log.length() > 1_000_000) log.renameTo(File(log.path + ".1"))
        }

        private fun now() = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
    }
}
