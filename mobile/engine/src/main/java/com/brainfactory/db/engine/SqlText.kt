package com.brainfactory.db.engine

import java.math.BigDecimal

/** Quoting and literals for the three SQL dialects. */
enum class SqlDialect {
    MYSQL, POSTGRES, SQLITE;

    fun quote(identifier: String): String = when (this) {
        MYSQL -> "`" + identifier.replace("`", "``") + "`"
        else -> "\"" + identifier.replace("\"", "\"\"") + "\""
    }

    /** `db`.`table` / "schema"."table" / "table". */
    fun qualified(ref: TableRef): String = when (this) {
        MYSQL -> listOfNotNull(ref.database?.takeIf { it.isNotEmpty() }, ref.name).joinToString(".") { quote(it) }
        POSTGRES -> listOfNotNull(ref.schema?.takeIf { it.isNotEmpty() }, ref.name).joinToString(".") { quote(it) }
        SQLITE -> quote(ref.name)
    }

    /** A value as an SQL literal, for exported INSERT statements and the query log. */
    fun literal(value: Any?): String = when (value) {
        null -> "NULL"
        is Boolean -> when (this) {
            POSTGRES -> if (value) "TRUE" else "FALSE"
            else -> if (value) "1" else "0"
        }
        is Int, is Long, is Short, is Byte, is BigDecimal -> value.toString()
        is Double -> if (value.isFinite()) value.toString() else "'$value'"
        is Float -> if (value.isFinite()) value.toString() else "'$value'"
        is Number -> value.toString()
        is ByteArray -> when (this) {
            POSTGRES -> "'\\x" + value.toHex() + "'"
            else -> "X'" + value.toHex() + "'"
        }
        else -> stringLiteral(value.toString())
    }

    fun stringLiteral(text: String): String = when (this) {
        MYSQL -> "'" + text.replace("\\", "\\\\").replace("'", "''") + "'"
        else -> "'" + text.replace("'", "''") + "'"
    }
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/** A statement found in an editor's text: where it starts and ends, for "run the statement under the cursor". */
data class StatementSpan(val text: String, val start: Int, val end: Int)

/**
 * Where a quoted string, quoted identifier, comment or PostgreSQL dollar-quoted body that starts at [i] ends (the
 * index just past it), and whether it is a comment; null when none starts there. Per dialect: MySQL strings take
 * backslash escapes and "double quotes" are strings, `#` starts a comment; PostgreSQL has E'…' escapes and
 * $tag$ bodies; SQLite also quotes identifiers with `backticks` and [brackets]. Doubled quotes escape everywhere.
 */
internal fun sqlTokenEnd(sql: String, i: Int, dialect: SqlDialect): Pair<Int, Boolean>? {
    val n = sql.length
    val c = sql[i]
    val next = if (i + 1 < n) sql[i + 1] else '\u0000'
    fun quoted(close: Char, backslash: Boolean): Int {
        var j = i + 1
        while (j < n) {
            val d = sql[j]
            if (backslash && d == '\\') { j += 2; continue }
            if (d == close) {
                if (j + 1 < n && sql[j + 1] == close) { j += 2; continue }
                return j + 1
            }
            j++
        }
        return n
    }
    fun lineEnd() = sql.indexOf('\n', i).let { if (it < 0) n else it }
    return when {
        c == '-' && next == '-' -> lineEnd() to true
        c == '#' && dialect == SqlDialect.MYSQL -> lineEnd() to true
        c == '/' && next == '*' -> blockCommentEnd(sql, i, nested = dialect == SqlDialect.POSTGRES) to true
        c == '\'' -> {
            val escapes = when (dialect) {
                SqlDialect.MYSQL -> true
                // E'…' (and e'…'): an escape string, unless the E ends an identifier (name'…' isn't valid anyway)
                SqlDialect.POSTGRES -> i > 0 && (sql[i - 1] == 'E' || sql[i - 1] == 'e') && (i < 2 || !isIdentChar(sql[i - 2]))
                SqlDialect.SQLITE -> false
            }
            quoted('\'', escapes) to false
        }
        c == '"' -> quoted('"', dialect == SqlDialect.MYSQL) to false
        c == '`' && dialect != SqlDialect.POSTGRES -> quoted('`', false) to false
        c == '[' && dialect == SqlDialect.SQLITE -> sql.indexOf(']', i + 1).let { if (it < 0) n else it + 1 } to false
        c == '$' && dialect == SqlDialect.POSTGRES && (i == 0 || !isIdentChar(sql[i - 1])) -> {
            val tag = DOLLAR_TAG.find(sql.substring(i, minOf(n, i + 64)))?.value ?: return null
            val close = sql.indexOf(tag, i + tag.length)
            (if (close < 0) n else close + tag.length) to false
        }
        else -> null
    }
}

/** Where the block comment at [i] ends; PostgreSQL nests them (`/* a /* b */ c */` is one comment). */
private fun blockCommentEnd(sql: String, i: Int, nested: Boolean): Int {
    if (!nested) return sql.indexOf("*/", i + 2).let { if (it < 0) sql.length else it + 2 }
    var depth = 0
    var j = i
    while (j < sql.length - 1) {
        when {
            sql[j] == '/' && sql[j + 1] == '*' -> { depth++; j += 2 }
            sql[j] == '*' && sql[j + 1] == '/' -> { depth--; j += 2; if (depth == 0) return j }
            else -> j++
        }
    }
    return sql.length
}

private val DOLLAR_TAG = Regex("^\\$(?:[A-Za-z_][A-Za-z0-9_]*)?\\$")

private fun isIdentChar(c: Char) = c.isLetterOrDigit() || c == '_' || c == '$'

/** Statement kinds whose bodies may hold `BEGIN … END` blocks with semicolons inside. */
private val ROUTINE_KINDS = setOf("procedure", "function", "trigger", "event")

/** Words that make a CREATE statement something other than a routine (CREATE TABLE … event VARCHAR …). */
private val NOT_ROUTINE = setOf("table", "view", "index", "database", "schema", "user", "role", "sequence", "type", "domain", "extension")

/** Words that, after END, close a control statement (END IF, END LOOP…) rather than a BEGIN block. */
private val END_OF_CONTROL = setOf("if", "loop", "while", "repeat", "for")

/**
 * Splits SQL into statements on `;`, leaving alone semicolons inside quotes, comments and PostgreSQL's dollar-quoted
 * bodies, as Table Relay's adapters split it, and also:
 *
 * - MySQL's client-side `DELIMITER //` lines change the delimiter (as mysql and Table Relay's MySQL adapter allow);
 * - the `BEGIN … END` blocks of CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT (MySQL routines, SQLite triggers,
 *   PostgreSQL's BEGIN ATOMIC) stay whole without a DELIMITER, counting nested blocks and telling END IF, END LOOP,
 *   END CASE and CASE … END apart from the END of a block.
 *
 * Statements that are only comments are dropped.
 */
fun splitSqlSpans(sql: String, dialect: SqlDialect): List<StatementSpan> {
    val out = mutableListOf<StatementSpan>()
    val n = sql.length
    var delimiter = ";"
    var start = 0
    var i = 0
    // The statement so far: nothing but blanks and comments yet; its words; routine block tracking.
    var blank = true
    var words = 0
    var firstWord = ""
    var routine = false
    var notRoutine = false
    var blockDepth = 0
    var caseDepth = 0
    var pendingEnd = false

    fun closeEnd() {
        pendingEnd = false
        if (caseDepth > 0) caseDepth-- else if (blockDepth > 0) blockDepth--
    }

    fun flush(end: Int) {
        val raw = sql.substring(start, end)
        val text = raw.trim()
        if (text.isNotEmpty() && stripSqlComments(text, dialect).isNotBlank()) {
            val lead = raw.indexOf(text)
            out += StatementSpan(text, start + lead, start + lead + text.length)
        }
        blank = true; words = 0; firstWord = ""; routine = false; notRoutine = false
        blockDepth = 0; caseDepth = 0; pendingEnd = false
    }

    while (i < n) {
        val c = sql[i]
        // DELIMITER x: a mysql client command, only where a statement could start, on a line of its own
        if (dialect == SqlDialect.MYSQL && blank && (c == 'D' || c == 'd') && sql.regionMatches(i, "DELIMITER", 0, 9, ignoreCase = true) &&
            i + 9 < n && (sql[i + 9] == ' ' || sql[i + 9] == '\t')
        ) {
            val lineEnd = sql.indexOf('\n', i).let { if (it < 0) n else it }
            val token = sql.substring(i + 9, lineEnd).trim()
            if (token.isNotEmpty()) {
                delimiter = token
                i = lineEnd
                start = i
                continue
            }
        }
        val token = sqlTokenEnd(sql, i, dialect)
        if (token != null) {
            if (!token.second) blank = false
            i = token.first
            continue
        }
        if (sql.startsWith(delimiter, i)) {
            if (pendingEnd) closeEnd()
            // A DELIMITER the user set ends the statement wherever it stands, as in the mysql client; `;` only
            // outside BEGIN … END blocks.
            if (blockDepth == 0 || delimiter != ";") {
                flush(i)
                i += delimiter.length
                start = i
                continue
            }
        }
        if (c.isLetter() || c == '_') {
            var j = i + 1
            // A word ends at a DELIMITER the user set, which may be made of identifier characters ($$): END$$
            while (j < n && isIdentChar(sql[j]) && !(delimiter != ";" && sql.startsWith(delimiter, j))) j++
            val word = sql.substring(i, j).lowercase()
            blank = false
            words++
            if (words == 1) firstWord = word
            if (firstWord == "create" && !routine && !notRoutine && words <= 10) {
                if (word in NOT_ROUTINE) notRoutine = true else if (word in ROUTINE_KINDS) routine = true
            }
            if (routine) {
                if (pendingEnd) {
                    when (word) {
                        in END_OF_CONTROL -> pendingEnd = false
                        "case" -> { pendingEnd = false; if (caseDepth > 0) caseDepth-- }
                        else -> closeEnd()
                    }
                    if (word in END_OF_CONTROL || word == "case") { i = j; continue }
                }
                when (word) {
                    "begin" -> blockDepth++
                    "case" -> caseDepth++
                    "end" -> pendingEnd = true
                }
            }
            i = j
            continue
        }
        if (!c.isWhitespace()) blank = false
        i++
    }
    flush(n)
    return out
}

fun splitSql(sql: String, dialect: SqlDialect): List<String> = splitSqlSpans(sql, dialect).map { it.text }

/** The statement the cursor is in (or just after), or null when the text has none. */
fun statementAt(sql: String, cursor: Int, dialect: SqlDialect): StatementSpan? {
    val spans = splitSqlSpans(sql, dialect)
    if (spans.isEmpty()) return null
    return spans.firstOrNull { cursor in it.start..it.end }
        ?: spans.lastOrNull { it.end <= cursor }
        ?: spans.first()
}

/**
 * [sql] without its comments, quotes left as they are (a `--` inside a string stays). MySQL's executable comments
 * (`/*! … */`) and optimizer hints (`/*+ … */`) are kept, since they change what runs.
 */
fun stripSqlComments(sql: String, dialect: SqlDialect): String {
    val out = StringBuilder(sql.length)
    var i = 0
    while (i < sql.length) {
        val token = sqlTokenEnd(sql, i, dialect)
        if (token == null) {
            out.append(sql[i])
            i++
            continue
        }
        val (end, comment) = token
        val keep = comment && dialect == SqlDialect.MYSQL && sql.startsWith("/*", i) && i + 2 < sql.length && (sql[i + 2] == '!' || sql[i + 2] == '+')
        // A comment becomes a space, so the words on either side of it don't run together.
        if (!comment || keep) out.append(sql, i, end) else out.append(' ')
        i = end
    }
    return out.toString()
}

/** The statement without its comments, for classifying it. */
fun stripComments(text: String, dialect: SqlDialect): String = stripSqlComments(text, dialect)

/**
 * [sql] with every comment, string and quoted identifier blanked out (same length), so a scan for keywords sees only
 * the statement's own words: `SET note = 'no where clause'` has no WHERE.
 */
fun maskSqlLiterals(sql: String, dialect: SqlDialect): String {
    val out = StringBuilder(sql.length)
    var i = 0
    while (i < sql.length) {
        val end = sqlTokenEnd(sql, i, dialect)?.first
        if (end == null) {
            out.append(sql[i])
            i++
        } else {
            repeat(end - i) { out.append(' ') }
            i = end
        }
    }
    return out.toString()
}

/** Why a statement can't be undone, for the warning before running it (Table Relay's analyze-destructive). */
data class DestructiveStatement(val sql: String, val kind: String, val detail: String)

private fun hasKeyword(upper: String, keyword: String): Boolean = Regex("(^|\\W)" + keyword + "(\\W|$)").containsMatchIn(upper)

/** The statements that change every row or drop something: DELETE/UPDATE without WHERE, TRUNCATE, DROP, ALTER … DROP. */
fun analyzeDestructive(sql: String, dialect: SqlDialect): List<DestructiveStatement> = splitSql(sql, dialect).mapNotNull { statement ->
    val upper = maskSqlLiterals(statement, dialect).trim().uppercase()
    when {
        upper.startsWith("DELETE") && !hasKeyword(upper, "WHERE") -> DestructiveStatement(statement, "DELETE", "DELETE without WHERE clause will affect all rows")
        upper.startsWith("UPDATE") && !hasKeyword(upper, "WHERE") -> DestructiveStatement(statement, "UPDATE", "UPDATE without WHERE clause will modify all rows")
        upper.startsWith("TRUNCATE") -> DestructiveStatement(statement, "TRUNCATE", "TRUNCATE will remove all rows from the table")
        upper.startsWith("DROP ") -> DestructiveStatement(statement, "DROP", "DROP ${upper.substring(5).trimStart().split(Regex("\\s+")).firstOrNull() ?: "object"} is irreversible")
        upper.startsWith("ALTER") && hasKeyword(upper, "DROP") -> DestructiveStatement(statement, "ALTER_DROP", "ALTER TABLE ... DROP is irreversible")
        else -> null
    }
}

private val READING = setOf("SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH", "PRAGMA", "VALUES", "TABLE", "USE", "SET", "HELP", "ANALYZE")

private val WRITING = listOf("INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "CALL", "DO", "COPY", "LOAD")

/** SET … that changes more than this session's harmless settings: server-wide, persisted, roles, or read-only mode itself. */
private val SET_NOT_READING = Regex(
    "\\b(GLOBAL|PERSIST|PERSIST_ONLY|ROLE|AUTHORIZATION|PASSWORD|READ\\s+WRITE|TRANSACTION_READ_ONLY|DEFAULT_TRANSACTION_READ_ONLY|TX_READ_ONLY|SQL_LOG_BIN)\\b|@@GLOBAL",
)

/**
 * Whether a statement only reads, for read-only connections (the server is also told to refuse writes; this is the
 * check before a statement is sent). Comments and string contents don't count: `SELECT 'DELETE'` reads.
 *
 * - `WITH` reads unless it holds a writing statement (a data-modifying CTE);
 * - `EXPLAIN ANALYZE` runs what it explains, so it reads only if that does;
 * - `SELECT … INTO` writes (a new table in PostgreSQL, a file in MySQL), except into MySQL @variables;
 * - `SET` reads when it only changes this session (not GLOBAL/PERSIST, roles, or the read-only mode);
 * - `PRAGMA x = y` writes.
 */
fun isReadOnlyStatement(statement: String, dialect: SqlDialect): Boolean {
    val upper = maskSqlLiterals(statement, dialect).trim().uppercase()
    val first = upper.split(Regex("[\\s(]+")).firstOrNull().orEmpty()
    if (first !in READING) return false
    val writes = WRITING.any { hasKeyword(upper, it) }
    return when (first) {
        "WITH" -> !writes
        "EXPLAIN", "DESCRIBE", "DESC" -> !(writes && (hasKeyword(upper, "ANALYZE") || hasKeyword(upper, "ANALYSE")))
        "SELECT", "VALUES", "TABLE" -> !(hasKeyword(upper, "INTO") && !Regex("\\bINTO\\s+@").containsMatchIn(upper))
        "SET" -> !SET_NOT_READING.containsMatchIn(upper)
        "PRAGMA" -> !upper.contains('=')
        else -> true
    }
}

/** Keywords for highlighting and completion. */
val SQL_KEYWORDS = listOf(
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "ILIKE", "BETWEEN", "EXISTS", "AS", "ON",
    "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL", "USING", "GROUP", "BY", "ORDER", "HAVING",
    "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
    "TABLE", "VIEW", "INDEX", "UNIQUE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DROP", "ALTER", "ADD", "COLUMN",
    "RENAME", "TO", "TRUNCATE", "DATABASE", "SCHEMA", "IF", "DEFAULT", "CHECK", "CONSTRAINT", "CASCADE", "RESTRICT",
    "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "WITH", "RECURSIVE", "RETURNING", "EXPLAIN", "ANALYZE",
    "SHOW", "DESCRIBE", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE", "TRUE", "FALSE", "COUNT",
    "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST", "NOW", "INTERVAL", "PRAGMA", "AUTO_INCREMENT", "SERIAL",
    "VARCHAR", "INT", "INTEGER", "BIGINT", "TEXT", "BOOLEAN", "DATE", "TIMESTAMP", "DECIMAL", "JSON", "JSONB",
)
