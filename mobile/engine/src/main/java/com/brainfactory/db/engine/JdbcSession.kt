package com.brainfactory.db.engine

import java.math.BigDecimal
import java.math.BigInteger
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException

/**
 * What MySQL and PostgreSQL share: one JDBC connection (through the profile's SSH tunnel when it has one), the
 * grid's statements from [SqlBuilder], and reading results into [ResultTable]s.
 */
abstract class JdbcSession(final override val profile: ConnectionProfile, private val env: EngineEnv) : DbSession {
    protected val dialect = profile.driver.dialect
    protected val builder = SqlBuilder(dialect)
    private var tunnel: SshTunnel? = null
    protected lateinit var connection: Connection

    /** Opens the driver's connection to [host]:[port] (the tunnel's end when tunnelled). */
    protected abstract fun connect(host: String, port: Int, database: String?): Connection

    /** The columns that make up [table]'s primary key; empty for views and keyless tables. */
    protected abstract fun primaryKey(table: TableRef): List<String>

    /** Where the driver connects: the server, or the local end of the SSH tunnel (opened when it isn't). */
    protected fun endpoint(): Pair<String, Int> {
        val ssh = profile.ssh ?: return profile.host.ifBlank { "127.0.0.1" } to profile.port
        val t = tunnel?.takeIf { it.alive } ?: SshTunnel.open(ssh, profile.host.ifBlank { "127.0.0.1" }, profile.port, env.knownHosts).also { tunnel = it }
        return "127.0.0.1" to t.localPort
    }

    protected fun open(database: String?) {
        val (host, port) = endpoint()
        connection = try {
            connect(host, port, database).also { if (profile.readOnly) refuseWrites(it) }
        } catch (e: SQLException) {
            closeTunnel()
            throw DbException(friendlyConnectError(e), e)
        }
    }

    /** SQL that makes the server itself refuse writes for the rest of the session, for read-only connections. */
    protected abstract val readOnlySessionSql: String

    /**
     * A read-only connection is guarded twice: Brain DB sends only reading statements, and the server is told to
     * refuse writes, which also stops what a check can't see (a function that writes, called from a SELECT).
     */
    private fun refuseWrites(c: Connection) {
        c.createStatement().use { it.execute(readOnlySessionSql) }
    }

    protected fun reopen(database: String?) {
        runCatching { connection.close() }
        open(database)
    }

    private fun closeTunnel() {
        tunnel?.close()
        tunnel = null
    }

    override fun close() {
        runCatching { connection.close() }
        closeTunnel()
    }

    override fun ping() {
        if (tunnel?.alive == false) throw DbException("The SSH tunnel closed.")
        if (!connection.isValid(5)) throw DbException("The connection closed.")
    }

    override fun split(text: String): List<String> = splitSql(text, dialect)

    protected fun <T> query(sql: String, vararg params: Any?, read: (ResultSet) -> T): T = wrap {
        connection.prepareStatement(sql).use { st ->
            bind(st, params.toList())
            st.executeQuery().use(read)
        }
    }

    protected fun <T> rows(sql: String, vararg params: Any?, row: (ResultSet) -> T): List<T> = query(sql, *params) { rs ->
        val out = mutableListOf<T>()
        while (rs.next()) out += row(rs)
        out
    }

    protected fun bind(st: PreparedStatement, params: List<Any?>) {
        params.forEachIndexed { i, v ->
            when (v) {
                null -> st.setObject(i + 1, null)
                is ByteArray -> st.setBytes(i + 1, v)
                is JsonText -> st.setString(i + 1, v.text)
                is String -> st.setString(i + 1, v)
                else -> st.setObject(i + 1, v)
            }
        }
    }

    protected fun update(bound: BoundSql): Int = wrap {
        connection.prepareStatement(bound.sql).use { st ->
            bind(st, bound.params)
            st.executeUpdate()
        }
    }

    private val keyCache = mutableMapOf<TableRef, List<String>>()

    /** [table]'s primary key, read once per session. */
    protected fun keysOf(table: TableRef): List<String> =
        if (table.kind != ObjectKind.TABLE) emptyList() else keyCache.getOrPut(table) { runCatching { primaryKey(table) }.getOrDefault(emptyList()) }

    override fun browse(table: TableRef, request: BrowseRequest): BrowsePage {
        val keys = keysOf(table)
        // Unsorted pages come in the server's storage order, which an edit changes (PostgreSQL writes an updated row
        // anew): ordering by the key keeps rows where they were and pages from overlapping.
        val ordered = if (request.sort.isEmpty() && keys.isNotEmpty()) request.copy(sort = keys.map { SortSpec(it) }) else request
        val bound = builder.browse(table, ordered)
        val (result, ms) = timed {
            wrap {
                connection.prepareStatement(bound.sql).use { st ->
                    bind(st, bound.params)
                    st.executeQuery().use { readTable(it, Int.MAX_VALUE) }
                }
            }
        }
        val marked = result.copy(columns = result.columns.map { it.copy(key = it.name in keys) })
        return BrowsePage(marked, keys.takeIf { k -> k.all { c -> marked.columns.any { it.name == c } } }.orEmpty(), bound.inline(dialect), ms)
    }

    override fun count(table: TableRef, request: BrowseRequest): Long? {
        val bound = builder.count(table, request)
        return wrap {
            connection.prepareStatement(bound.sql).use { st ->
                bind(st, bound.params)
                st.executeQuery().use { if (it.next()) it.getLong(1) else null }
            }
        }
    }

    override fun updateCell(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): String {
        profile.requireWritable()
        val bound = builder.update(table, key, column, value)
        val n = update(bound)
        if (n == 0) throw DbException("No row was changed: it may have been edited or deleted by someone else. Refresh and try again.")
        return bound.inline(dialect)
    }

    override fun insertRow(table: TableRef, values: Map<String, CellInput>): String {
        profile.requireWritable()
        val bound = builder.insert(table, values)
        update(bound)
        return bound.inline(dialect)
    }

    override fun deleteRows(table: TableRef, keys: List<Map<String, Any?>>): String {
        profile.requireWritable()
        val bound = builder.delete(table, keys)
        update(bound)
        return bound.inline(dialect)
    }

    override fun execute(text: String, maxRows: Int): List<StatementResult> {
        val out = mutableListOf<StatementResult>()
        for (statement in split(text)) {
            val start = System.nanoTime()
            val result = try {
                if (profile.readOnly && !isReadOnlyStatement(statement, dialect)) {
                    throw DbException("This connection is read-only, so only reading statements run.")
                }
                runStatement(statement, maxRows)
            } catch (e: Exception) {
                val note = runCatching { afterFailure() }.getOrNull()
                StatementResult(statement, error = message(e) + (note?.let { "\n\n$it" } ?: ""))
            }
            out += result.copy(millis = (System.nanoTime() - start) / 1_000_000)
            if (!result.ok) break
            afterStatement(statement)
        }
        return out
    }

    /** A statement ran: MySQL's `USE db` changes the current database, for one. */
    protected open fun afterStatement(statement: String) {}

    /** A statement failed; returns a note on what was done about it (PostgreSQL's aborted transaction), or null. */
    protected open fun afterFailure(): String? = null

    @Volatile private var running: java.sql.Statement? = null

    override fun cancel() {
        runCatching { running?.cancel() }
    }

    private fun runStatement(statement: String, maxRows: Int): StatementResult = connection.createStatement().use { st ->
        running = st
        st.maxRows = maxRows + 1
        var hasResult = st.execute(statement)
        var table: ResultTable? = null
        var affected: Long? = null
        // A statement may give several results (a procedure's SELECTs); the first table and the total count are kept.
        var guard = 0
        while (guard++ < 32) {
            if (hasResult) {
                if (table == null) st.resultSet.use { table = readTable(it, maxRows) } else st.resultSet.close()
            } else {
                val n = st.updateCount
                if (n == -1) break
                affected = (affected ?: 0) + n
            }
            hasResult = st.moreResults
        }
        val warning = runCatching { st.warnings?.message }.getOrNull()
        running = null
        StatementResult(statement, table = table, affected = if (table == null) affected ?: 0 else null, message = warning)
    }

    /** Reads up to [maxRows] rows; one more than that marks the result as truncated. */
    protected fun readTable(rs: ResultSet, maxRows: Int): ResultTable {
        val meta = rs.metaData
        val n = meta.columnCount
        val columns = (1..n).map { ColumnMeta(meta.getColumnLabel(it).ifBlank { meta.getColumnName(it) }, meta.getColumnTypeName(it).orEmpty()) }
        val rows = mutableListOf<List<Any?>>()
        var truncated = false
        while (rs.next()) {
            if (rows.size >= maxRows) { truncated = true; break }
            rows += (1..n).map { readValue(rs, it, columns[it - 1].type) }
        }
        return ResultTable(columns, rows, truncated)
    }

    protected open fun readValue(rs: ResultSet, i: Int, typeName: String): Any? {
        val v = try {
            rs.getObject(i)
        } catch (e: SQLException) {
            // A value the driver can't turn into an object (MySQL's zero dates): its text will do.
            return runCatching { rs.getString(i) }.getOrNull()
        } catch (e: LinkageError) {
            // A type whose Java class Android lacks (PostgreSQL's point is java.awt.Point): its text too.
            return runCatching { rs.getString(i) }.getOrNull()
        } ?: return null
        return when (v) {
            is String -> if (typeName.equals("json", true) || typeName.equals("jsonb", true)) JsonText(v) else v
            is Boolean, is Int, is Long, is Short, is Byte, is Double, is Float, is BigDecimal -> v
            is BigInteger -> v.toBigDecimal()
            // MySQL sends JSON columns with the binary character set, so the driver hands over their UTF-8 bytes.
            is ByteArray -> if (typeName.equals("json", true)) JsonText(String(v, Charsets.UTF_8)) else v
            is java.sql.Timestamp, is java.sql.Date, is java.sql.Time -> rs.getString(i)
            is java.sql.Clob -> v.characterStream.use { it.readText() }
            is java.sql.Blob -> v.getBytes(1, v.length().toInt())
            // PostgreSQL's own array text ({a,b}) is what an edit has to send back.
            is java.sql.Array -> if (dialect == SqlDialect.POSTGRES) rs.getString(i) else JsonText(arrayJson(v))
            else -> {
                val text = rs.getString(i) ?: v.toString()
                if (typeName.equals("json", true) || typeName.equals("jsonb", true)) JsonText(text) else text
            }
        }
    }

    private fun arrayJson(array: java.sql.Array): String = runCatching {
        val items = (array.array as Array<*>)
        org.json.JSONArray(items.map { item ->
            when (item) {
                null -> org.json.JSONObject.NULL
                is Number, is Boolean -> item
                else -> item.toString()
            }
        }).toString()
    }.getOrElse { array.toString() }

    /** Runs [block], turning the driver's exceptions into [DbException]s with the server's message. */
    protected inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: SQLException) {
        throw DbException(message(e), e)
    }

    protected fun message(e: Throwable): String = when (e) {
        is DbException -> e.message.orEmpty()
        // MariaDB's driver starts its messages with "(conn=123)", which means nothing to the user.
        is SQLException -> e.message?.replace(Regex("\\(conn=\\d+\\)\\s*"), "") ?: e.javaClass.simpleName
        else -> e.message ?: e.javaClass.simpleName
    }.trim()

    private fun friendlyConnectError(e: SQLException): String {
        val m = message(e)
        return when {
            m.contains("Access denied", true) || m.contains("password authentication failed", true) -> "Sign-in refused: check the user and password. ($m)"
            m.contains("Connection refused", true) -> "The server refused the connection. Is it running, and is the host and port right? ($m)"
            m.contains("timed out", true) || m.contains("timeout", true) -> "The server didn't answer in time. Check the host, port and network. ($m)"
            m.contains("UnknownHost", true) || m.contains("Unable to resolve", true) -> "The host couldn't be found. ($m)"
            else -> m
        }
    }

    /** The first column of the first row [sql] gives, or null. */
    protected fun singleString(sql: String): String? = runCatching {
        connection.createStatement().use { st -> st.executeQuery(sql).use { if (it.next()) it.getString(1) else null } }
    }.getOrNull()

    protected fun execUpdate(sql: String) = wrap { connection.createStatement().use { it.execute(sql) } }
}
