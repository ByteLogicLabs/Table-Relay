package com.brainfactory.db.engine

import java.io.Closeable
import java.io.File

/**
 * An open connection to one server (one file, for SQLite). Every call blocks, so callers run them off the main
 * thread; a session is used by one caller at a time ([ConnectionManager] serialises them).
 */
interface DbSession : Closeable {
    val profile: ConnectionProfile
    val capabilities: Capabilities

    /** The database (MySQL schema, Mongo database, Redis "db3", PostgreSQL database) the workspace is looking at. */
    val currentDatabase: String?

    /** Checks the connection still answers; throws when it doesn't. */
    fun ping()

    fun databases(): List<String>

    /** Switches [currentDatabase]. For PostgreSQL this reconnects, since a connection serves one database. */
    fun useDatabase(name: String)

    /** The tables, views, collections, routines and triggers of [currentDatabase]. */
    fun objects(): List<DbObject>

    fun browse(table: TableRef, request: BrowseRequest): BrowsePage

    /** Rows matching [request]'s filters, or null when counting isn't possible. */
    fun count(table: TableRef, request: BrowseRequest): Long?

    fun structure(table: TableRef): TableStructure

    /** Runs what was typed in the query editor: each statement's result, stopping at the first error. */
    fun execute(text: String, maxRows: Int = 5000): List<StatementResult>

    /** The statements [text] holds, as [execute] would run them. */
    fun split(text: String): List<String>

    /** Sets [column] of the row [key] identifies; returns the statement that did it. */
    fun updateCell(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): String

    fun insertRow(table: TableRef, values: Map<String, CellInput>): String

    fun deleteRows(table: TableRef, keys: List<Map<String, Any?>>): String

    /** Running queries / clients; [processKill] ends one by the value in its first column. */
    fun processList(): ResultTable

    fun processKill(id: Any?)

    /** The CREATE statement of a routine, trigger or view, or null when the server won't give it. */
    fun definition(obj: DbObject): String? = null

    /** Stops the statement running now, from another thread; does nothing when the driver can't. */
    fun cancel() {}

    /** A separate connection for LISTEN/NOTIFY, Pub/Sub or change streams. */
    fun openRealtime(): RealtimeChannel = throw DbException("${profile.driver.label} has no realtime channels.")
}

/** Listens on channels (or watches collections) and publishes to them. Messages arrive on a background thread. */
interface RealtimeChannel : Closeable {
    /** What a channel name means here: "Channel", "Pattern or channel", "Collection". */
    val targetLabel: String
    val canPublish: Boolean
    fun subscribe(target: String)
    fun unsubscribe(target: String)
    fun publish(target: String, payload: String)
    /** Called for each message until [close]; [onError] when the connection breaks. */
    fun start(onMessage: (RealtimeMessage) -> Unit, onError: (String) -> Unit)
}

/** Where sessions keep their files: pinned SSH host keys. */
class EngineEnv(dataDir: File) {
    val knownHosts = KnownHosts(File(dataDir, "known_hosts.json"))
}

/** Opens [profile] with its driver, through its SSH tunnel when it has one. */
fun openSession(profile: ConnectionProfile, env: EngineEnv): DbSession = when (profile.driver) {
    Driver.MYSQL -> MysqlSession(profile, env)
    Driver.POSTGRES -> PostgresSession(profile, env)
    Driver.SQLITE -> SqliteSession(profile)
    Driver.MONGO -> MongoSession(profile, env)
    Driver.REDIS -> RedisSession(profile, env)
}

/** Measures [block] in milliseconds. */
internal inline fun <T> timed(block: () -> T): Pair<T, Long> {
    val start = System.nanoTime()
    val value = block()
    return value to (System.nanoTime() - start) / 1_000_000
}

/** Refuses writes on a read-only connection. */
internal fun ConnectionProfile.requireWritable() {
    if (readOnly) throw DbException("This connection is read-only. Turn off \"Read-only\" in its settings to change data.")
}
