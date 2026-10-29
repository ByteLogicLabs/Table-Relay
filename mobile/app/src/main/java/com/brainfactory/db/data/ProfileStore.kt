package com.brainfactory.db.data

import android.content.Context
import androidx.compose.runtime.mutableStateListOf
import com.brainfactory.db.engine.ConnectionProfile
import java.io.File
import org.json.JSONArray

/**
 * The saved connections, passwords and SSH keys included. The file is encrypted with an AES key in the Android
 * Keystore, which never leaves the device (as Table Relay keeps its store encrypted at rest).
 */
class ProfileStore private constructor(context: Context) {
    private val vault = Vault(File(context.filesDir, "connections.enc"), "braindb_connections")

    /** The connections, favourites first, then by name; Compose observes changes. */
    val profiles = mutableStateListOf<ConnectionProfile>()

    init {
        profiles.addAll(sorted(load()))
    }

    private fun sorted(list: List<ConnectionProfile>) = list.sortedWith(compareByDescending<ConnectionProfile> { it.favorite }.thenBy { it.name.lowercase() })

    fun get(id: String): ConnectionProfile? = profiles.firstOrNull { it.id == id }

    @Synchronized
    fun save(profile: ConnectionProfile) {
        val list = profiles.filter { it.id != profile.id } + profile
        persist(list)
    }

    @Synchronized
    fun saveAll(added: List<ConnectionProfile>) {
        val ids = added.map { it.id }.toSet()
        persist(profiles.filter { it.id !in ids } + added)
    }

    @Synchronized
    fun delete(id: String) = persist(profiles.filter { it.id != id })

    private fun persist(list: List<ConnectionProfile>) {
        vault.write(JSONArray(list.map { it.toJson() }).toString())
        profiles.clear()
        profiles.addAll(sorted(list))
    }

    private fun load(): List<ConnectionProfile> {
        if (!vault.exists()) return emptyList()
        return runCatching {
            val array = JSONArray(vault.read())
            (0 until array.length()).mapNotNull { ConnectionProfile.fromJson(array.getJSONObject(it)) }
        }.getOrElse { emptyList() }
    }

    companion object {
        @Volatile private var instance: ProfileStore? = null
        fun get(context: Context): ProfileStore = instance ?: synchronized(this) { instance ?: ProfileStore(context.applicationContext).also { instance = it } }
    }
}
