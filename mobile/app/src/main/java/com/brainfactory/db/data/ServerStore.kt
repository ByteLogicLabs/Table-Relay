package com.brainfactory.db.data

import android.content.Context
import androidx.compose.runtime.mutableStateListOf
import com.brainfactory.db.host.LocalServer
import java.io.File
import org.json.JSONArray

/** The local servers set up on this phone (their passwords too, so the file is encrypted like the connections). */
class ServerStore private constructor(context: Context) {
    private val vault = Vault(File(context.filesDir, "servers.enc"), "braindb_servers")

    /** Oldest first; Compose observes changes. */
    val servers = mutableStateListOf<LocalServer>()

    init {
        servers.addAll(load())
    }

    fun get(id: String): LocalServer? = servers.firstOrNull { it.id == id }

    /** The server [profileId]'s connection was made for. */
    fun forProfile(profileId: String): LocalServer? = servers.firstOrNull { it.profileId == profileId }

    @Synchronized
    fun save(server: LocalServer) {
        val index = servers.indexOfFirst { it.id == server.id }
        persist(if (index < 0) servers + server else servers.toMutableList().also { it[index] = server })
    }

    @Synchronized
    fun delete(id: String) = persist(servers.filter { it.id != id })

    private fun persist(list: List<LocalServer>) {
        vault.write(JSONArray(list.map { it.toJson() }).toString())
        servers.clear()
        servers.addAll(list)
    }

    private fun load(): List<LocalServer> {
        if (!vault.exists()) return emptyList()
        return runCatching {
            val array = JSONArray(vault.read())
            (0 until array.length()).mapNotNull { LocalServer.fromJson(array.getJSONObject(it)) }
        }.getOrElse { emptyList() }
    }

    companion object {
        @Volatile private var instance: ServerStore? = null
        fun get(context: Context): ServerStore = instance ?: synchronized(this) { instance ?: ServerStore(context.applicationContext).also { instance = it } }
    }
}
