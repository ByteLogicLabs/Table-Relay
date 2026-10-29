package com.brainfactory.db.data

import android.content.Context
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** One query run from the editor, remembered for History. */
data class HistoryEntry(val text: String, val database: String?, val time: Long, val ok: Boolean)

/** The last [LIMIT] queries run on each connection, newest first; the same text run again moves to the top. */
class QueryHistory(context: Context) {
    private val dir = File(context.filesDir, "history").apply { mkdirs() }

    private fun file(profileId: String) = File(dir, profileId.replace(Regex("[^A-Za-z0-9_-]"), "_") + ".json")

    @Synchronized
    fun list(profileId: String): List<HistoryEntry> = runCatching {
        val array = JSONArray(file(profileId).readText())
        (0 until array.length()).map { array.getJSONObject(it) }.map {
            HistoryEntry(it.getString("text"), it.optString("database").ifBlank { null }, it.getLong("time"), it.optBoolean("ok", true))
        }
    }.getOrDefault(emptyList())

    @Synchronized
    fun add(profileId: String, entry: HistoryEntry) {
        val list = (listOf(entry) + list(profileId).filter { it.text.trim() != entry.text.trim() }).take(LIMIT)
        file(profileId).writeText(JSONArray(list.map { JSONObject().put("text", it.text).put("database", it.database).put("time", it.time).put("ok", it.ok) }).toString())
    }

    @Synchronized
    fun clear(profileId: String) {
        file(profileId).delete()
    }

    companion object {
        const val LIMIT = 200
    }
}
