package com.brainfactory.db.server

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import com.brainfactory.db.data.ProfileStore
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.engine.ConnectionProfile
import com.brainfactory.db.engine.DbException
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.SslMode
import com.brainfactory.db.host.Engine
import com.brainfactory.db.host.EngineRelease
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.LocalServer
import com.brainfactory.db.host.ServerState
import com.brainfactory.db.workspace.Workspaces
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Brain DB's side of the local servers (the :host module runs them): their saved records and the connections made for
 * them, the foreground service that keeps the app's process up while one runs, and starting one when its connection
 * is opened.
 */
object LocalServers {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watching = false

    /** A screen the next activity start should open (the notification opens the server list). */
    val pendingScreen = mutableStateOf<String?>(null)

    fun driverOf(engine: Engine): Driver = when (engine) {
        Engine.POSTGRESQL -> Driver.POSTGRES
        Engine.MARIADB -> Driver.MYSQL
        Engine.REDIS, Engine.VALKEY -> Driver.REDIS
    }

    /** The database a connection opens first: PostgreSQL's postgres, Redis's db 0, none for MariaDB. */
    fun defaultDatabase(engine: Engine) = when (engine) {
        Engine.POSTGRESQL -> "postgres"
        Engine.REDIS, Engine.VALKEY -> "0"
        Engine.MARIADB -> ""
    }

    /** A connection to [server] from the phone itself: 127.0.0.1, whatever else it listens on. */
    fun profileFor(server: LocalServer, id: String = server.profileId ?: UUID.randomUUID().toString()) = ConnectionProfile(
        id = id,
        name = server.name,
        driver = driverOf(server.engine),
        host = "127.0.0.1",
        port = server.port,
        user = server.engine.user.orEmpty(),
        password = server.password,
        database = defaultDatabase(server.engine),
        sslMode = SslMode.DISABLE,
    )

    /** A password for a new server: 16 letters and digits. */
    fun newPassword(): String {
        val chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val random = SecureRandom()
        return (1..16).map { chars[random.nextInt(chars.length)] }.joinToString("")
    }

    /** The engine's usual port, or the next one no other server uses. */
    fun freePort(context: Context, engine: Engine): Int {
        val used = ServerStore.get(context).servers.map { it.port }.toSet()
        return generateSequence(engine.defaultPort) { it + 1 }.first { it !in used }
    }

    /** Saves [server] (and a connection to it when [withConnection]) and starts it, installing [release] first if needed. */
    fun create(context: Context, server: LocalServer, release: EngineRelease?, withConnection: Boolean): LocalServer {
        val profile = if (withConnection) profileFor(server, UUID.randomUUID().toString()) else null
        val saved = server.copy(profileId = profile?.id)
        profile?.let { ProfileStore.get(context).save(it) }
        ServerStore.get(context).save(saved)
        start(context, saved, release)
        return saved
    }

    fun start(context: Context, server: LocalServer, release: EngineRelease? = null) {
        watch(context)
        LocalHost.get(context).launch(server, release)
    }

    /** Stops [server]; its open workspace closes, so opening the connection again starts the server again. */
    fun stop(context: Context, server: LocalServer) {
        server.profileId?.let { Workspaces.close(it) }
        LocalHost.get(context).stopAsync(server.id)
    }

    /**
     * Saves edits to [server] (name, port, network). Its connection follows the name and port; a running server
     * restarts with the new settings.
     */
    fun update(context: Context, server: LocalServer) {
        val store = ServerStore.get(context)
        val before = store.get(server.id)
        store.save(server)
        server.profileId?.let { id ->
            val profiles = ProfileStore.get(context)
            profiles.get(id)?.let { p ->
                val edited = p.copy(name = server.name, port = server.port)
                if (edited != p) {
                    Workspaces.close(id)
                    profiles.save(edited)
                }
            }
        }
        val host = LocalHost.get(context)
        if (before != null && (before.port != server.port || before.lan != server.lan) && host.state(server.id) is ServerState.Running) {
            scope.launch {
                host.stop(server.id)
                start(context, server)
            }
        }
    }

    /** Adds a connection for a server that has none (it was deleted, or never made). */
    fun addConnection(context: Context, server: LocalServer): ConnectionProfile {
        val profile = profileFor(server, UUID.randomUUID().toString())
        ProfileStore.get(context).save(profile)
        ServerStore.get(context).save(server.copy(profileId = profile.id))
        return profile
    }

    /** Stops [server] and deletes its data, and the connection made for it. */
    suspend fun delete(context: Context, server: LocalServer) {
        server.profileId?.let {
            Workspaces.close(it)
            ProfileStore.get(context).delete(it)
        }
        ServerStore.get(context).delete(server.id)
        LocalHost.get(context).delete(server.id)
    }

    /**
     * For a workspace about to connect: when the connection is a local server's, starts the server (if it isn't
     * running) and waits until it accepts connections.
     */
    suspend fun startFor(context: Context, profileId: String) {
        val server = ServerStore.get(context).forProfile(profileId) ?: return
        val host = LocalHost.get(context)
        if (host.state(server.id) is ServerState.Running) return
        watch(context)
        host.launch(server).join()
        (host.state(server.id) as? ServerState.Failed)?.let { throw DbException("${server.name} couldn't start: ${it.message}") }
    }

    /** Keeps [ServerService] in the foreground while any server is installing, starting, running or stopping. */
    fun watch(context: Context) {
        if (watching) return
        watching = true
        val app = context.applicationContext
        scope.launch {
            LocalHost.get(app).states.map { states -> states.values.any { it.active } }.distinctUntilChanged().collect { active ->
                if (active) ServerService.start(app)
            }
        }
    }

    /** The phone's addresses on local networks (Wi-Fi, Ethernet, its own hotspot), which other devices can reach. */
    fun lanAddresses(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { it.isSiteLocalAddress }
            .mapNotNull { it.hostAddress }
            .distinct()
    }.getOrDefault(emptyList())
}
