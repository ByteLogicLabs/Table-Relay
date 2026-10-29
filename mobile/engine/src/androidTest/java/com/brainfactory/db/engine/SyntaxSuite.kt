package com.brainfactory.db.engine

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.net.InetSocketAddress
import java.net.Socket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue

/**
 * What the per-driver syntax suites share. They run on a device or emulator against real servers: the host is the
 * `dbHost` instrumentation argument (10.0.2.2, the emulator's host, by default) and the ports and accounts are
 * Brain DB's test servers (see brain-db-testing in the project notes): MySQL 23306, PostgreSQL 25432, MongoDB 27117
 * (replica set) and 27118 (auth), Redis 26379. A suite whose server doesn't answer is skipped, not failed.
 */
abstract class SyntaxSuite {
    protected val args = InstrumentationRegistry.getArguments()
    protected val host: String = args.getString("dbHost", "10.0.2.2")
    protected val env = EngineEnv(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)

    protected fun requireServer(port: Int) {
        val up = runCatching { Socket().use { it.connect(InetSocketAddress(host, port), 3000) } }.isSuccess
        assumeTrue("No server at $host:$port", up)
    }

    /** Runs [text] and expects every statement to work; returns the results. */
    protected fun DbSession.ok(text: String, maxRows: Int = 5000): List<StatementResult> {
        val results = execute(text, maxRows)
        statements += results.size
        val failed = results.firstOrNull { !it.ok }
        if (failed != null) fail("Expected to work:\n${failed.statement}\nbut failed: ${failed.error}")
        assertEquals("Every statement of\n$text\nshould run", split(text).size, results.size)
        return results
    }

    /** Runs a single statement and returns its rows (which it must have). */
    protected fun DbSession.table(text: String, maxRows: Int = 5000): ResultTable {
        val result = ok(text, maxRows).single()
        val table = result.table
        if (table == null) fail("Expected rows from: $text (got ${result.message ?: result.affected})")
        return table!!
    }

    /** Runs [text] and expects the last statement to fail with [contains] in its message (ignoring case). */
    protected fun DbSession.fails(text: String, contains: String): String {
        val results = execute(text)
        statements += results.size
        val last = results.last()
        val error = last.error
        if (error == null) fail("Expected to fail: $text\n(got ${last.table?.rows?.size ?: last.affected ?: last.message})")
        assertTrue("Error of $text should mention \"$contains\" but was: $error", error!!.contains(contains, ignoreCase = true))
        return error
    }

    protected fun ResultTable.column(name: String): Int = columns.indexOfFirst { it.name.equals(name, ignoreCase = true) }.also {
        assertTrue("No column $name in ${columns.map { c -> c.name }}", it >= 0)
    }

    protected fun ResultTable.value(row: Int, column: String): Any? = rows[row][column(column)]

    /** The single value of a one-row, one-column result. */
    protected fun DbSession.scalar(text: String): Any? {
        val table = table(text)
        assertEquals("One row expected from $text", 1, table.rows.size)
        return table.rows[0][0]
    }

    /** Checks the editor's view of [text]: not destructive, reading, and pageable or not. */
    protected fun classify(text: String, dialect: SqlDialect, reading: Boolean, pageable: Boolean? = null, destructive: Boolean = false) {
        assertEquals("destructive: $text", destructive, analyzeDestructive(text, dialect).isNotEmpty())
        splitSql(text, dialect).forEach { assertEquals("reading: $it", reading, isReadOnlyStatement(it, dialect)) }
        if (pageable != null) {
            if (pageable) assertNotNull("pageable: $text", pageableSelect(text, dialect)) else assertNull("not pageable: $text", pageableSelect(text, dialect))
        }
    }

    protected fun log(message: String) = Log.i("SyntaxSuite", message)

    companion object {
        /** Statements run by all suites in this process, for the log. */
        @JvmStatic var statements = 0
    }
}
