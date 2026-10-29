package com.brainfactory.db.engine

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import java.io.File

/**
 * A SQLite file on the phone, through Android's own SQLite. A table without a primary key is edited by its
 * `rowid`, which the grid then shows as its first column (as DB Browser for SQLite does).
 */
class SqliteSession(override val profile: ConnectionProfile) : DbSession {

    private val dialect = SqlDialect.SQLITE
    private val builder = SqlBuilder(dialect)
    private val db: SQLiteDatabase

    override val capabilities = Capabilities(databases = false, processList = false)
    override val currentDatabase: String = File(profile.database).name

    init {
        val path = profile.database.ifBlank { throw DbException("Choose the SQLite database file.") }
        if (profile.readOnly && !File(path).exists()) throw DbException("The file $path doesn't exist.")
        db = try {
            SQLiteDatabase.openDatabase(
                path, null,
                if (profile.readOnly) SQLiteDatabase.OPEN_READONLY else SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY,
            )
        } catch (e: SQLiteException) {
            throw DbException("The file couldn't be opened as a SQLite database: ${e.message}", e)
        }
    }

    override fun close() = db.close()

    override fun ping() {
        if (!db.isOpen) throw DbException("The database file is closed.")
    }

    override fun databases(): List<String> = listOf(currentDatabase)

    override fun useDatabase(name: String) {}

    override fun split(text: String) = splitSql(text, dialect)

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: SQLiteException) {
        throw DbException(cleanMessage(e), e)
    }

    /** Android's messages end with "(code 1 SQLITE_ERROR): , while compiling: …"; the part before is the reason. */
    private fun cleanMessage(e: Exception): String {
        val m = e.message.orEmpty()
        val reason = m.substringBefore(" (code ").trim()
        return reason.ifBlank { m.ifBlank { e.javaClass.simpleName } }
    }

    private fun <T> rows(sql: String, vararg args: String, row: (Cursor) -> T): List<T> = wrap {
        db.rawQuery(sql, args).use { c ->
            val out = mutableListOf<T>()
            while (c.moveToNext()) out += row(c)
            out
        }
    }

    override fun objects(): List<DbObject> = rows(
        "SELECT name, type, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view', 'trigger') ORDER BY type, name",
    ) { c ->
        when (c.getString(1)) {
            "view" -> DbObject(c.getString(0), ObjectKind.VIEW)
            "trigger" -> DbObject(c.getString(0), ObjectKind.TRIGGER, detail = "on " + c.getString(2))
            else -> DbObject(c.getString(0), ObjectKind.TABLE)
        }
    }

    private data class SqliteColumn(val name: String, val type: String, val notNull: Boolean, val default: String?, val pk: Int)

    private fun tableInfo(table: String) = rows("PRAGMA table_info(" + dialect.quote(table) + ")") { c ->
        SqliteColumn(c.getString(1), c.getString(2).orEmpty(), c.getInt(3) != 0, if (c.isNull(4)) null else c.getString(4), c.getInt(5))
    }

    /** The primary key's columns; `rowid` for an ordinary table without one; empty for views and WITHOUT ROWID tables without one. */
    private fun keyOf(table: TableRef): List<String> {
        if (table.kind != ObjectKind.TABLE) return emptyList()
        val pk = tableInfo(table.name).filter { it.pk > 0 }.sortedBy { it.pk }.map { it.name }
        if (pk.isNotEmpty()) return pk
        val sql = rows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table.name) { it.getString(0) }.firstOrNull().orEmpty()
        return if (sql.contains("WITHOUT ROWID", ignoreCase = true)) emptyList() else listOf(ROWID)
    }

    override fun browse(table: TableRef, request: BrowseRequest): BrowsePage {
        val keys = keyOf(table)
        val types = runCatching { tableInfo(table.name).associate { it.name to it.type } }.getOrDefault(emptyMap())
        // In key order unless sorted otherwise, so rows keep their places after an edit and pages don't overlap.
        val ordered = if (request.sort.isEmpty() && keys.isNotEmpty()) request.copy(sort = keys.map { SortSpec(it) }) else request
        var bound = builder.browse(table, ordered)
        if (keys == listOf(ROWID)) bound = bound.copy(sql = bound.sql.replaceFirst("SELECT * FROM", "SELECT rowid, * FROM"))
        val (result, ms) = timed { wrap { db.rawQuery(bound.sql, bound.params.map { it?.toString() }.toTypedArray()).use { read(it, Int.MAX_VALUE) } } }
        val table2 = result.copy(columns = result.columns.map { it.copy(type = types[it.name] ?: if (it.name == ROWID) "INTEGER" else "", key = it.name in keys) })
        return BrowsePage(table2, keys, bound.inline(dialect), ms)
    }

    override fun count(table: TableRef, request: BrowseRequest): Long? {
        val bound = builder.count(table, request)
        return wrap { db.rawQuery(bound.sql, bound.params.map { it?.toString() }.toTypedArray()).use { if (it.moveToFirst()) it.getLong(0) else null } }
    }

    private fun read(c: Cursor, maxRows: Int): ResultTable {
        val columns = c.columnNames.map { ColumnMeta(it) }
        val rows = mutableListOf<List<Any?>>()
        var truncated = false
        while (c.moveToNext()) {
            if (rows.size >= maxRows) { truncated = true; break }
            rows += columns.indices.map { i ->
                when (c.getType(i)) {
                    Cursor.FIELD_TYPE_NULL -> null
                    Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                    Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                    Cursor.FIELD_TYPE_BLOB -> c.getBlob(i)
                    else -> c.getString(i)
                }
            }
        }
        return ResultTable(columns, rows, truncated)
    }

    /** Runs a writing statement with typed parameters; returns the rows it changed. */
    private fun write(bound: BoundSql): Int = wrap {
        db.compileStatement(bound.sql).use { st ->
            bound.params.forEachIndexed { i, v ->
                when (v) {
                    null -> st.bindNull(i + 1)
                    is Long -> st.bindLong(i + 1, v)
                    is Int -> st.bindLong(i + 1, v.toLong())
                    is Double -> st.bindDouble(i + 1, v)
                    is ByteArray -> st.bindBlob(i + 1, v)
                    else -> st.bindString(i + 1, v.toString())
                }
            }
            st.executeUpdateDelete()
        }
    }

    override fun updateCell(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): String {
        profile.requireWritable()
        val bound = builder.update(table, key, column, value)
        if (write(bound) == 0) throw DbException("No row was changed: it may have been edited or deleted meanwhile. Refresh and try again.")
        return bound.inline(dialect)
    }

    override fun insertRow(table: TableRef, values: Map<String, CellInput>): String {
        profile.requireWritable()
        val bound = builder.insert(table, values.filterKeys { it != ROWID })
        write(bound)
        return bound.inline(dialect)
    }

    override fun deleteRows(table: TableRef, keys: List<Map<String, Any?>>): String {
        profile.requireWritable()
        val bound = builder.delete(table, keys)
        write(bound)
        return bound.inline(dialect)
    }

    override fun structure(table: TableRef): TableStructure {
        val info = tableInfo(table.name)
        val indexes = rows("PRAGMA index_list(" + dialect.quote(table.name) + ")") { c -> Triple(c.getString(1), c.getInt(2) != 0, c.getString(3).orEmpty()) }
            .map { (name, unique, origin) ->
                val cols = rows("PRAGMA index_info(" + dialect.quote(name) + ")") { it.getString(2).orEmpty() }
                val sql = rows("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name) { it.getString(0) }.firstOrNull()
                IndexInfo(name, cols, unique, primary = origin == "pk", definition = sql ?: "($origin)")
            }
        val pkCols = info.filter { it.pk > 0 }.sortedBy { it.pk }.map { it.name }
        val allIndexes = if (pkCols.isNotEmpty() && indexes.none { it.primary }) listOf(IndexInfo("PRIMARY KEY", pkCols, true, true)) + indexes else indexes
        val foreignKeys = rows("PRAGMA foreign_key_list(" + dialect.quote(table.name) + ")") { c ->
            listOf(c.getInt(0).toString(), c.getString(2), c.getString(3), c.getString(4).orEmpty(), c.getString(5).orEmpty(), c.getString(6).orEmpty())
        }.groupBy { it[0] }.map { (id, parts) ->
            ForeignKeyInfo("fk_$id", parts.map { it[2] }, parts.first()[1], parts.map { it[3] }, parts.first()[4], parts.first()[5])
        }
        val uniques = indexes.filter { it.unique && it.columns.size == 1 }.map { it.columns.first() }.toSet()
        val columns = info.map { c ->
            ColumnInfo(c.name, c.type, !c.notNull, c.default, if (c.pk > 0) "PRI" else if (c.name in uniques) "UNI" else "")
        }
        val ddl = rows("SELECT sql FROM sqlite_master WHERE name = ? OR (type = 'index' AND tbl_name = ? AND sql IS NOT NULL) ORDER BY type = 'index'", table.name, table.name) { it.getString(0) }
            .joinToString(";\n\n", postfix = ";")
        val count = runCatching { count(table, BrowseRequest()) }.getOrNull()
        val facts = listOfNotNull(
            count?.let { "Rows" to it.toString() },
            "File" to profile.database,
            runCatching { "File size" to formatBytes(File(profile.database).length()) }.getOrNull(),
        )
        return TableStructure(columns, allIndexes, foreignKeys, ddl, facts)
    }

    override fun execute(text: String, maxRows: Int): List<StatementResult> {
        val out = mutableListOf<StatementResult>()
        for (statement in split(text)) {
            val start = System.nanoTime()
            val result = try {
                if (profile.readOnly && !isReadOnlyStatement(statement, dialect)) throw DbException("This connection is read-only, so only reading statements run.")
                val upper = stripComments(statement, dialect).trim().uppercase()
                val returnsRows = listOf("SELECT", "PRAGMA", "WITH", "EXPLAIN", "VALUES").any { upper.startsWith(it) } || Regex("\\bRETURNING\\b").containsMatchIn(upper)
                if (returnsRows) {
                    val table = wrap { db.rawQuery(statement, null).use { read(it, maxRows) } }
                    if (table.columns.isEmpty()) StatementResult(statement, affected = 0) else StatementResult(statement, table = table)
                } else {
                    // Android runs statements starting BEGIN, COMMIT/END and ROLLBACK through its own transaction
                    // calls, which turn ROLLBACK TO a savepoint into a rollback of everything; a leading comment
                    // sends that one to SQLite as written.
                    val raw = if (Regex("^ROLLBACK\\s+(TRANSACTION\\s+)?TO\\b").containsMatchIn(upper)) "/* savepoint */ $statement" else statement
                    wrap { db.execSQL(raw) }
                    val changed = rows("SELECT changes()") { it.getLong(0) }.firstOrNull() ?: 0
                    StatementResult(statement, affected = if (upper.startsWith("INSERT") || upper.startsWith("UPDATE") || upper.startsWith("DELETE") || upper.startsWith("REPLACE")) changed else 0)
                }
            } catch (e: Exception) {
                StatementResult(statement, error = if (e is DbException) e.message.orEmpty() else cleanMessage(e))
            }
            out += result.copy(millis = (System.nanoTime() - start) / 1_000_000)
            if (!result.ok) break
        }
        return out
    }

    override fun definition(obj: DbObject): String? =
        rows("SELECT sql FROM sqlite_master WHERE name = ?", obj.name) { it.getString(0) }.firstOrNull()?.let { "$it;" }

    override fun processList(): ResultTable = throw DbException("SQLite has no process list.")

    override fun processKill(id: Any?) = throw DbException("SQLite has no process list.")

    companion object {
        const val ROWID = "rowid"
    }
}
