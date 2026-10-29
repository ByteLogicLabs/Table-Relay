package com.brainfactory.db.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.brainfactory.db.engine.BrowsePage
import com.brainfactory.db.engine.BrowseRequest
import com.brainfactory.db.engine.CellInput
import com.brainfactory.db.engine.FilterSpec
import com.brainfactory.db.engine.MongoSession
import com.brainfactory.db.engine.SortSpec
import com.brainfactory.db.engine.TableRef
import com.brainfactory.db.engine.TableStructure
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** A table, view or collection tab: its data pages, filters and sort, and its structure. */
class TableState(private val ws: Workspace, val ref: TableRef) {
    enum class Mode { DATA, STRUCTURE, JSON }

    var mode by mutableStateOf(Mode.DATA)
    var request by mutableStateOf(BrowseRequest(limit = ws.pageSize))
        private set
    var page by mutableStateOf<BrowsePage?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** Rows matching the filters; null while counting or when unknown. */
    var total by mutableStateOf<Long?>(null)
        private set
    var structure by mutableStateOf<TableStructure?>(null)
        private set
    var structureError by mutableStateOf<String?>(null)
        private set
    var structureLoading by mutableStateOf(false)
        private set
    var filtersOpen by mutableStateOf(false)

    /** Rows picked for a bulk delete (long press starts picking). */
    val selected = mutableStateListOf<Int>()
    val selecting: Boolean get() = selected.isNotEmpty()

    val isMongo: Boolean get() = ws.profile.driver == com.brainfactory.db.engine.Driver.MONGO
    val readOnly: Boolean get() = ws.profile.readOnly

    private var loadJob: Job? = null

    fun load(count: Boolean = true) {
        loadJob?.cancel()
        loadJob = ws.scope.launch {
            loading = true
            error = null
            val req = request
            try {
                val result = ws.call { it.browse(ref, req) }
                page = result
                selected.clear()
                ws.logStatement(result.statement, result.millis)
                if (count) {
                    total = null
                    total = runCatching { ws.call { it.count(ref, req) } }.getOrNull()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
                ws.logStatement("browse ${ref.display}", 0, error)
            } finally {
                loading = false
            }
        }
    }

    fun loadStructure(force: Boolean = false) {
        if (structure != null && !force) return
        ws.scope.launch {
            structureLoading = true
            structureError = null
            try {
                structure = ws.call { it.structure(ref) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                structureError = e.message
            } finally {
                structureLoading = false
            }
        }
    }

    /** Tapping a column header: ascending, then descending, then unsorted. */
    fun sortBy(column: String) {
        val current = request.sort.firstOrNull { it.column == column }
        val next = when {
            current == null -> listOf(SortSpec(column))
            !current.descending -> listOf(SortSpec(column, descending = true))
            else -> emptyList()
        }
        request = request.copy(sort = next, offset = 0)
        load(count = false)
    }

    fun applyFilters(filters: List<FilterSpec>, raw: String) {
        request = request.copy(filters = filters.filter { it.column.isNotBlank() }, rawFilter = raw.trim(), offset = 0)
        load()
    }

    fun clearFilters() = applyFilters(emptyList(), "")

    val filtered: Boolean get() = request.filters.isNotEmpty() || request.rawFilter.isNotBlank()

    val pageIndex: Long get() = request.offset / request.limit
    val pageCount: Long? get() = total?.let { maxOf(1, (it + request.limit - 1) / request.limit) }
    val hasNext: Boolean get() = total?.let { request.offset + request.limit < it } ?: ((page?.table?.rows?.size ?: 0) >= request.limit)

    fun goToPage(index: Long) {
        request = request.copy(offset = maxOf(0, index) * request.limit)
        load(count = false)
    }

    fun setPageSize(size: Int) {
        request = request.copy(limit = size, offset = 0)
        load(count = false)
    }

    /** The values that identify [row]: its primary key (or `_id`, or SQLite's rowid). */
    fun keyOf(row: Int): Map<String, Any?> {
        val p = page ?: return emptyMap()
        val values = p.table.rows.getOrNull(row) ?: return emptyMap()
        return p.keyColumns.associateWith { c -> values[p.table.columns.indexOfFirst { it.name == c }] }
    }

    /** Runs a change; returns null when it worked, else the error. The page reloads after a change. */
    private suspend fun change(what: String, block: (com.brainfactory.db.engine.DbSession) -> String): String? = try {
        val start = System.nanoTime()
        val statement = ws.call(read = false, block)
        ws.logStatement(statement, (System.nanoTime() - start) / 1_000_000)
        load()
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        ws.logStatement(what, 0, e.message)
        e.message ?: e.javaClass.simpleName
    }

    suspend fun updateCell(row: Int, column: String, value: CellInput): String? {
        val key = keyOf(row)
        return change("update ${ref.display}.$column") { it.updateCell(ref, key, column, value) }
    }

    suspend fun insertRow(values: Map<String, CellInput>): String? = change("insert into ${ref.display}") { it.insertRow(ref, values) }

    suspend fun deleteRows(rows: List<Int>): String? {
        val keys = rows.map { keyOf(it) }
        return change("delete from ${ref.display}") { it.deleteRows(ref, keys) }
    }

    suspend fun replaceDocument(row: Int, json: String): String? {
        val key = keyOf(row)
        return change("replace document in ${ref.display}") { (it as MongoSession).replaceDocument(ref, key, json) }
    }

    suspend fun insertDocument(json: String): String? = change("insert into ${ref.display}") { (it as MongoSession).insertDocument(ref, json) }
}
