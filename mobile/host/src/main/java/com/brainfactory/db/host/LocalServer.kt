package com.brainfactory.db.host

import java.io.File
import java.util.UUID
import org.json.JSONObject

/** A database server the user set up on the phone. Its files are under servers/<id>/ (see [ServerDirs]). */
data class LocalServer(
    val id: String = UUID.randomUUID().toString().replace("-", "").take(12),
    val name: String,
    val engine: Engine,
    /** The installation it runs ([Installation.id]); a server keeps its version, since its data is tied to it. */
    val install: String,
    val port: Int,
    /** The superuser's password (postgres, root), or Redis's and Valkey's requirepass. */
    val password: String,
    /** Listens on every network the phone is on (other devices can connect), not only on the phone itself. */
    val lan: Boolean = false,
    /** The saved connection made for it, when there is one. */
    val profileId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("engine", engine.name).put("install", install)
        .put("port", port).put("password", password).put("lan", lan).put("profileId", profileId).put("createdAt", createdAt)

    companion object {
        fun fromJson(json: JSONObject): LocalServer? {
            val engine = Engine.parse(json.optString("engine")) ?: return null
            return LocalServer(
                id = json.optString("id").ifBlank { return null },
                name = json.optString("name"),
                engine = engine,
                install = json.optString("install"),
                port = json.optInt("port", engine.defaultPort),
                password = json.optString("password"),
                lan = json.optBoolean("lan"),
                profileId = json.optString("profileId").takeIf { it.isNotBlank() && it != "null" },
                createdAt = json.optLong("createdAt"),
            )
        }

        /** What a password may hold: the servers read it from config files and SQL, so no line breaks or NULs. */
        fun passwordProblem(password: String): String? = when {
            password.length < 4 -> "Use at least 4 characters."
            password.any { it == '\n' || it == '\r' || it == '\u0000' } -> "A password can't contain line breaks."
            password.length > 100 -> "Use at most 100 characters."
            else -> null
        }
    }
}

/** A server's files. */
class ServerDirs(val root: File) {
    val data = File(root, "data")
    val run = File(root, "run")
    val tmp = File(root, "tmp")
    val log = File(root, "server.log")
    /** Written once the data directory is set up; names the installation that set it up. */
    internal val initialized = File(root, ".initialized")

    internal fun make() {
        listOf(root, run, tmp).forEach { it.mkdirs() }
    }
}

/** Where a server is in its life. */
sealed interface ServerState {
    data object Stopped : ServerState
    data class Installing(val done: Long, val total: Long) : ServerState
    data class Starting(val step: String) : ServerState
    data class Running(val pid: Int?, val since: Long) : ServerState
    data object Stopping : ServerState
    data class Failed(val message: String) : ServerState

    /** Whether the server's process is (or is about to be) running, which keeps Brain DB's service in the foreground. */
    val active: Boolean get() = this is Installing || this is Starting || this is Running || this is Stopping
}
