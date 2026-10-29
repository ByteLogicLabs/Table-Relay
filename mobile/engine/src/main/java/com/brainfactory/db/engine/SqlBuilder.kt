package com.brainfactory.db.engine

/** A statement with `?` placeholders and their values. */
data class BoundSql(val sql: String, val params: List<Any?> = emptyList()) {
    /** The statement with its values written in, for the query log. */
    fun inline(dialect: SqlDialect): String {
        if (params.isEmpty()) return sql
        val out = StringBuilder()
        var p = 0
        var quote: Char? = null
        for (c in sql) {
            if (quote != null) {
                out.append(c)
                if (c == quote) quote = null
            } else if (c == '\'' || c == '"' || c == '`') {
                quote = c
                out.append(c)
            } else if (c == '?' && p < params.size) {
                out.append(dialect.literal(params[p++]))
            } else out.append(c)
        }
        return out.toString()
    }
}

/** The SELECT/UPDATE/INSERT/DELETE statements the grid runs, in each SQL dialect. */
class SqlBuilder(private val dialect: SqlDialect) {

    fun where(request: BrowseRequest, params: MutableList<Any?>): String {
        val parts = mutableListOf<String>()
        for (f in request.filters) {
            if (f.column.isBlank()) continue
            val col = dialect.quote(f.column)
            // PostgreSQL won't LIKE a number or a date; comparing their text is what the user means.
            val text = if (dialect == SqlDialect.POSTGRES) "CAST($col AS TEXT)" else col
            parts += when (f.op) {
                FilterOp.EQ -> "$col = ?".also { params += f.value }
                FilterOp.NE -> "$col <> ?".also { params += f.value }
                FilterOp.GT -> "$col > ?".also { params += f.value }
                FilterOp.GE -> "$col >= ?".also { params += f.value }
                FilterOp.LT -> "$col < ?".also { params += f.value }
                FilterOp.LE -> "$col <= ?".also { params += f.value }
                FilterOp.CONTAINS -> "$text ${like()} ?${escape()}".also { params += "%" + escapeLike(f.value) + "%" }
                FilterOp.NOT_CONTAINS -> "$text NOT ${like()} ?${escape()}".also { params += "%" + escapeLike(f.value) + "%" }
                FilterOp.STARTS_WITH -> "$text ${like()} ?${escape()}".also { params += escapeLike(f.value) + "%" }
                FilterOp.IS_NULL -> "$col IS NULL"
                FilterOp.IS_NOT_NULL -> "$col IS NOT NULL"
            }
        }
        if (request.rawFilter.isNotBlank()) parts += "(" + request.rawFilter.trim().removePrefix("WHERE ").removePrefix("where ") + ")"
        return if (parts.isEmpty()) "" else " WHERE " + parts.joinToString(" AND ")
    }

    /** Case-insensitive LIKE: PostgreSQL's is case-sensitive, the others' already aren't (for ASCII). */
    private fun like() = if (dialect == SqlDialect.POSTGRES) "ILIKE" else "LIKE"

    /** SQLite's LIKE has no escape character unless it's named; MySQL's and PostgreSQL's is already the backslash. */
    private fun escape() = if (dialect == SqlDialect.SQLITE) " ESCAPE '\\'" else ""

    private fun escapeLike(value: String) = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    fun browse(table: TableRef, request: BrowseRequest): BoundSql {
        val params = mutableListOf<Any?>()
        val sql = StringBuilder("SELECT * FROM ").append(dialect.qualified(table)).append(where(request, params))
        if (request.sort.isNotEmpty()) {
            sql.append(" ORDER BY ").append(request.sort.joinToString(", ") { dialect.quote(it.column) + if (it.descending) " DESC" else " ASC" })
        }
        sql.append(" LIMIT ").append(request.limit)
        if (request.offset > 0) sql.append(" OFFSET ").append(request.offset)
        return BoundSql(sql.toString(), params)
    }

    fun count(table: TableRef, request: BrowseRequest): BoundSql {
        val params = mutableListOf<Any?>()
        return BoundSql("SELECT COUNT(*) FROM " + dialect.qualified(table) + where(request, params), params)
    }

    private fun keyWhere(key: Map<String, Any?>, params: MutableList<Any?>): String {
        if (key.isEmpty()) throw DbException("This table has no primary key, so its rows can't be told apart to edit.")
        return key.entries.joinToString(" AND ") { (column, value) ->
            if (value == null) dialect.quote(column) + " IS NULL" else (dialect.quote(column) + " = ?").also { params += value }
        }
    }

    fun update(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): BoundSql {
        val params = mutableListOf<Any?>()
        val set = when (value) {
            CellInput.Null -> "NULL"
            CellInput.Default -> "DEFAULT"
            is CellInput.Text -> "?".also { params += value.value }
        }
        val sql = "UPDATE " + dialect.qualified(table) + " SET " + dialect.quote(column) + " = " + set + " WHERE " + keyWhere(key, params)
        // MySQL and SQLite can promise to touch one row; PostgreSQL's key WHERE already does.
        return BoundSql(if (dialect == SqlDialect.MYSQL) "$sql LIMIT 1" else sql, params)
    }

    fun insert(table: TableRef, values: Map<String, CellInput>): BoundSql {
        val given = values.filterValues { it != CellInput.Default }
        if (given.isEmpty()) {
            return BoundSql(
                when (dialect) {
                    SqlDialect.MYSQL -> "INSERT INTO " + dialect.qualified(table) + " () VALUES ()"
                    else -> "INSERT INTO " + dialect.qualified(table) + " DEFAULT VALUES"
                },
            )
        }
        val params = mutableListOf<Any?>()
        val placeholders = given.values.map { v ->
            when (v) {
                CellInput.Null -> "NULL"
                is CellInput.Text -> "?".also { params += v.value }
                CellInput.Default -> "DEFAULT"
            }
        }
        return BoundSql(
            "INSERT INTO " + dialect.qualified(table) + " (" + given.keys.joinToString(", ") { dialect.quote(it) } + ") VALUES (" + placeholders.joinToString(", ") + ")",
            params,
        )
    }

    fun delete(table: TableRef, keys: List<Map<String, Any?>>): BoundSql {
        if (keys.isEmpty()) throw DbException("No rows to delete.")
        val params = mutableListOf<Any?>()
        val where = keys.joinToString(" OR ") { "(" + keyWhere(it, params) + ")" }
        return BoundSql("DELETE FROM " + dialect.qualified(table) + " WHERE " + where, params)
    }
}
