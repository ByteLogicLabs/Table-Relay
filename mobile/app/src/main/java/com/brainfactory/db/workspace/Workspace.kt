package com.brainfactory.db.workspace

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.brainfactory.db.data.QueryHistory
import com.brainfactory.db.engine.Capabilities
import com.brainfactory.db.engine.ConnectionProfile
import com.brainfactory.db.engine.DbException
import com.brainfactory.db.engine.DbObject
import com.brainfactory.db.engine.DbSession
import com.brainfactory.db.engine.EngineEnv
import com.brainfactory.db.engine.ObjectKind
import com.brainfactory.db.engine.RedisSession
import com.brainfactory.db.engine.TableRef
import com.brainfactory.db.engine.openSession
import com.brainfactory.db.server.LocalServers
import java.io.IOException
import java.sql.SQLNonTransientConnectionException
import java.sql.SQLRecoverableException
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A statement the workspace ran, for the query log (the desktop's Query Log panel). */
data class LogEntry(val statement: String, val millis: Long, val error: String?, val source: String, val time: Long = System.currentTimeMillis())

/** An open tab in the workspace. */
sealed class WorkTab(val id: String) {
    abstract val title: String

    class Table(val ref: TableRef, val state: TableState) : WorkTab(idFor(ref)) {
        override val title get() = ref.display

        companion object {
            fun idFor(ref: TableRef) = "table:${ref.database}:${ref.schema}:${ref.name}"
        }
    }

    class Query(val state: QueryState, number: Int) : WorkTab("query:" + UUID.randomUUID()) {
        override val title = if (number == 1) "Query" else "Query $number"
    }

    class Definition(val obj: DbObject, val text: String) : WorkTab("def:${obj.kind}:${obj.schema}:${obj.name}") {
        override val title get() = obj.name
    }

    class Processes(val state: ProcessState) : WorkTab("processes") {
        override val title = "Processes"
    }

    class Log : WorkTab("log") {
        override val title = "Query log"
    }

    class Realtime(val state: RealtimeState) : WorkTab("realtime") {
        override val title = "Realtime"
    }

    class RedisKey(val key: String, val state: RedisKeyState) : WorkTab("redis:$key") {
        override val title get() = key
    }
}

/**
 * One open connection: its session (opened, kept alive and rebuilt when it drops, like Table Relay's reconnect
 * supervisor), what the sidebar lists, the open tabs and the query log. Database calls run one at a time on a
 * thread of their own; the state they change is Compose state, read by the screens.
 */
class Workspace(val profile: ConnectionProfile, private val env: EngineEnv, val history: QueryHistory) {

    sealed interface Status {
        data object Connecting : Status
        data object Ready : Status
        data object Reconnecting : Status
        data class Failed(val message: String) : Status
    }

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /**
     * The session's calls run on one thread of their own, always the same: Android's SQLite keeps a transaction
     * (BEGIN … COMMIT run as separate queries) with the thread that began it, and would wait forever on another.
     */
    private val dbThread = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "db-" + profile.driver.name.lowercase()).apply { isDaemon = true } }
    private val db = dbThread.asCoroutineDispatcher()
    private var session: DbSession? = null
    private var lastUse = 0L

    var status by mutableStateOf<Status>(Status.Connecting)
        private set
    var capabilities by mutableStateOf(Capabilities())
        private set
    var databases by mutableStateOf<List<String>>(emptyList())
        private set
    var currentDatabase by mutableStateOf<String?>(null)
        private set
    var objects by mutableStateOf<List<DbObject>>(emptyList())
        private set
    var objectsLoading by mutableStateOf(false)
        private set
    var objectsError by mutableStateOf<String?>(null)
        private set
    /** The database picker is open. */
    var pickingDatabase by mutableStateOf(false)
    /** A message for the snackbar: a statement that ran, an error, a reconnect. */
    var notice by mutableStateOf<String?>(null)

    /** From Settings, when the workspace opens: rows per grid page and the most rows a query result keeps. */
    var pageSize = 100
    var maxResultRows = 5000

    val tabs = mutableStateListOf<WorkTab>()
    var activeTabId by mutableStateOf<String?>(null)
    val log = mutableStateListOf<LogEntry>()
    private var queryCount = 0

    /** The Redis key browser, for Redis connections. */
    val redisKeys: RedisBrowserState? = if (profile.driver == com.brainfactory.db.engine.Driver.REDIS) RedisBrowserState(this) else null

    val activeTab: WorkTab? get() = tabs.firstOrNull { it.id == activeTabId }

    /** Runs before each connect: starts the local server the connection is for (see LocalServers.startFor). */
    var beforeConnect: (suspend () -> Unit)? = null

    fun connect() {
        status = Status.Connecting
        scope.launch {
            try {
                val caps = withContext(db) {
                    session?.close()
                    beforeConnect?.invoke()
                    session = openSession(profile, env)
                    lastUse = System.currentTimeMillis()
                    session!!.capabilities
                }
                capabilities = caps
                status = Status.Ready
                loadDatabases()
                refreshObjects()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                status = Status.Failed(describe(e))
            }
        }
    }

    /**
     * Runs [block] on the session's thread. A session idle for a while is pinged first and silently rebuilt when the
     * server or the network dropped it. When the connection is lost during [block], it is rebuilt and, for a [read],
     * [block] runs once more; a write is not repeated, since the server may have done it.
     */
    suspend fun <T> call(read: Boolean = true, block: (DbSession) -> T): T = withContext(db) {
        val s = session ?: throw DbException("Not connected.")
        if (System.currentTimeMillis() - lastUse > IDLE_PING_MS) {
            if (runCatching { s.ping() }.isFailure) rebuild()
        }
        lastUse = System.currentTimeMillis()
        try {
            guarded { block(session!!) }
        } catch (e: Exception) {
            if (e is CancellationException || !connectionLost(e)) throw e
            rebuild()
            if (!read) throw DbException("The connection was lost and has been restored. The change may not have been saved; refresh and check before trying again.")
            guarded { block(session!!) }
        }
    }

    /** A driver part that can't run on Android fails with an Error; it becomes a message instead of a crash. */
    private inline fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (e: LinkageError) {
        throw DbException(describe(e), e)
    }

    private fun describe(e: Throwable): String = when (e) {
        is LinkageError -> "This feature of the ${profile.driver.label} driver isn't available on Android (${e.message})."
        else -> e.message ?: e.javaClass.simpleName
    }

    /** Stops the running statement (the query editor's Stop). */
    fun cancelRunning() {
        session?.cancel()
    }

    private suspend fun rebuild() {
        withContext(Dispatchers.Main) { status = Status.Reconnecting }
        val database = currentDatabase
        runCatching { session?.close() }
        session = null
        try {
            beforeConnect?.invoke()
            val fresh = guarded { openSession(profile, env) }
            if (database != null && database != fresh.currentDatabase) runCatching { fresh.useDatabase(database) }
            session = fresh
            withContext(Dispatchers.Main) { status = Status.Ready }
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { status = Status.Failed(e.message ?: "The connection was lost.") }
            throw DbException("The connection was lost and couldn't be restored: ${e.message}", e)
        }
    }

    private fun connectionLost(e: Throwable): Boolean {
        var t: Throwable? = e
        while (t != null) {
            if (t is SQLNonTransientConnectionException || t is SQLRecoverableException || t is IOException || t is com.mongodb.MongoSocketException) return true
            val m = t.message.orEmpty()
            if (LOST.any { m.contains(it, ignoreCase = true) }) return true
            t = t.cause
        }
        return false
    }

    suspend fun loadDatabases() {
        try {
            val (list, current) = call { it.databases() to it.currentDatabase }
            databases = list
            currentDatabase = current
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            currentDatabase = runCatching { call { it.currentDatabase } }.getOrNull()
        }
        redisKeys?.loadKeyspace()
    }

    fun refreshObjects() {
        scope.launch {
            objectsLoading = true
            objectsError = null
            try {
                if (redisKeys != null) redisKeys.reload() else objects = call { it.objects() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                objectsError = e.message
            } finally {
                objectsLoading = false
            }
        }
    }

    fun switchDatabase(name: String) {
        scope.launch {
            try {
                call { it.useDatabase(name) }
                currentDatabase = name
                objects = emptyList()
                // Tables of the previous database stay open; their refs name their database.
                refreshObjects()
                redisKeys?.loadKeyspace()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                notice = e.message
            }
        }
    }

    fun logStatement(statement: String, millis: Long, error: String? = null, source: String = "grid") {
        log.add(0, LogEntry(statement, millis, error, source))
        if (log.size > 500) log.removeRange(500, log.size)
    }

    private fun activate(tab: WorkTab) {
        if (tabs.none { it.id == tab.id }) tabs += tab
        activeTabId = tab.id
    }

    fun openTable(obj: DbObject) {
        val ref = TableRef(currentDatabase, obj.schema, obj.name, obj.kind)
        tabs.firstOrNull { it.id == WorkTab.Table.idFor(ref) }?.let { activeTabId = it.id; return }
        val tab = WorkTab.Table(ref, TableState(this, ref))
        activate(tab)
        tab.state.load()
    }

    fun openQuery(text: String = ""): QueryState {
        val state = QueryState(this, text)
        activate(WorkTab.Query(state, ++queryCount))
        return state
    }

    /** Opens [text] in the first query tab (or a new one) and runs nothing. */
    fun openInQuery(text: String) {
        val existing = tabs.filterIsInstance<WorkTab.Query>().firstOrNull { it.state.text.text.isBlank() }
        if (existing != null) {
            existing.state.setText(text)
            activeTabId = existing.id
        } else openQuery(text)
    }

    fun openDefinition(obj: DbObject) {
        scope.launch {
            try {
                val text = call { it.definition(obj) } ?: throw DbException("The server didn't give the definition of ${obj.name}.")
                activate(WorkTab.Definition(obj, text))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                notice = e.message
            }
        }
    }

    fun openProcesses() {
        val tab = tabs.filterIsInstance<WorkTab.Processes>().firstOrNull() ?: WorkTab.Processes(ProcessState(this))
        activate(tab)
        tab.state.load()
    }

    fun openLog() = activate(tabs.filterIsInstance<WorkTab.Log>().firstOrNull() ?: WorkTab.Log())

    fun openRealtime() = activate(tabs.filterIsInstance<WorkTab.Realtime>().firstOrNull() ?: WorkTab.Realtime(RealtimeState(this)))

    fun openRedisKey(key: String) {
        val existing = tabs.filterIsInstance<WorkTab.RedisKey>().firstOrNull { it.key == key }
        if (existing != null) {
            activeTabId = existing.id
            existing.state.load()
            return
        }
        val tab = WorkTab.RedisKey(key, RedisKeyState(this, key))
        activate(tab)
        tab.state.load()
    }

    fun closeTab(id: String) {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return
        val tab = tabs.removeAt(index)
        (tab as? WorkTab.Realtime)?.state?.close()
        (tab as? WorkTab.Processes)?.state?.stop()
        if (activeTabId == id) activeTabId = tabs.getOrNull(index)?.id ?: tabs.getOrNull(index - 1)?.id
    }

    fun closeTabsFor(predicate: (WorkTab) -> Boolean) {
        tabs.filter(predicate).forEach { closeTab(it.id) }
    }

    /** The Redis session, for the key browser. */
    suspend fun <T> redis(read: Boolean = true, block: (RedisSession) -> T): T = call(read) { block(it as RedisSession) }

    fun close() {
        tabs.forEach { (it as? WorkTab.Realtime)?.state?.close(); (it as? WorkTab.Processes)?.state?.stop() }
        val s = session
        session = null
        scope.cancel()
        // Closed on its own thread (a SQLite transaction belongs to it), which then ends.
        dbThread.execute { runCatching { s?.close() } }
        dbThread.shutdown()
    }

    companion object {
        private const val IDLE_PING_MS = 45_000L
        private val LOST = listOf(
            "connection is closed", "connection has been closed", "connection closed", "broken pipe", "connection reset",
            "socket closed", "socket is closed", "ssh tunnel closed", "closed the connection", "communications link failure",
            "this connection has been closed", "i/o error", "end of stream",
        )
    }
}

/** The open connections, by profile id: leaving a workspace keeps it connected until it is disconnected. */
object Workspaces {
    val open = mutableStateListOf<Workspace>()

    fun get(id: String): Workspace? = open.firstOrNull { it.profile.id == id }

    fun open(context: Context, profile: ConnectionProfile): Workspace {
        get(profile.id)?.let { ws ->
            if (ws.profile == profile) {
                if (ws.status is Workspace.Status.Failed) ws.connect()
                return ws
            }
            // The connection was edited: start over with the new settings.
            close(profile.id)
        }
        val ws = Workspace(profile, EngineEnv(context.filesDir), QueryHistory(context))
        val app = context.applicationContext
        ws.beforeConnect = { LocalServers.startFor(app, profile.id) }
        open += ws
        ws.connect()
        return ws
    }

    fun close(id: String) {
        get(id)?.let {
            open.remove(it)
            it.close()
        }
    }
}

/** Whether a sidebar object opens as a table tab. */
val DbObject.opensAsTable: Boolean get() = kind == ObjectKind.TABLE || kind == ObjectKind.VIEW || kind == ObjectKind.COLLECTION
