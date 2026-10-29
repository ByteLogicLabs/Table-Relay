package com.brainfactory.db.engine

import java.sql.Connection
import java.sql.SQLException
import java.util.Properties
import kotlin.concurrent.thread
import org.postgresql.PGConnection

/**
 * PostgreSQL 9.6+ (and the compatible servers: Supabase, Neon, RDS, CockroachDB in part), through pgjdbc 42.2.
 * A connection serves one database, so switching database reconnects; schemas group the tables inside it.
 */
class PostgresSession(profile: ConnectionProfile, env: EngineEnv) : JdbcSession(profile, env) {

    override val capabilities = Capabilities(realtime = "LISTEN / NOTIFY", routines = true)

    override var currentDatabase: String? = profile.database.ifBlank { "postgres" }
        private set

    init {
        open(currentDatabase)
    }

    override fun connect(host: String, port: Int, database: String?): Connection {
        val props = props()
        val url = "jdbc:postgresql://$host:$port/" + java.net.URLEncoder.encode(database ?: "postgres", "UTF-8")
        return org.postgresql.Driver().connect(url, props) ?: throw SQLException("The PostgreSQL driver didn't accept $url")
    }

    private fun props() = Properties().apply {
        setProperty("user", profile.user)
        setProperty("password", profile.password)
        setProperty("connectTimeout", "15")
        setProperty("tcpKeepAlive", "true")
        setProperty("ApplicationName", "Brain DB")
        // Values typed into the grid are sent as text and the server casts them to the column's type.
        setProperty("stringtype", "unspecified")
        setProperty(
            "sslmode",
            when (profile.sslMode) {
                SslMode.DISABLE -> "disable"
                SslMode.PREFERRED -> "prefer"
                SslMode.REQUIRED -> "require"
                SslMode.VERIFY_CA -> "verify-ca"
            },
        )
        // Without a CA file on the phone, "require" means encrypted but not verified, as libpq does.
        if (profile.sslMode != SslMode.VERIFY_CA) setProperty("sslfactory", "org.postgresql.ssl.NonValidatingFactory")
    }

    override val readOnlySessionSql get() = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"

    /**
     * After an error inside an explicit transaction (BEGIN …), PostgreSQL refuses everything until ROLLBACK, which
     * would also stop the grid. A failed transaction can only end in a rollback (COMMIT rolls it back too), so it is
     * rolled back at once and the user is told.
     */
    override fun afterFailure(): String? {
        val state = (connection.unwrap(org.postgresql.core.BaseConnection::class.java)).transactionState
        if (state != org.postgresql.core.TransactionState.FAILED) return null
        connection.createStatement().use { it.execute("ROLLBACK") }
        return "The open transaction failed, so it was rolled back (PostgreSQL rolls back a failed transaction even at COMMIT)."
    }

    override fun databases(): List<String> = rows("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname") { it.getString(1) }

    override fun useDatabase(name: String) {
        if (name == currentDatabase) return
        val previous = currentDatabase
        try {
            reopen(name)
            currentDatabase = name
        } catch (e: Exception) {
            runCatching { reopen(previous) }
            throw e
        }
    }

    override fun objects(): List<DbObject> {
        val out = rows(
            "SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') " +
                "AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' " +
                "ORDER BY n.nspname <> 'public', n.nspname, c.relname",
        ) { rs ->
            val kind = rs.getString(3)
            val view = kind == "v" || kind == "m"
            DbObject(
                rs.getString(2), if (view) ObjectKind.VIEW else ObjectKind.TABLE, schema = rs.getString(1),
                rows = rs.getLong(4).takeIf { !view && it >= 0 },
                detail = if (kind == "m") "materialized" else null,
            )
        }.toMutableList()
        out += runCatching {
            rows(
                "SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE 'function' END, " +
                    "pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
                    "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' " +
                    "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY n.nspname, p.proname",
            ) { DbObject(it.getString(2), ObjectKind.ROUTINE, schema = it.getString(1), detail = it.getString(3) + "(" + it.getString(4) + ")") }
        }.getOrDefault(emptyList())
        out += runCatching {
            rows(
                "SELECT n.nspname, t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
                    "WHERE NOT t.tgisinternal ORDER BY n.nspname, t.tgname",
            ) { DbObject(it.getString(2), ObjectKind.TRIGGER, schema = it.getString(1), detail = "on " + it.getString(3)) }
        }.getOrDefault(emptyList())
        return out
    }

    private fun regclass(table: TableRef) = dialect.qualified(table.copy(schema = table.schema ?: "public"))

    override fun primaryKey(table: TableRef): List<String> = rows(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) " +
            "WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)",
        regclass(table),
    ) { it.getString(1) }

    override fun structure(table: TableRef): TableStructure {
        val rel = regclass(table)
        val columns = rows(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), " +
                "COALESCE((SELECT 'PRI' FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey) LIMIT 1), " +
                "(SELECT 'UNI' FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisunique AND i.indnatts = 1 AND i.indkey[0] = a.attnum LIMIT 1), ''), " +
                "CASE a.attidentity WHEN 'a' THEN 'identity always' WHEN 'd' THEN 'identity' ELSE '' END, col_description(a.attrelid, a.attnum) " +
                "FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
                "WHERE a.attrelid = ?::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            rel,
        ) { ColumnInfo(it.getString(1), it.getString(2), it.getBoolean(3), it.getString(4), it.getString(5).orEmpty(), it.getString(6).orEmpty(), it.getString(7).orEmpty()) }

        val indexes = rows(
            "SELECT c.relname, ix.indisunique, ix.indisprimary, pg_get_indexdef(ix.indexrelid), " +
                "ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_subscripts(ix.indkey, 1) k ORDER BY k)::text[] " +
                "FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid WHERE ix.indrelid = ?::regclass ORDER BY ix.indisprimary DESC, c.relname",
            rel,
        ) { IndexInfo(it.getString(1), stringArray(it.getArray(5)), it.getBoolean(2), it.getBoolean(3), it.getString(4)) }

        val foreignKeys = runCatching {
            rows(
                "SELECT c.conname, " +
                    "ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o)::text[], " +
                    "c.confrelid::regclass::text, " +
                    "ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o)::text[], " +
                    "c.confupdtype, c.confdeltype FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = ?::regclass ORDER BY c.conname",
                rel,
            ) { ForeignKeyInfo(it.getString(1), stringArray(it.getArray(2)), it.getString(3), stringArray(it.getArray(4)), rule(it.getString(5)), rule(it.getString(6))) }
        }.getOrDefault(emptyList())

        val ddl = runCatching { if (table.kind == ObjectKind.VIEW) viewDdl(rel) else tableDdl(rel, columns, indexes) }.getOrNull()

        val info = runCatching {
            query(
                "SELECT pg_size_pretty(pg_total_relation_size(c.oid)), pg_size_pretty(pg_relation_size(c.oid)), c.reltuples::bigint, " +
                    "obj_description(c.oid, 'pg_class'), pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = ?::regclass",
                rel,
            ) { rs ->
                if (!rs.next()) emptyList() else listOfNotNull(
                    "Total size" to rs.getString(1),
                    "Table size" to rs.getString(2),
                    rs.getLong(3).takeIf { it >= 0 }?.let { "Rows (estimate)" to it.toString() },
                    "Owner" to rs.getString(5),
                    rs.getString(4)?.takeIf { it.isNotBlank() }?.let { "Comment" to it },
                )
            }
        }.getOrDefault(emptyList())
        return TableStructure(columns, indexes, foreignKeys, ddl, info)
    }

    /** PostgreSQL has no SHOW CREATE TABLE; this rebuilds one from the catalog: columns, constraints, other indexes. */
    private fun tableDdl(rel: String, columns: List<ColumnInfo>, indexes: List<IndexInfo>): String {
        val constraints = rows(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = ?::regclass ORDER BY contype = 'p' DESC, conname",
            rel,
        ) { "CONSTRAINT " + dialect.quote(it.getString(1)) + " " + it.getString(2) }
        val lines = columns.map { c ->
            "  " + dialect.quote(c.name) + " " + c.type + (if (!c.nullable) " NOT NULL" else "") + (c.default?.let { " DEFAULT $it" } ?: "") +
                if (c.extra.startsWith("identity")) " GENERATED " + (if (c.extra == "identity always") "ALWAYS" else "BY DEFAULT") + " AS IDENTITY" else ""
        } + constraints.map { "  $it" }
        val constraintIndexes = rows("SELECT conindid::regclass::text FROM pg_constraint WHERE conrelid = ?::regclass AND conindid <> 0", rel) { it.getString(1).substringAfterLast('.').trim('"') }.toSet()
        val others = indexes.filter { it.name !in constraintIndexes }.map { it.definition + ";" }
        return "CREATE TABLE $rel (\n" + lines.joinToString(",\n") + "\n);" + if (others.isEmpty()) "" else "\n\n" + others.joinToString("\n")
    }

    private fun viewDdl(rel: String): String? = query("SELECT pg_get_viewdef(?::regclass, true)", rel) { rs ->
        if (rs.next()) "CREATE VIEW $rel AS\n" + rs.getString(1) else null
    }

    private fun stringArray(array: java.sql.Array?): List<String> = (array?.array as? Array<*>)?.map { it.toString() }.orEmpty()

    private fun rule(code: String?) = when (code) {
        "a" -> "NO ACTION"
        "r" -> "RESTRICT"
        "c" -> "CASCADE"
        "n" -> "SET NULL"
        "d" -> "SET DEFAULT"
        else -> code.orEmpty()
    }

    override fun definition(obj: DbObject): String? = when (obj.kind) {
        ObjectKind.ROUTINE -> rows(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
                "WHERE n.nspname = ? AND p.proname = ? AND p.prokind IN ('f', 'p') ORDER BY p.oid",
            obj.schema ?: "public", obj.name,
        ) { it.getString(1) }.joinToString("\n\n").ifBlank { null }
        ObjectKind.TRIGGER -> rows(
            "SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND t.tgname = ?",
            obj.schema ?: "public", obj.name,
        ) { it.getString(1) + ";" }.firstOrNull()
        ObjectKind.VIEW -> viewDdl(regclass(TableRef(null, obj.schema, obj.name, ObjectKind.VIEW)))
        else -> structure(TableRef(null, obj.schema, obj.name)).ddl
    }

    override fun processList(): ResultTable = wrap {
        connection.createStatement().use { st ->
            st.executeQuery(
                "SELECT pid, usename AS user, datname AS database, client_addr::text AS client, application_name AS application, state, " +
                    "date_trunc('second', now() - query_start)::text AS duration, wait_event, query FROM pg_stat_activity " +
                    "WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start DESC NULLS LAST",
            ).use { readTable(it, 2000) }
        }
    }

    override fun processKill(id: Any?) {
        val pid = id?.toString()?.toIntOrNull() ?: throw DbException("Not a process id: $id")
        query("SELECT pg_terminate_backend(?)", pid) { if (it.next() && !it.getBoolean(1)) throw DbException("PostgreSQL didn't end process $pid (it may have finished).") }
    }

    override fun openRealtime(): RealtimeChannel = PgListener()

    /**
     * LISTEN / NOTIFY on a connection of its own: the server pushes notifications, which the driver hands over when
     * asked, so a thread waits on them in turn.
     */
    private inner class PgListener : RealtimeChannel {
        private val conn: Connection = endpoint().let { (host, port) ->
            try {
                connect(host, port, currentDatabase)
            } catch (e: SQLException) {
                throw DbException(message(e), e)
            }
        }
        @Volatile private var running = true
        override val targetLabel = "Channel"
        override val canPublish = true

        override fun subscribe(target: String) = run("LISTEN " + dialect.quote(target))
        override fun unsubscribe(target: String) = run("UNLISTEN " + dialect.quote(target))

        override fun publish(target: String, payload: String) {
            synchronized(conn) { conn.prepareStatement("SELECT pg_notify(?, ?)").use { it.setString(1, target); it.setString(2, payload); it.execute() } }
        }

        private fun run(sql: String) {
            try {
                synchronized(conn) { conn.createStatement().use { it.execute(sql) } }
            } catch (e: SQLException) {
                throw DbException(message(e), e)
            }
        }

        override fun start(onMessage: (RealtimeMessage) -> Unit, onError: (String) -> Unit) {
            val pg = conn.unwrap(PGConnection::class.java)
            thread(name = "pg-listen", isDaemon = true) {
                try {
                    while (running) {
                        val notes = synchronized(conn) { pg.getNotifications(250) }
                        notes?.forEach { onMessage(RealtimeMessage(it.name, it.parameter.orEmpty())) }
                        if (notes.isNullOrEmpty()) Thread.sleep(150)
                    }
                } catch (e: Exception) {
                    if (running) onError(message(e))
                }
            }
        }

        override fun close() {
            running = false
            runCatching { conn.close() }
        }
    }
}
