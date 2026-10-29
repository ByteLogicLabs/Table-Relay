package com.brainfactory.db.engine

/**
 * Auto-paging for the query editor, as Table Relay's query-paging.ts does it (TablePlus-style): a plain SELECT with
 * no LIMIT of its own is run a page at a time, so a big table doesn't arrive all at once. One row more than the
 * page is fetched to tell whether a next page exists without a COUNT.
 *
 * A statement is pageable when it is a single SELECT (or WITH … SELECT), and has no LIMIT / OFFSET / FETCH FIRST of
 * its own, no locking clause (FOR UPDATE / SHARE, LOCK IN SHARE MODE) and no INTO. Keywords inside strings and
 * comments don't count. Returns the statement to page (comments and the trailing `;` removed), or null.
 */
fun pageableSelect(payload: String, dialect: SqlDialect): String? {
    val statements = splitSql(payload, dialect)
    if (statements.size != 1) return null
    val stmt = stripSqlComments(statements.single(), dialect).trim().removeSuffix(";").trim()
    val masked = maskSqlLiterals(stmt, dialect)
    if (!Regex("^(select|with)\\b", RegexOption.IGNORE_CASE).containsMatchIn(masked)) return null
    if (NOT_PAGEABLE.containsMatchIn(masked)) return null
    // WITH … must feed a SELECT, not a data-modifying statement.
    if (!isReadOnlyStatement(stmt, dialect) && masked.trimStart().startsWith("with", ignoreCase = true)) return null
    return stmt
}

private val NOT_PAGEABLE = Regex(
    "\\b(limit|offset|into)\\b|\\bfetch\\s+(first|next)\\b|\\bfor\\s+(update|share|no\\s+key\\s+update|key\\s+share)\\b|\\block\\s+in\\s+share\\s+mode\\b",
    RegexOption.IGNORE_CASE,
)

/** [stmt] (from [pageableSelect]) for page [page] (0-based) of [pageSize] rows, plus the one row that tells there's more. */
fun pagedSql(stmt: String, page: Int, pageSize: Int): String = "$stmt LIMIT ${pageSize + 1} OFFSET ${page.toLong() * pageSize}"

/**
 * The same for the Mongo shell: a single `db.c.find(…)` (with `.sort()` or `.projection()` at most) is pageable;
 * one with its own `.limit()`, `.skip()`, `.count()` or `.explain()` isn't. Returns the command, or null.
 */
fun pageableFind(payload: String): String? {
    val commands = splitShell(payload)
    if (commands.size != 1) return null
    val command = runCatching { parseShell(commands.single()) }.getOrNull() as? ShellCommand.OnCollection ?: return null
    if (command.call.name != "find") return null
    if (command.chain.any { it.name !in setOf("sort", "projection", "project", "pretty", "toArray") }) return null
    return command.text
}

fun pagedFind(command: String, page: Int, pageSize: Int): String =
    command.trim().removeSuffix(";") + ".skip(${page.toLong() * pageSize}).limit(${pageSize + 1})"
