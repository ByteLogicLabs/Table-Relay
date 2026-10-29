package com.brainfactory.db.engine

/** A call in a chain: `.sort({a: 1})` is ("sort", ["{a: 1}"]). Arguments stay text until the command runs. */
data class ShellCall(val name: String, val args: List<String>)

/** A line of mongosh, as far as Brain DB runs it. */
sealed interface ShellCommand {
    val text: String

    data class Show(val what: String, override val text: String) : ShellCommand
    data class Use(val database: String, override val text: String) : ShellCommand
    /** `db.runCommand(…)`, `db.getCollectionNames()`; [database] is set by `db.getSiblingDB("x")`. */
    data class OnDatabase(val database: String?, val call: ShellCall, override val text: String) : ShellCommand
    /** `db.users.find({…}).sort({…}).limit(5)`: [call] is `find`, [chain] the rest. */
    data class OnCollection(val database: String?, val collection: String, val call: ShellCall, val chain: List<ShellCall>, override val text: String) : ShellCommand
}

/**
 * Splits mongosh text into commands: on `;` outside quotes and brackets, and on a new line that starts another
 * `db.` / `show` / `use` command, since shell users rarely end lines with `;`. `//` comments are dropped.
 */
fun splitShell(text: String): List<String> {
    val out = mutableListOf<String>()
    val current = StringBuilder()
    var depth = 0
    var quote: Char? = null
    var i = 0
    fun flush() {
        val s = current.toString().trim()
        if (s.isNotEmpty()) out += s
        current.clear()
    }
    while (i < text.length) {
        val c = text[i]
        if (quote != null) {
            current.append(c)
            if (c == '\\' && i + 1 < text.length) { current.append(text[i + 1]); i += 2; continue }
            if (c == quote) quote = null
            i++
            continue
        }
        when {
            c == '"' || c == '\'' || c == '`' -> { quote = c; current.append(c) }
            c == '/' && i + 1 < text.length && text[i + 1] == '/' -> {
                i = text.indexOf('\n', i).let { if (it < 0) text.length else it }
                continue
            }
            c == '(' || c == '{' || c == '[' -> { depth++; current.append(c) }
            c == ')' || c == '}' || c == ']' -> { depth--; current.append(c) }
            c == ';' && depth <= 0 -> flush()
            c == '\n' && depth <= 0 -> {
                val rest = text.substring(i + 1).trimStart()
                if (rest.startsWith("db.") || rest.startsWith("db[") || rest.startsWith("show ") || rest.startsWith("use ")) flush() else current.append(c)
            }
            else -> current.append(c)
        }
        i++
    }
    flush()
    return out
}

/** Splits an argument list on top-level commas. */
fun splitArgs(text: String): List<String> {
    val out = mutableListOf<String>()
    val current = StringBuilder()
    var depth = 0
    var quote: Char? = null
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (quote != null) {
            current.append(c)
            if (c == '\\' && i + 1 < text.length) { current.append(text[i + 1]); i += 2; continue }
            if (c == quote) quote = null
        } else when (c) {
            '"', '\'' -> { quote = c; current.append(c) }
            '(', '{', '[' -> { depth++; current.append(c) }
            ')', '}', ']' -> { depth--; current.append(c) }
            ',' -> if (depth == 0) { out += current.toString().trim(); current.clear() } else current.append(c)
            else -> current.append(c)
        }
        i++
    }
    if (current.isNotBlank()) out += current.toString().trim()
    return out
}

/** Parses one command from [splitShell]; throws [DbException] with what wasn't understood. */
fun parseShell(command: String): ShellCommand {
    val text = command.trim().removeSuffix(";").trim()
    Regex("^show\\s+(\\w+)$", RegexOption.IGNORE_CASE).find(text)?.let { return ShellCommand.Show(it.groupValues[1].lowercase(), text) }
    Regex("^use\\s+(\\S+)$", RegexOption.IGNORE_CASE).find(text)?.let { return ShellCommand.Use(it.groupValues[1].trim('"', '\''), text) }
    // The replica set helpers mongosh has: rs.status(), rs.conf()
    Regex("^rs\\.(\\w+)\\s*\\((.*)\\)$", RegexOption.DOT_MATCHES_ALL).find(text)?.let {
        return ShellCommand.OnDatabase("admin", ShellCall("rs." + it.groupValues[1], splitArgs(it.groupValues[2])), text)
    }
    if (!text.startsWith("db")) throw DbException("Commands start with db., rs., show or use, as in mongosh: db.users.find({ age: { \$gt: 30 } })")

    val p = Parser(text)
    p.expect("db")
    var database: String? = null
    var collection: String? = null
    val calls = mutableListOf<ShellCall>()
    while (!p.done()) {
        p.skipSpace()
        when {
            p.peek('.') -> {
                p.next()
                p.skipSpace()
                val name = p.identifier()
                p.skipSpace()
                if (p.peek('(')) {
                    val args = splitArgs(p.parens())
                    when {
                        calls.isEmpty() && collection == null && name == "getSiblingDB" -> database = unquote(args.firstOrNull() ?: throw DbException("getSiblingDB needs a database name."))
                        calls.isEmpty() && collection == null && name == "getCollection" -> collection = unquote(args.firstOrNull() ?: throw DbException("getCollection needs a collection name."))
                        else -> calls += ShellCall(name, args)
                    }
                } else if (calls.isEmpty() && collection == null) {
                    collection = name
                } else if (calls.isEmpty()) {
                    // db.system.users: a dotted collection name
                    collection = "$collection.$name"
                } else throw DbException("Expected a call after .$name, as in .$name(…)")
            }
            p.peek('[') -> {
                val inner = p.brackets()
                if (calls.isNotEmpty() || collection != null) throw DbException("Unexpected [ in the command.")
                collection = unquote(inner)
            }
            else -> throw DbException("Couldn't read the command near: " + text.substring(p.pos).take(30))
        }
    }
    if (calls.isEmpty()) throw DbException("Nothing to run: add a method, as in db.${collection ?: "collection"}.find()")
    return if (collection == null) ShellCommand.OnDatabase(database, calls.first(), text).also {
        if (calls.size > 1) throw DbException("db.${calls.first().name}() can't be chained.")
    } else ShellCommand.OnCollection(database, collection, calls.first(), calls.drop(1), text)
}

private fun unquote(s: String): String = s.trim().removeSurrounding("\"").removeSurrounding("'").removeSurrounding("`")

private class Parser(val text: String) {
    var pos = 0
    fun done() = pos >= text.length
    fun peek(c: Char) = pos < text.length && text[pos] == c
    fun next() = text[pos++]
    fun skipSpace() { while (pos < text.length && text[pos].isWhitespace()) pos++ }
    fun expect(word: String) {
        if (!text.startsWith(word, pos)) throw DbException("Expected $word")
        pos += word.length
    }
    fun identifier(): String {
        val start = pos
        while (pos < text.length && (text[pos].isLetterOrDigit() || text[pos] == '_' || text[pos] == '$' || text[pos] == '-')) pos++
        if (start == pos) throw DbException("Expected a name after the dot.")
        return text.substring(start, pos)
    }
    /** The text between the parentheses at [pos], which is consumed. */
    fun parens(): String = enclosed('(', ')')
    fun brackets(): String = enclosed('[', ']')
    private fun enclosed(open: Char, close: Char): String {
        if (!peek(open)) throw DbException("Expected $open")
        var depth = 0
        var quote: Char? = null
        val start = pos + 1
        while (pos < text.length) {
            val c = text[pos]
            if (quote != null) {
                if (c == '\\') pos++ else if (c == quote) quote = null
            } else when (c) {
                '"', '\'' -> quote = c
                '(', '{', '[' -> depth++
                ')', '}', ']' -> {
                    depth--
                    if (depth == 0) {
                        if (c != close) throw DbException("Mismatched $c")
                        pos++
                        return text.substring(start, pos - 1)
                    }
                }
            }
            pos++
        }
        throw DbException("Missing $close")
    }
}

/** Shell methods that only read, for read-only connections. */
val MONGO_READING = setOf(
    "find", "findOne", "countDocuments", "estimatedDocumentCount", "count", "distinct", "aggregate", "getIndexes",
    "stats", "getCollectionNames", "listCollections", "getName", "dataSize", "storageSize", "totalIndexSize", "explain",
    "serverStatus", "version", "hostInfo", "buildInfo", "hello", "isMaster", "getCollectionInfos", "getUsers",
    "currentOp", "rs.status", "rs.conf",
)

/** Mongo commands that can't be undone: drop, dropDatabase, deleteMany({}), updateMany({} …). */
fun analyzeMongoDestructive(text: String): List<DestructiveStatement> = splitShell(text).mapNotNull { line ->
    val command = runCatching { parseShell(line) }.getOrNull() ?: return@mapNotNull null
    when (command) {
        is ShellCommand.OnDatabase -> if (command.call.name == "dropDatabase") DestructiveStatement(line, "DROP", "dropDatabase deletes the whole database") else null
        is ShellCommand.OnCollection -> {
            val first = command.call.args.firstOrNull()?.replace(Regex("\\s"), "")
            when (command.call.name) {
                "drop" -> DestructiveStatement(line, "DROP", "drop deletes the collection ${command.collection}")
                "deleteMany", "remove" -> if (first == null || first == "{}") DestructiveStatement(line, "DELETE", "deleteMany({}) deletes every document") else null
                "updateMany" -> if (first == "{}") DestructiveStatement(line, "UPDATE", "updateMany({}) changes every document") else null
                "dropIndexes" -> DestructiveStatement(line, "DROP", "dropIndexes removes the collection's indexes")
                else -> null
            }
        }
        else -> null
    }
}
