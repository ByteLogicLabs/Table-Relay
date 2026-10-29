package com.brainfactory.db.host

import android.system.Os
import android.system.OsConstants
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Runs an installation's programs: through the system linker (see the shim in src/main/cpp), in a server's files. */
internal class Launcher(nativeLibraryDir: String) {
    private val linker = if (android.os.Process.is64Bit()) "/system/bin/linker64" else "/system/bin/linker"
    private val shim = File(nativeLibraryDir, "libbrainexec.so")

    fun command(install: Installation, program: String, args: List<String>, dirs: ServerDirs): ProcessBuilder {
        val builder = ProcessBuilder(listOf(linker, File(install.root, program).path) + args)
        builder.directory(dirs.root)
        val env = builder.environment()
        env["LD_LIBRARY_PATH"] = install.lib.path
        if (shim.isFile) {
            env["LD_PRELOAD"] = shim.path
            env["BRAINDB_EXEC_ROOT"] = install.root.canonicalPath
        }
        env["HOME"] = dirs.root.path
        env["TMPDIR"] = dirs.tmp.path
        env["TZ"] = TimeZone.getDefault().id
        env["LANG"] = "C.UTF-8"
        return builder
    }
}

/** What one server needs to set itself up and run. */
internal class RunContext(val server: LocalServer, val install: Installation, val dirs: ServerDirs, private val launcher: Launcher) {
    fun command(program: String, args: List<String>) = launcher.command(install, program, args, dirs)

    /** Runs [program] to its end with its output in the server's log; returns the exit code. */
    fun run(program: String, args: List<String>, stdin: ByteArray? = null, timeoutMinutes: Long = 10): Int {
        val process = command(program, args).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(dirs.log)).start()
        val writer = thread(name = "brain-db-stdin") {
            try {
                process.outputStream.use { out -> stdin?.let { out.write(it) } }
            } catch (_: IOException) {
                // The program stopped reading (it failed); its exit code and log tell why.
            }
        }
        try {
            if (!process.waitFor(timeoutMinutes, TimeUnit.MINUTES)) {
                process.destroyForcibly()
                throw HostException("${File(program).name} didn't finish within $timeoutMinutes minutes.")
            }
        } catch (e: InterruptedException) {
            // The launch was cancelled (the server stopped or deleted while it was being set up).
            process.destroyForcibly()
            throw e
        }
        writer.join(1000)
        return process.exitValue()
    }

    fun fail(what: String, code: Int): Nothing = throw HostException("$what failed (exit code $code).\n" + logTail(dirs.log))
}

/** How each engine sets up its data directory, starts, says it's ready, and is asked to stop. */
internal sealed class EngineRuntime {
    /** Sets up the data directory; whatever an earlier, failed attempt left there is replaced. */
    abstract fun initialize(ctx: RunContext)
    /** Whether the data directory was set up already (in case the marker saying so got lost: never set it up twice). */
    abstract fun looksInitialized(dirs: ServerDirs): Boolean
    abstract fun start(ctx: RunContext): ProcessBuilder
    /**
     * Whether the server (process [pid], on [port]) accepts connections. It is asked without logging in, since the
     * password may have been changed.
     */
    abstract fun ready(port: Int, dirs: ServerDirs, pid: Int?): Boolean
    /** The signal that shuts it down cleanly. */
    open val stopSignal: Int get() = OsConstants.SIGTERM
    /** Files it writes its process id to, for finding a server left running by an earlier run of the app. */
    abstract fun pidFile(dirs: ServerDirs): File

    companion object {
        fun of(engine: Engine): EngineRuntime = when (engine) {
            Engine.POSTGRESQL -> Postgres
            Engine.MARIADB -> Mariadb
            Engine.REDIS, Engine.VALKEY -> RedisLike
        }
    }

    object Postgres : EngineRuntime() {
        override fun initialize(ctx: RunContext) {
            val data = ctx.dirs.data
            data.deleteRecursively()
            val pwfile = File(ctx.dirs.tmp, "initdb.pw")
            pwfile.writeText(ctx.server.password + "\n")
            Os.chmod(pwfile.path, "600".toInt(8))
            try {
                // libc on Android knows only C and C.UTF-8; from 17 on, the builtin provider gives C.UTF-8 Unicode-aware
                // upper/lower and character classes without ICU.
                val locale = if (ctx.install.major >= 17) listOf("--locale-provider=builtin", "--locale=C.UTF-8", "--builtin-locale=C.UTF-8") else listOf("--no-locale")
                val code = ctx.run(
                    "bin/initdb",
                    listOf("-D", data.path, "-U", "postgres", "--pwfile=${pwfile.path}", "--auth=scram-sha-256", "--encoding=UTF8", "--no-instructions") + locale,
                )
                if (code != 0) ctx.fail("initdb", code)
            } finally {
                pwfile.delete()
            }
            File(data, "postgresql.conf").appendText(
                buildString {
                    appendLine()
                    appendLine("# Brain DB: sized for a phone (ALTER SYSTEM overrides these). The port and the addresses it")
                    appendLine("# listens on come from the server's settings in Brain DB.")
                    appendLine("shared_buffers = 32MB")
                    appendLine("max_connections = 30")
                    appendLine("max_worker_processes = 4")
                    appendLine("max_parallel_workers = 2")
                    appendLine("max_parallel_workers_per_gather = 1")
                    // Android limits how many child processes apps may keep; I/O workers would be three more.
                    if (ctx.install.major >= 18) appendLine("io_method = sync")
                },
            )
            // Every address with a password: what is reachable is decided by listen_addresses.
            File(data, "pg_hba.conf").appendText("\n# Brain DB\nhost    all             all             0.0.0.0/0               scram-sha-256\nhost    all             all             ::/0                    scram-sha-256\n")
        }

        override fun start(ctx: RunContext) = ctx.command(
            "bin/postgres",
            listOf(
                "-D", ctx.dirs.data.path, "-p", ctx.server.port.toString(),
                "-c", "listen_addresses=" + if (ctx.server.lan) "*" else "127.0.0.1",
                "-c", "unix_socket_directories=" + ctx.dirs.run.path,
            ),
        )

        /** Fast shutdown: open transactions roll back and clients are disconnected. */
        override val stopSignal: Int get() = OsConstants.SIGINT

        override fun looksInitialized(dirs: ServerDirs) = File(dirs.data, "PG_VERSION").exists()

        /**
         * postmaster.pid says so: its first line is the postmaster's process id and its eighth "ready" once it accepts
         * connections. Asking over the network instead would leave "the database system is starting up" in the log.
         */
        override fun ready(port: Int, dirs: ServerDirs, pid: Int?): Boolean {
            if (pid == null) return probePostgres(port)
            val lines = runCatching { pidFile(dirs).readLines() }.getOrNull() ?: return false
            return lines.firstOrNull()?.trim() == pid.toString() && lines.getOrNull(7)?.trim() == "ready"
        }
        override fun pidFile(dirs: ServerDirs) = File(dirs.data, "postmaster.pid")
    }

    object Mariadb : EngineRuntime() {
        private fun config(ctx: RunContext): File {
            val root = ctx.install.root.path
            val file = File(ctx.dirs.root, "my.cnf")
            file.writeText(
                buildString {
                    appendLine("# Written by Brain DB each time the server starts; its settings screen changes the port and network.")
                    appendLine("[mariadbd]")
                    appendLine("datadir=${ctx.dirs.data.path}")
                    appendLine("basedir=$root")
                    appendLine("plugin-dir=$root/lib/mysql/plugin")
                    appendLine("lc-messages-dir=$root/share/mariadb")
                    appendLine("character-sets-dir=$root/share/mariadb/charsets")
                    appendLine("tmpdir=${ctx.dirs.tmp.path}")
                    appendLine("socket=${ctx.dirs.run.path}/mysqld.sock")
                    appendLine("pid-file=${ctx.dirs.run.path}/mariadbd.pid")
                    appendLine("port=${ctx.server.port}")
                    appendLine("bind-address=" + if (ctx.server.lan) "0.0.0.0" else "127.0.0.1")
                    appendLine("skip-name-resolve")
                    appendLine("innodb-buffer-pool-size=64M")
                    appendLine("innodb-use-native-aio=0")
                    appendLine("max-connections=50")
                },
            )
            return file
        }

        override fun initialize(ctx: RunContext) {
            val data = ctx.dirs.data
            data.deleteRecursively()
            data.mkdirs()
            val share = File(ctx.install.root, "share/mariadb")
            // What mariadb-install-db (a shell script) feeds "mariadbd --bootstrap", with root logging in by password
            // (--auth-root-authentication-method=normal) and no hostname-specific accounts.
            val sql = buildString {
                appendLine("create database if not exists mysql;")
                appendLine("use mysql;")
                appendLine("SET @auth_root_socket=NULL;")
                for (name in listOf("mariadb_system_tables.sql", "mariadb_performance_tables.sql", "mariadb_system_tables_data.sql", "fill_help_tables.sql", "maria_add_gis_sp_bootstrap.sql", "mariadb_sys_schema.sql")) {
                    File(share, name).forEachLine { if ("@current_hostname" !in it) appendLine(it) }
                }
                // root logs in with the password, on the phone (localhost: the socket) and wherever the server
                // listens ('%'). Bootstrap mode has no privilege checks, and no account statements either (FLUSH
                // PRIVILEGES would turn the checks on for it), so the grant tables are written directly; the hash
                // is mysql_native_password's, which leaves nothing in the password to escape.
                appendLine("DELETE FROM mysql.global_priv WHERE User = 'root' AND Host <> 'localhost';")
                appendLine("DELETE FROM mysql.proxies_priv WHERE User = 'root';")
                appendLine("UPDATE mysql.global_priv SET Priv = JSON_SET(Priv, '$.plugin', 'mysql_native_password', '$.authentication_string', '${nativePasswordHash(ctx.server.password)}') WHERE User = 'root' AND Host = 'localhost';")
                appendLine("INSERT INTO mysql.global_priv SELECT '%', User, Priv FROM mysql.global_priv WHERE User = 'root' AND Host = 'localhost';")
                appendLine("INSERT INTO mysql.proxies_priv VALUES ('localhost', 'root', '', '', TRUE, '', NOW()), ('%', 'root', '', '', TRUE, '', NOW());")
            }
            val code = ctx.run(
                "bin/mariadbd",
                listOf("--defaults-file=${config(ctx).path}", "--bootstrap", "--log-warnings=0", "--enforce-storage-engine=", "--max_allowed_packet=8M", "--net_buffer_length=16K"),
                stdin = sql.toByteArray(),
            )
            if (code != 0) ctx.fail("Setting up MariaDB's system tables", code)
            File(data, "mariadb_upgrade_info").writeText("${ctx.install.version}-MariaDB")
        }

        override fun start(ctx: RunContext) = ctx.command("bin/mariadbd", listOf("--defaults-file=${config(ctx).path}"))

        /** MySQL's PASSWORD(): "*" and the hex of SHA-1(SHA-1(password)). */
        fun nativePasswordHash(password: String): String {
            val once = MessageDigest.getInstance("SHA-1").digest(password.toByteArray(Charsets.UTF_8))
            return "*" + MessageDigest.getInstance("SHA-1").digest(once).joinToString("") { "%02X".format(it) }
        }
        override fun looksInitialized(dirs: ServerDirs) = File(dirs.data, "mariadb_upgrade_info").exists()
        override fun ready(port: Int, dirs: ServerDirs, pid: Int?) = probeMysql(port)
        override fun pidFile(dirs: ServerDirs) = File(dirs.run, "mariadbd.pid")
    }

    /** Redis and Valkey: one program, one config file, nothing to set up. */
    object RedisLike : EngineRuntime() {
        override fun initialize(ctx: RunContext) {
            ctx.dirs.data.mkdirs()
        }

        override fun start(ctx: RunContext): ProcessBuilder {
            val file = File(ctx.dirs.root, "server.conf")
            file.writeText(
                buildString {
                    appendLine("# Written by Brain DB each time the server starts; its settings screen changes the port, network and password.")
                    appendLine("bind " + if (ctx.server.lan) "* -::*" else "127.0.0.1 -::1")
                    appendLine("port ${ctx.server.port}")
                    appendLine("protected-mode yes")
                    appendLine("requirepass ${configString(ctx.server.password)}")
                    appendLine("dir ${configString(ctx.dirs.data.path)}")
                    appendLine("dbfilename dump.rdb")
                    appendLine("save 3600 1 300 100 60 10000")
                    appendLine("appendonly no")
                    appendLine("daemonize no")
                    appendLine("pidfile ${configString(File(ctx.dirs.run, "server.pid").path)}")
                    appendLine("logfile \"\"")
                    appendLine("always-show-logo no")
                    appendLine("set-proc-title no")
                },
            )
            return ctx.command(ctx.install.engine.program, listOf(file.path))
        }

        override fun looksInitialized(dirs: ServerDirs) = dirs.data.isDirectory
        override fun ready(port: Int, dirs: ServerDirs, pid: Int?) = probeRedis(port)
        override fun pidFile(dirs: ServerDirs) = File(dirs.run, "server.pid")

        /** A double-quoted string as Redis's config parser reads it. */
        private fun configString(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }
}

/** The last lines of [log], for an error message. */
internal fun logTail(log: File, lines: Int = 12): String = runCatching {
    log.readLines().takeLast(lines).joinToString("\n")
}.getOrDefault("")

private fun connect(port: Int): Socket = Socket().apply {
    connect(InetSocketAddress("127.0.0.1", port), 1000)
    soTimeout = 3000
}

/**
 * Sends PostgreSQL's startup message and reads the reply: an authentication request means it accepts connections, and
 * so does any error but 57P03 (starting up, shutting down, recovering). The whole reply is read before hanging up, so
 * the server sees a plain end of connection, which it doesn't log, rather than a reset.
 */
internal fun probePostgres(port: Int): Boolean = runCatching {
    connect(port).use { socket ->
        val params = "user\u0000postgres\u0000database\u0000postgres\u0000\u0000".toByteArray()
        DataOutputStream(socket.getOutputStream()).apply {
            writeInt(8 + params.size)
            writeInt(196608) // protocol 3.0
            write(params)
            flush()
        }
        val input = DataInputStream(socket.getInputStream())
        val type = input.readUnsignedByte().toChar()
        val body = ByteArray(input.readInt() - 4).also { input.readFully(it) }
        when (type) {
            'R' -> true
            'E' -> String(body, Charsets.UTF_8).split('\u0000').firstOrNull { it.startsWith("C") }?.drop(1).let { it != null && it != "57P03" }
            else -> false
        }
    }
}.getOrDefault(false)

/** MariaDB opens its port once it's ready; any packet it greets with (handshake or error) means it's up. */
internal fun probeMysql(port: Int): Boolean = runCatching {
    connect(port).use { socket ->
        val input = DataInputStream(socket.getInputStream())
        val header = ByteArray(4).also { input.readFully(it) }
        val length = (header[0].toInt() and 0xff) or ((header[1].toInt() and 0xff) shl 8) or ((header[2].toInt() and 0xff) shl 16)
        val packet = ByteArray(length).also { input.readFully(it) }
        length > 0 && (packet[0].toInt() and 0xff).let { it == 10 || it == 0xff }
    }
}.getOrDefault(false)

/** PING: PONG, or NOAUTH since it wants a password, means it's up; LOADING means it's still reading its data. */
internal fun probeRedis(port: Int): Boolean = runCatching {
    connect(port).use { socket ->
        socket.getOutputStream().apply {
            write("PING\r\n".toByteArray())
            flush()
        }
        val line = socket.getInputStream().bufferedReader().readLine().orEmpty()
        line.startsWith("+PONG") || line.startsWith("-NOAUTH") || (line.startsWith("-") && !line.startsWith("-LOADING"))
    }
}.getOrDefault(false)
