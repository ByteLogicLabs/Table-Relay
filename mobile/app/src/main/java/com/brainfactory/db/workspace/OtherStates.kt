package com.brainfactory.db.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.brainfactory.db.engine.RealtimeChannel
import com.brainfactory.db.engine.RealtimeMessage
import com.brainfactory.db.engine.RedisKey
import com.brainfactory.db.engine.RedisSession
import com.brainfactory.db.engine.RedisValue
import com.brainfactory.db.engine.ResultTable
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Runs [block]; null when it worked, else its error, for the dialogs that show it. */
internal suspend fun attempt(block: suspend () -> Unit): String? = try {
    block()
    null
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    e.message ?: e.javaClass.simpleName
}

/** The process list (MySQL processlist, pg_stat_activity, Mongo currentOp, Redis CLIENT LIST), optionally refreshing itself. */
class ProcessState(private val ws: Workspace) {
    var table by mutableStateOf<ResultTable?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var auto by mutableStateOf(false)
        private set
    private var autoJob: Job? = null

    fun load() {
        ws.scope.launch {
            loading = true
            error = attempt { table = ws.call { it.processList() } }
            loading = false
        }
    }

    fun toggleAuto() {
        auto = !auto
        autoJob?.cancel()
        if (auto) autoJob = ws.scope.launch {
            while (isActive) {
                error = attempt { table = ws.call { it.processList() } }
                delay(2000)
            }
        }
    }

    fun stop() {
        autoJob?.cancel()
        auto = false
    }

    suspend fun kill(id: Any?): String? = attempt {
        ws.call(read = false) { it.processKill(id) }
        ws.logStatement("kill $id", 0, null, "processes")
        table = ws.call { it.processList() }
    }
}

/** LISTEN/NOTIFY, Pub/Sub or change streams: subscriptions, the messages that arrived, and publishing. */
class RealtimeState(private val ws: Workspace) {
    var channel by mutableStateOf<RealtimeChannel?>(null)
        private set
    var connecting by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    val subscriptions = mutableStateListOf<String>()
    val messages = mutableStateListOf<RealtimeMessage>()
    var paused by mutableStateOf(false)

    suspend fun ensureOpen(): RealtimeChannel {
        channel?.let { return it }
        connecting = true
        try {
            val c = ws.call { it.openRealtime() }
            c.start(
                onMessage = { m -> ws.scope.launch { if (!paused) { messages.add(0, m); if (messages.size > 500) messages.removeRange(500, messages.size) } } },
                onError = { e -> ws.scope.launch { dropped(c, e) } },
            )
            channel = c
            return c
        } finally {
            connecting = false
        }
    }

    /**
     * The channel's connection broke (the server restarted, the network changed): open a new one and subscribe to
     * the same channels again, a few times with a pause between, as the workspace's own reconnects do.
     */
    private suspend fun dropped(broken: RealtimeChannel, reason: String) {
        if (channel !== broken) return
        channel = null
        withContext(Dispatchers.IO) { runCatching { broken.close() } }
        for (round in 1..3) {
            error = "Reconnecting ($reason)…"
            delay(1500L * round)
            val failure = attempt {
                val c = ensureOpen()
                subscriptions.toList().forEach { t -> withContext(Dispatchers.IO) { c.subscribe(t) } }
            }
            if (failure == null) {
                error = null
                return
            }
            channel?.let { c -> channel = null; withContext(Dispatchers.IO) { runCatching { c.close() } } }
        }
        error = "The connection dropped ($reason) and couldn't be restored. Subscribe again to retry."
        subscriptions.clear()
    }

    fun subscribe(target: String) {
        val t = target.trim()
        if (t.isEmpty() || t in subscriptions) return
        ws.scope.launch {
            error = attempt {
                val c = ensureOpen()
                withContext(Dispatchers.IO) { c.subscribe(t) }
                subscriptions += t
            }
        }
    }

    fun unsubscribe(target: String) {
        val c = channel ?: return
        ws.scope.launch {
            error = attempt { withContext(Dispatchers.IO) { c.unsubscribe(target) } }
            subscriptions.remove(target)
        }
    }

    suspend fun publish(target: String, payload: String): String? = attempt {
        val c = ensureOpen()
        withContext(Dispatchers.IO) { c.publish(target.trim(), payload) }
    }

    fun close() {
        val c = channel ?: return
        channel = null
        subscriptions.clear()
        ws.scope.launch(Dispatchers.IO) { runCatching { c.close() } }
    }
}

/** The Redis key browser: SCAN with a pattern (and a type), page by page, plus each database's key count. */
class RedisBrowserState(private val ws: Workspace) {
    var pattern by mutableStateOf("*")
    var type by mutableStateOf<String?>(null)
    val keys = mutableStateListOf<RedisKey>()
    private var cursor = "0"
    var hasMore by mutableStateOf(false)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    val keyspace = mutableStateMapOf<String, Long>()

    suspend fun loadKeyspace() {
        runCatching { ws.redis { it.keyspace() } }.getOrNull()?.let { keyspace.clear(); keyspace.putAll(it) }
    }

    suspend fun reload() {
        cursor = "0"
        keys.clear()
        loadMore()
    }

    /** SCAN until a page of keys is found or the keyspace ends (a sparse pattern may need many steps). */
    suspend fun loadMore() {
        if (loading) return
        loading = true
        error = attempt {
            var found = 0
            var steps = 0
            do {
                val (next, page) = ws.redis { it.scan(pattern, cursor, 500, type) }
                cursor = next
                val known = keys.map { it.name }.toSet()
                val fresh = page.filter { it.name !in known }
                keys.addAll(fresh)
                found += fresh.size
                steps++
            } while (cursor != "0" && found < 100 && steps < 40)
            hasMore = cursor != "0"
            keys.sortBy { it.name }
        }
        loading = false
    }

    fun refresh() {
        ws.scope.launch {
            reload()
            loadKeyspace()
        }
    }

    suspend fun create(name: String, type: String, first: String, second: String, ttl: Long?): String? = attempt {
        ws.redis(read = false) { r ->
            if (r.exists(name)) throw com.brainfactory.db.engine.DbException("The key $name already exists.")
            when (type) {
                "string" -> r.setString(name, first)
                "hash" -> r.hashSet(name, first.ifBlank { "field" }, second)
                "list" -> r.listPush(name, first, head = false)
                "set" -> r.setAdd(name, first)
                "zset" -> r.zsetAdd(name, first, second.toDoubleOrNull() ?: 0.0)
                "stream" -> r.streamAdd(name, listOf(first.ifBlank { "field" } to second))
            }
            if (ttl != null && ttl > 0) r.expire(name, ttl)
        }
        ws.logStatement("create $type $name", 0, null, "keys")
        reload()
        loadKeyspace()
    }

    suspend fun delete(names: List<String>): String? = attempt {
        ws.redis(read = false) { it.delete(names) }
        ws.logStatement("DEL " + names.joinToString(" "), 0, null, "keys")
        keys.removeAll { it.name in names }
        ws.closeTabsFor { tab -> tab is WorkTab.RedisKey && tab.key in names }
        loadKeyspace()
    }
}

/** One Redis key's tab: its value by type, its TTL, and the edits each type allows. */
class RedisKeyState(private val ws: Workspace, var key: String) {
    var value by mutableStateOf<RedisValue?>(null)
        private set
    var ttl by mutableStateOf(-1L)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    fun load() {
        ws.scope.launch {
            loading = true
            error = attempt {
                val (v, t) = ws.redis { it.value(key) to it.ttl(key) }
                value = v
                ttl = t
            }
            loading = false
        }
    }

    /** Runs an edit, logs it, and reads the value again. */
    suspend fun edit(description: String, block: (RedisSession) -> Unit): String? = attempt {
        ws.redis(read = false, block)
        ws.logStatement(description, 0, null, "keys")
        val (v, t) = ws.redis { it.value(key) to it.ttl(key) }
        value = v
        ttl = t
    }

    suspend fun rename(newName: String): String? = attempt {
        ws.redis(read = false) { it.rename(key, newName) }
        ws.logStatement("RENAME $key $newName", 0, null, "keys")
        key = newName
        ws.redisKeys?.reload()
        load()
    }
}
