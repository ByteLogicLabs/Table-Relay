package com.brainfactory.db.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.brainfactory.db.data.HistoryEntry
import com.brainfactory.db.engine.DestructiveStatement
import com.brainfactory.db.engine.QueryLanguage
import com.brainfactory.db.engine.StatementResult
import com.brainfactory.db.engine.analyzeDestructive
import com.brainfactory.db.engine.analyzeMongoDestructive
import com.brainfactory.db.engine.analyzeRedisDestructive
import com.brainfactory.db.engine.pageableFind
import com.brainfactory.db.engine.pageableSelect
import com.brainfactory.db.engine.pagedFind
import com.brainfactory.db.engine.pagedSql
import com.brainfactory.db.engine.splitShell
import com.brainfactory.db.engine.statementAt
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A query tab: the editor's text, the run, and each statement's result. */
class QueryState(private val ws: Workspace, initial: String) {
    var text by mutableStateOf(TextFieldValue(initial, TextRange(initial.length)))
    var results by mutableStateOf<List<StatementResult>>(emptyList())
        private set
    var selectedResult by mutableIntStateOf(0)
    var running by mutableStateOf(false)
        private set
    /** Milliseconds the running query has taken so far. */
    var elapsed by mutableLongStateOf(0)
        private set
    /** Statements that need a confirmation before they run (Settings › confirm destructive queries). */
    var pendingDestructive by mutableStateOf<List<DestructiveStatement>?>(null)
        private set
    private var pendingText: String? = null
    private var job: Job? = null

    /**
     * Auto-paging (Table Relay's query editor does it too): a single SELECT without a LIMIT of its own, or a Mongo
     * find() without .limit(), runs [pageSize] rows at a time. [pagedStatement] is what is being paged (null when
     * the last run wasn't pageable), [page] the page shown (0-based), [hasNextPage] whether another page follows.
     * A [pageSize] of 0 runs the statement whole.
     */
    var pagedStatement by mutableStateOf<String?>(null)
        private set
    var page by mutableIntStateOf(0)
        private set
    var pageSize by mutableIntStateOf(ws.pageSize)
        private set
    var hasNextPage by mutableStateOf(false)
        private set

    val language: QueryLanguage get() = ws.profile.driver.language

    fun setText(value: String) {
        text = TextFieldValue(value, TextRange(value.length))
    }

    /** What Run runs: the selection when there is one, else everything. */
    fun textToRun(currentOnly: Boolean): String {
        val t = text
        if (!t.selection.collapsed) return t.text.substring(t.selection.min, t.selection.max)
        if (!currentOnly) return t.text
        val cursor = t.selection.start
        return when (language) {
            QueryLanguage.SQL -> statementAt(t.text, cursor, ws.profile.driver.dialect)?.text ?: t.text
            QueryLanguage.REDIS -> {
                val start = t.text.lastIndexOf('\n', (cursor - 1).coerceAtLeast(0)).let { if (it < 0 || cursor == 0) 0 else it + 1 }
                val end = t.text.indexOf('\n', cursor).let { if (it < 0) t.text.length else it }
                t.text.substring(start.coerceAtMost(end), end).ifBlank { t.text }
            }
            QueryLanguage.MONGO -> {
                // The command whose text spans the cursor; commands are found in order in the editor's text.
                var from = 0
                splitShell(t.text).firstOrNull { cmd ->
                    val at = t.text.indexOf(cmd.lines().first().trim(), from)
                    if (at < 0) return@firstOrNull false
                    from = at + 1
                    cursor <= at + cmd.length + 1
                } ?: t.text
            }
        }
    }

    fun run(currentOnly: Boolean, confirm: Boolean) {
        if (running) return
        val toRun = textToRun(currentOnly)
        if (toRun.isBlank()) return
        if (confirm) {
            val risky = when (language) {
                QueryLanguage.SQL -> analyzeDestructive(toRun, ws.profile.driver.dialect)
                QueryLanguage.MONGO -> analyzeMongoDestructive(toRun)
                QueryLanguage.REDIS -> analyzeRedisDestructive(toRun)
            }
            if (risky.isNotEmpty()) {
                pendingText = toRun
                pendingDestructive = risky
                return
            }
        }
        execute(toRun)
    }

    fun confirmPending() {
        val t = pendingText
        pendingDestructive = null
        pendingText = null
        if (t != null) execute(t)
    }

    fun dismissPending() {
        pendingDestructive = null
        pendingText = null
    }

    private fun pageable(toRun: String): String? = when (language) {
        QueryLanguage.SQL -> pageableSelect(toRun, ws.profile.driver.dialect)
        QueryLanguage.MONGO -> pageableFind(toRun)
        QueryLanguage.REDIS -> null
    }

    private fun execute(toRun: String) {
        val paged = pageable(toRun)
        pagedStatement = paged
        hasNextPage = false
        if (paged != null) showPage(0, history = toRun) else launchRun(toRun, history = toRun, paged = false)
    }

    /** Runs page [target] of [pagedStatement]: the statement with LIMIT/OFFSET (or .skip/.limit), or whole for size 0. */
    private fun showPage(target: Int, history: String? = null) {
        val stmt = pagedStatement ?: return
        page = target
        if (pageSize <= 0) {
            launchRun(stmt, history = history, paged = false)
            return
        }
        val text = if (language == QueryLanguage.MONGO) pagedFind(stmt, target, pageSize) else pagedSql(stmt, target, pageSize)
        launchRun(text, history = history, paged = true)
    }

    fun nextPage() {
        if (!running && hasNextPage) showPage(page + 1)
    }

    fun previousPage() {
        if (!running && page > 0) showPage(page - 1)
    }

    fun changePageSize(size: Int) {
        pageSize = size
        if (!running && pagedStatement != null) showPage(0)
    }

    /**
     * Runs [text]; when it is a [paged] run, the row past the page is taken off and tells [hasNextPage]. The query log
     * shows what ran (with its LIMIT), the history what the user typed ([history], null for a page turn).
     */
    private fun launchRun(text: String, history: String?, paged: Boolean) {
        job = ws.scope.launch {
            running = true
            elapsed = 0
            val start = System.currentTimeMillis()
            val ticker = launch { while (true) { delay(100); elapsed = System.currentTimeMillis() - start } }
            try {
                val maxRows = if (paged) maxOf(ws.maxResultRows, pageSize + 1) else ws.maxResultRows
                var out = ws.call(read = false) { it.execute(text, maxRows) }
                if (paged) {
                    val first = out.firstOrNull()
                    val table = first?.table
                    hasNextPage = table != null && table.rows.size > pageSize
                    if (table != null && hasNextPage) out = listOf(first.copy(table = table.copy(rows = table.rows.take(pageSize)))) + out.drop(1)
                } else hasNextPage = false
                results = out
                selectedResult = out.indexOfFirst { it.error != null }.takeIf { it >= 0 } ?: out.indexOfLast { it.table != null }.takeIf { it >= 0 } ?: 0
                out.forEach { ws.logStatement(it.statement, it.millis, it.error, "query") }
                if (history != null) ws.history.add(ws.profile.id, HistoryEntry(history, ws.currentDatabase, System.currentTimeMillis(), out.all { it.ok }))
                // A statement may have switched the database (USE, use, SELECT n) or created and dropped tables.
                val before = ws.currentDatabase
                ws.loadDatabases()
                if (ws.currentDatabase != before || out.any { r -> DDL.containsMatchIn(r.statement) }) ws.refreshObjects()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                results = listOf(StatementResult(text, error = e.message ?: e.javaClass.simpleName))
                selectedResult = 0
                hasNextPage = false
                ws.logStatement(text, 0, e.message, "query")
            } finally {
                ticker.cancel()
                running = false
            }
        }
    }

    fun stop() {
        ws.cancelRunning()
    }

    companion object {
        private val DDL = Regex("^\\s*(CREATE|DROP|ALTER|RENAME|TRUNCATE)\\b|\\.(drop|createCollection|renameCollection)\\(|^\\s*(FLUSHDB|FLUSHALL)\\b", RegexOption.IGNORE_CASE)
    }
}
