package com.brainfactory.db.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.brainfactory.db.ui.ThemeMode

/** Settings › everything, kept in SharedPreferences and readable as Compose state. */
class Settings private constructor(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var theme by mutableStateOf(runCatching { ThemeMode.valueOf(prefs.getString("theme", null)!!) }.getOrDefault(ThemeMode.SYSTEM))
        private set

    /** Rows per page in the data grid (the desktop's default row limit). */
    var pageSize by mutableIntStateOf(prefs.getInt("pageSize", 100))
        private set

    /** How NULL shows in the grid. */
    var nullText by mutableStateOf(prefs.getString("nullText", "NULL")!!)
        private set

    /** Ask before DELETE/UPDATE without WHERE, DROP, TRUNCATE and their Mongo and Redis kin. */
    var confirmDestructive by mutableStateOf(prefs.getBoolean("confirmDestructive", true))
        private set

    var editorFontSize by mutableIntStateOf(prefs.getInt("editorFontSize", 14))
        private set

    var gridFontSize by mutableIntStateOf(prefs.getInt("gridFontSize", 13))
        private set

    /** Rows a query result keeps at most. */
    var maxResultRows by mutableIntStateOf(prefs.getInt("maxResultRows", 5000))
        private set

    /** Shows the symbol keys ( ) , ; ' * = above the keyboard in the query editor. */
    var symbolBar by mutableStateOf(prefs.getBoolean("symbolBar", true))
        private set

    fun updateTheme(v: ThemeMode) { theme = v; prefs.edit().putString("theme", v.name).apply() }
    fun updatePageSize(v: Int) { pageSize = v; prefs.edit().putInt("pageSize", v).apply() }
    fun updateNullText(v: String) { nullText = v; prefs.edit().putString("nullText", v).apply() }
    fun updateConfirmDestructive(v: Boolean) { confirmDestructive = v; prefs.edit().putBoolean("confirmDestructive", v).apply() }
    fun updateEditorFontSize(v: Int) { editorFontSize = v; prefs.edit().putInt("editorFontSize", v).apply() }
    fun updateGridFontSize(v: Int) { gridFontSize = v; prefs.edit().putInt("gridFontSize", v).apply() }
    fun updateMaxResultRows(v: Int) { maxResultRows = v; prefs.edit().putInt("maxResultRows", v).apply() }
    fun updateSymbolBar(v: Boolean) { symbolBar = v; prefs.edit().putBoolean("symbolBar", v).apply() }

    companion object {
        val PAGE_SIZES = listOf(25, 50, 100, 200, 500, 1000)
        val NULL_TEXTS = listOf("NULL", "(null)", "∅", "")
        val RESULT_CAPS = listOf(1000, 5000, 20000, 50000)

        @Volatile private var instance: Settings? = null
        fun get(context: Context): Settings = instance ?: synchronized(this) { instance ?: Settings(context.applicationContext).also { instance = it } }
    }
}
