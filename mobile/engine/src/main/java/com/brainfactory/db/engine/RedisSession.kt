package com.brainfactory.db.engine

import java.io.IOException
import kotlin.concurrent.thread

/** A key in the key browser. [ttl] is seconds, -1 without expiry. */
data class RedisKey(val name: String, val type: String, val ttl: Long)

/** A key's value, read for the key view; [total] is the full length when only the first items were read. */
sealed interface RedisValue {
    val total: Long

    data class Str(val text: String, override val total: Long) : RedisValue
    data class ListV(val items: List<String>, override val total: Long) : RedisValue
    data class SetV(val members: List<String>, override val total: Long) : RedisValue
    data class ZSetV(val members: List<Pair<String, Double>>, override val total: Long) : RedisValue
    data class HashV(val fields: List<Pair<String, String>>, override val total: Long) : RedisValue
    data class StreamV(val entries: List<Pair<String, List<Pair<String, String>>>>, override val total: Long) : RedisValue
    data class Other(val type: String, val text: String, override val total: Long = 0) : RedisValue
}

/**
 * Redis 5+ (and Valkey, KeyDB, managed Redis with TLS), over its own RESP client. There are no tables: the
 * workspace shows a key browser instead, and the console runs redis-cli commands. [database] is the number SELECTed.
 */
class RedisSession(override val profile: ConnectionProfile, private val env: EngineEnv) : DbSession {

    override val capabilities = Capabilities(editRows = false, structure = false, realtime = "Pub/Sub")

    private var tunnel: SshTunnel? = null
    private var client: RespClient
    private var database: Int = profile.database.trim().removePrefix("db").toIntOrNull() ?: 0

    override val currentDatabase: String get() = "db$database"

    init {
        client = connect()
    }

    private fun endpoint(): Pair<String, Int> {
        val ssh = profile.ssh ?: return profile.host.ifBlank { "127.0.0.1" } to profile.port
        val t = tunnel?.takeIf { it.alive } ?: SshTunnel.open(ssh, profile.host.ifBlank { "127.0.0.1" }, profile.port, env.knownHosts).also { tunnel = it }
        return "127.0.0.1" to t.localPort
    }

    private fun connect(): RespClient {
        val (host, port) = endpoint()
        val c = try {
            RespClient(host, port, tls = profile.sslMode == SslMode.REQUIRED || profile.sslMode == SslMode.VERIFY_CA, verify = profile.sslMode == SslMode.VERIFY_CA)
        } catch (e: IOException) {
            throw DbException("Couldn't reach Redis at ${profile.host}:${profile.port}: ${e.message}", e)
        }
        try {
            if (profile.password.isNotEmpty()) {
                val auth = if (profile.user.isNotBlank() && profile.user != "default") c.command("AUTH", profile.user, profile.password) else c.command("AUTH", profile.password)
                if (auth is Resp.Error) throw DbException("Sign-in refused: ${auth.text}")
            }
            c.command("CLIENT", "SETNAME", "brain-db")
            if (database != 0) (c.command("SELECT", database) as? Resp.Error)?.let { throw DbException(it.text) }
            val pong = c.command("PING")
            if (pong is Resp.Error) throw DbException(if (pong.text.startsWith("NOAUTH")) "This Redis needs a password." else pong.text)
        } catch (e: Exception) {
            c.close()
            throw if (e is DbException) e else DbException(e.message ?: "Redis didn't answer.", e)
        }
        return c
    }

    /** Runs one command, reconnecting once when the socket was dropped while idle. */
    @Synchronized
    fun call(args: List<Any>): Resp = try {
        client.command(args)
    } catch (e: IOException) {
        client.close()
        client = connect()
        client.command(args)
    }

    private fun call(vararg args: Any) = call(args.toList())

    private fun checked(vararg args: Any): Resp = call(args.toList()).also { if (it is Resp.Error) throw DbException(it.text) }

    override fun close() {
        client.close()
        tunnel?.close()
    }

    override fun ping() {
        checked("PING")
    }

    override fun databases(): List<String> {
        val count = (call("CONFIG", "GET", "databases") as? Resp.Multi)?.items?.getOrNull(1)?.let { (it as? Resp.Bulk)?.text?.toIntOrNull() } ?: 16
        return (0 until count).map { "db$it" }
    }

    /** Keys per database, from INFO keyspace: "db0" → 1234. */
    fun keyspace(): Map<String, Long> {
        val info = (call("INFO", "keyspace") as? Resp.Bulk)?.text.orEmpty()
        return info.lines().mapNotNull { line ->
            val m = Regex("^(db\\d+):keys=(\\d+)").find(line.trim()) ?: return@mapNotNull null
            m.groupValues[1] to m.groupValues[2].toLong()
        }.toMap()
    }

    override fun useDatabase(name: String) {
        val n = name.removePrefix("db").toIntOrNull() ?: throw DbException("Not a Redis database: $name")
        checked("SELECT", n)
        database = n
    }

    override fun objects(): List<DbObject> = emptyList()

    override fun split(text: String): List<String> = text.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("//") }

    /** One SCAN step: the next cursor ("0" when done) and the keys found, with their types and TTLs. */
    @Synchronized
    fun scan(pattern: String, cursor: String, count: Int = 200, type: String? = null): Pair<String, List<RedisKey>> {
        val args = mutableListOf<Any>("SCAN", cursor, "MATCH", pattern.ifBlank { "*" }, "COUNT", count)
        if (type != null) { args += "TYPE"; args += type }
        val reply = checked(*args.toTypedArray()) as Resp.Multi
        val next = (reply.items!![0] as Resp.Bulk).text ?: "0"
        val names = (reply.items[1] as Resp.Multi).items.orEmpty().mapNotNull { (it as? Resp.Bulk)?.bytes }
        val meta = try {
            client.pipeline(names.flatMap { listOf(listOf<Any>("TYPE", it), listOf<Any>("TTL", it)) })
        } catch (e: IOException) {
            client.close(); client = connect(); emptyList()
        }
        val keys = names.mapIndexed { i, bytes ->
            RedisKey(decodeRedisText(bytes), (meta.getOrNull(i * 2) as? Resp.Simple)?.text ?: "?", (meta.getOrNull(i * 2 + 1) as? Resp.Integer)?.value ?: -1)
        }
        return next to keys
    }

    private fun strings(reply: Resp): List<String> = (reply as? Resp.Multi)?.items.orEmpty().map { (it as? Resp.Bulk)?.text ?: render(it) }

    private fun pairs(list: List<String>) = list.chunked(2).filter { it.size == 2 }.map { it[0] to it[1] }

    private fun length(vararg args: Any) = (call(*args) as? Resp.Integer)?.value ?: 0

    /** Reads [key]'s value, at most [limit] items of a collection. */
    fun value(key: String, limit: Int = 500): RedisValue {
        val type = (checked("TYPE", key) as Resp.Simple).text
        return when (type) {
            "string" -> {
                val bytes = (checked("GET", key) as Resp.Bulk).bytes ?: ByteArray(0)
                RedisValue.Str(decodeRedisText(bytes), bytes.size.toLong())
            }
            "list" -> RedisValue.ListV(strings(checked("LRANGE", key, 0, limit - 1)), length("LLEN", key))
            "set" -> RedisValue.SetV(strings(checked("SSCAN", key, 0, "COUNT", limit).let { (it as Resp.Multi).items!![1] }).take(limit).sorted(), length("SCARD", key))
            "zset" -> RedisValue.ZSetV(pairs(strings(checked("ZRANGE", key, 0, limit - 1, "WITHSCORES"))).map { it.first to (it.second.toDoubleOrNull() ?: 0.0) }, length("ZCARD", key))
            "hash" -> RedisValue.HashV(pairs(strings(checked("HSCAN", key, 0, "COUNT", limit).let { (it as Resp.Multi).items!![1] })).take(limit).sortedBy { it.first }, length("HLEN", key))
            "stream" -> {
                val entries = (checked("XRANGE", key, "-", "+", "COUNT", limit) as Resp.Multi).items.orEmpty().map { e ->
                    val parts = (e as Resp.Multi).items!!
                    (parts[0] as Resp.Bulk).text.orEmpty() to pairs(strings(parts[1]))
                }
                RedisValue.StreamV(entries, length("XLEN", key))
            }
            "none" -> throw DbException("The key $key no longer exists.")
            else -> RedisValue.Other(type, "Brain DB can't show $type values yet; use the console.")
        }
    }

    private fun write(vararg args: Any): Resp {
        profile.requireWritable()
        return checked(*args)
    }

    /** Sets a string, keeping the key's expiry. */
    fun setString(key: String, value: String) {
        val ttl = length("PTTL", key)
        if (ttl > 0) write("SET", key, value, "PX", ttl) else write("SET", key, value)
    }

    fun hashSet(key: String, field: String, value: String) { write("HSET", key, field, value) }
    fun hashDelete(key: String, field: String) { write("HDEL", key, field) }
    fun listPush(key: String, value: String, head: Boolean) { write(if (head) "LPUSH" else "RPUSH", key, value) }
    fun listSet(key: String, index: Long, value: String) { write("LSET", key, index, value) }

    /** Removes the item at [index]: LSET it to a marker no real item has, then LREM the marker. */
    fun listRemoveAt(key: String, index: Long) {
        val marker = "__brain_db_deleted_" + java.util.UUID.randomUUID()
        write("LSET", key, index, marker)
        write("LREM", key, 1, marker)
    }

    fun setAdd(key: String, member: String) { write("SADD", key, member) }
    fun setRemove(key: String, member: String) { write("SREM", key, member) }
    fun zsetAdd(key: String, member: String, score: Double) { write("ZADD", key, score.toString(), member) }
    fun zsetRemove(key: String, member: String) { write("ZREM", key, member) }
    fun streamAdd(key: String, fields: List<Pair<String, String>>) { write("XADD", key, "*", *fields.flatMap { listOf(it.first, it.second) }.toTypedArray()) }
    fun streamDelete(key: String, id: String) { write("XDEL", key, id) }
    fun delete(keys: List<String>) { if (keys.isNotEmpty()) write("DEL", *keys.toTypedArray()) }
    fun rename(key: String, newName: String) { write("RENAME", key, newName) }

    /** Sets the expiry in seconds; null removes it. */
    fun expire(key: String, seconds: Long?) { if (seconds == null) write("PERSIST", key) else write("EXPIRE", key, seconds) }

    fun ttl(key: String): Long = length("TTL", key)

    fun exists(key: String): Boolean = length("EXISTS", key) > 0

    override fun execute(text: String, maxRows: Int): List<StatementResult> {
        val out = mutableListOf<StatementResult>()
        for (line in split(text)) {
            val start = System.nanoTime()
            val result = try {
                val bytes = splitRedisArgBytes(line)
                if (bytes.isEmpty()) continue
                val args = bytes.map { String(it, Charsets.UTF_8) }
                val name = args[0].uppercase()
                if (profile.readOnly && !isReadingCommand(args)) throw DbException("This connection is read-only, so $name doesn't run.")
                if (name in BLOCKING) throw DbException("$name holds the connection; use the Pub/Sub tab to subscribe.")
                val reply = call(bytes)
                if (name == "SELECT" && reply !is Resp.Error) database = args.getOrNull(1)?.toIntOrNull() ?: database
                toResult(line, args, reply, maxRows)
            } catch (e: Exception) {
                StatementResult(line, error = e.message ?: e.javaClass.simpleName)
            }
            out += result.copy(millis = (System.nanoTime() - start) / 1_000_000)
            if (!result.ok) break
        }
        return out
    }

    /**
     * A reply as a result: INFO and CLIENT LIST as tables of their fields, flat field/value lists (HGETALL,
     * CONFIG GET, HRANDFIELD … WITHVALUES, Z…RANGE … WITHSCORES) as two columns, anything else as redis-cli shows it.
     */
    private fun toResult(line: String, args: List<String>, reply: Resp, maxRows: Int): StatementResult {
        val name = args.firstOrNull()?.uppercase().orEmpty()
        val sub = args.getOrNull(1)?.uppercase().orEmpty()
        val text = (reply as? Resp.Bulk)?.text
        if (name == "INFO" && text != null) return StatementResult(line, table = infoTable(text))
        if (name == "CLIENT" && sub == "LIST" && text != null) return StatementResult(line, table = clientTable(text))
        val items = (reply as? Resp.Multi)?.items
        if (items != null && items.size % 2 == 0 && items.isNotEmpty()) {
            val withFlag = { flag: String -> args.any { it.equals(flag, ignoreCase = true) } }
            val headers = when {
                name == "HGETALL" -> "field" to "value"
                name == "CONFIG" && sub == "GET" -> "parameter" to "value"
                name == "HRANDFIELD" && withFlag("WITHVALUES") -> "field" to "value"
                name.startsWith("Z") && withFlag("WITHSCORES") -> "member" to "score"
                else -> null
            }
            if (headers != null) {
                val rows = items.chunked(2).take(maxRows).map { (a, b) -> listOf(plain(a), plain(b)) }
                return StatementResult(line, table = ResultTable(listOf(ColumnMeta(headers.first), ColumnMeta(headers.second)), rows, truncated = items.size / 2 > maxRows))
            }
        }
        return plainResult(line, reply, maxRows)
    }

    private fun plain(r: Resp): String = (r as? Resp.Bulk)?.text ?: render(r)

    /** INFO's "# Section" headings and "field:value" lines. */
    private fun infoTable(text: String): ResultTable {
        var section = ""
        val rows = mutableListOf<List<Any?>>()
        for (raw in text.lines()) {
            val l = raw.trim()
            when {
                l.isEmpty() -> Unit
                l.startsWith("#") -> section = l.removePrefix("#").trim()
                else -> l.indexOf(':').takeIf { it > 0 }?.let { rows += listOf(section, l.substring(0, it), l.substring(it + 1)) }
            }
        }
        return ResultTable(listOf(ColumnMeta("section"), ColumnMeta("field"), ColumnMeta("value")), rows)
    }

    /** CLIENT LIST's lines of name=value pairs, a client per row. */
    private fun clientTable(text: String): ResultTable {
        val entries = text.lines().filter { it.isNotBlank() }.map { line ->
            line.trim().split(' ').mapNotNull { part -> part.indexOf('=').takeIf { it > 0 }?.let { part.substring(0, it) to part.substring(it + 1) } }
        }
        val columns = LinkedHashSet<String>().apply { entries.forEach { e -> e.forEach { add(it.first) } } }.toList()
        return ResultTable(columns.map { ColumnMeta(it) }, entries.map { e -> val m = e.toMap(); columns.map { m[it] } })
    }

    private fun plainResult(line: String, reply: Resp, maxRows: Int): StatementResult = when (reply) {
        is Resp.Error -> StatementResult(line, error = reply.text)
        is Resp.Simple -> StatementResult(line, message = reply.text)
        is Resp.Integer -> StatementResult(line, message = "(integer) ${reply.value}")
        is Resp.Bulk -> if (reply.bytes == null) StatementResult(line, message = "(nil)")
            else StatementResult(line, table = ResultTable(listOf(ColumnMeta("value")), listOf(listOf(reply.text))))
        is Resp.Multi -> {
            val items = reply.items
            if (items == null) StatementResult(line, message = "(nil)")
            else if (items.isEmpty()) StatementResult(line, message = "(empty array)")
            else StatementResult(
                line,
                table = ResultTable(
                    listOf(ColumnMeta("#"), ColumnMeta("value")),
                    items.take(maxRows).mapIndexed { i, r -> listOf((i + 1).toLong(), if (r is Resp.Multi) JsonText(render(r)) else (r as? Resp.Bulk)?.text ?: render(r)) },
                    truncated = items.size > maxRows,
                ),
            )
        }
    }

    /** A reply as redis-cli-like text; nested arrays as JSON arrays. */
    private fun render(r: Resp): String = when (r) {
        is Resp.Simple -> r.text
        is Resp.Error -> "(error) " + r.text
        is Resp.Integer -> r.value.toString()
        is Resp.Bulk -> r.text ?: "(nil)"
        is Resp.Multi -> r.items?.let { items -> org.json.JSONArray(items.map { if (it is Resp.Integer) it.value else render(it) }).toString() } ?: "(nil)"
    }

    override fun browse(table: TableRef, request: BrowseRequest): BrowsePage = throw DbException("Redis keys are browsed in the key browser.")
    override fun count(table: TableRef, request: BrowseRequest): Long? = length("DBSIZE")
    override fun structure(table: TableRef): TableStructure = throw DbException("Redis keys have no structure.")
    override fun updateCell(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): String = throw DbException("Edit Redis values in the key view.")
    override fun insertRow(table: TableRef, values: Map<String, CellInput>): String = throw DbException("Add Redis keys in the key browser.")
    override fun deleteRows(table: TableRef, keys: List<Map<String, Any?>>): String = throw DbException("Delete Redis keys in the key browser.")

    override fun processList(): ResultTable {
        val text = (checked("CLIENT", "LIST") as Resp.Bulk).text.orEmpty()
        val entries = text.lines().filter { it.isNotBlank() }.map { line ->
            line.trim().split(' ').mapNotNull { part -> part.indexOf('=').takeIf { it > 0 }?.let { part.substring(0, it) to part.substring(it + 1) } }
        }
        val wanted = listOf("id", "addr", "name", "age", "idle", "db", "cmd", "user", "flags")
        val columns = wanted.filter { w -> entries.any { e -> e.any { it.first == w } } }
        return ResultTable(columns.map { ColumnMeta(it) }, entries.map { e -> val m = e.toMap(); columns.map { m[it] } })
    }

    override fun processKill(id: Any?) {
        write("CLIENT", "KILL", "ID", id?.toString() ?: throw DbException("No client id."))
    }

    override fun openRealtime(): RealtimeChannel = PubSub()

    /** SUBSCRIBE / PSUBSCRIBE on a connection of its own (a subscribed connection can't run other commands). */
    private inner class PubSub : RealtimeChannel {
        private val sub = connect()
        @Volatile private var running = true
        override val targetLabel = "Channel or pattern"
        override val canPublish = true

        private fun isPattern(target: String) = target.any { it == '*' || it == '?' || it == '[' }

        override fun subscribe(target: String) {
            synchronized(sub) { sub.send(listOf(if (isPattern(target)) "PSUBSCRIBE" else "SUBSCRIBE", target)); sub.flush() }
        }

        override fun unsubscribe(target: String) {
            synchronized(sub) { sub.send(listOf(if (isPattern(target)) "PUNSUBSCRIBE" else "UNSUBSCRIBE", target)); sub.flush() }
        }

        override fun publish(target: String, payload: String) {
            profile.requireWritable()
            checked("PUBLISH", target, payload)
        }

        override fun start(onMessage: (RealtimeMessage) -> Unit, onError: (String) -> Unit) {
            sub.readTimeout = 0
            thread(name = "redis-pubsub", isDaemon = true) {
                try {
                    while (running) {
                        val items = (sub.read() as? Resp.Multi)?.items ?: continue
                        val kind = (items.firstOrNull() as? Resp.Bulk)?.text
                        when (kind) {
                            "message" -> onMessage(RealtimeMessage((items[1] as Resp.Bulk).text.orEmpty(), (items[2] as Resp.Bulk).text.orEmpty()))
                            "pmessage" -> onMessage(RealtimeMessage((items[2] as Resp.Bulk).text.orEmpty(), (items[3] as Resp.Bulk).text.orEmpty()))
                        }
                    }
                } catch (e: Exception) {
                    if (running) onError(e.message ?: "The Pub/Sub connection closed.")
                }
            }
        }

        override fun close() {
            running = false
            sub.close()
        }
    }

    companion object {
        /** Whether a console command only reads: a reading command, or a reading subcommand (CONFIG GET, CLIENT LIST…). */
        fun isReadingCommand(args: List<String>): Boolean {
            val name = args.firstOrNull()?.uppercase() ?: return true
            val sub = args.getOrNull(1)?.uppercase().orEmpty()
            return name in REDIS_READING || (name to sub) in READING_SUBCOMMANDS
        }

        private val READING_SUBCOMMANDS = setOf(
            "CONFIG" to "GET", "CLIENT" to "LIST", "CLIENT" to "GETNAME", "CLIENT" to "INFO", "CLIENT" to "ID",
            "SLOWLOG" to "GET", "SLOWLOG" to "LEN", "ACL" to "WHOAMI", "ACL" to "LIST", "ACL" to "USERS", "MODULE" to "LIST",
            "FUNCTION" to "LIST", "SCRIPT" to "EXISTS", "CLUSTER" to "INFO", "CLUSTER" to "NODES",
        )

        /** Commands that only read, for read-only connections. */
        val REDIS_READING = setOf(
            "GET", "MGET", "STRLEN", "GETRANGE", "EXISTS", "TYPE", "TTL", "PTTL", "KEYS", "SCAN", "HGET", "HGETALL", "HMGET",
            "HKEYS", "HVALS", "HLEN", "HSCAN", "HEXISTS", "HSTRLEN", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD",
            "SISMEMBER", "SMISMEMBER", "SSCAN", "SRANDMEMBER", "SINTER", "SUNION", "SDIFF", "ZRANGE", "ZREVRANGE",
            "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX", "ZCARD", "ZSCORE", "ZMSCORE", "ZSCAN", "ZRANK", "ZREVRANK",
            "ZCOUNT", "XRANGE", "XREVRANGE", "XLEN", "XINFO", "XREAD", "INFO", "PING", "DBSIZE", "TIME", "ECHO", "SELECT",
            "RANDOMKEY", "MEMORY", "OBJECT", "DUMP", "BITCOUNT", "GETBIT", "PFCOUNT", "GEOPOS", "GEODIST", "GEOSEARCH",
            "JSON.GET", "JSON.TYPE", "LASTSAVE", "ROLE", "COMMAND", "SLOWLOG", "LATENCY",
        )

        /** Commands that would hold the console's connection. */
        private val BLOCKING = setOf("SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR", "BLPOP", "BRPOP", "BLMOVE", "BZPOPMIN", "BZPOPMAX", "XREADGROUP")

        /** Commands that wipe data, for the warning before running. */
        val REDIS_DESTRUCTIVE = mapOf("FLUSHDB" to "FLUSHDB deletes every key in this database", "FLUSHALL" to "FLUSHALL deletes every key in every database", "SHUTDOWN" to "SHUTDOWN stops the Redis server")
    }
}

/** The Redis console lines that wipe data. */
fun analyzeRedisDestructive(text: String): List<DestructiveStatement> = text.lines().mapNotNull { line ->
    val name = runCatching { splitRedisArgs(line.trim()).firstOrNull()?.uppercase() }.getOrNull() ?: return@mapNotNull null
    RedisSession.REDIS_DESTRUCTIVE[name]?.let { DestructiveStatement(line.trim(), name, it) }
}
