package com.brainfactory.db.engine

import java.sql.Connection
import java.sql.SQLException
import java.util.Properties

/**
 * MySQL 5.7+, MySQL 8, MariaDB and the managed variants, through MariaDB's JDBC driver (3.5; it speaks MySQL's
 * caching_sha2_password too). A database is a schema here, so switching is just `USE`.
 */
class MysqlSession(profile: ConnectionProfile, env: EngineEnv) : JdbcSession(profile, env) {

    override val capabilities = Capabilities(routines = true)

    override var currentDatabase: String? = null
        private set

    init {
        open(profile.database.takeIf { it.isNotBlank() })
        currentDatabase = profile.database.takeIf { it.isNotBlank() } ?: connection.catalog?.takeIf { it.isNotBlank() }
            ?: runCatching { databases().firstOrNull { it.lowercase() !in SYSTEM } }.getOrNull()
        currentDatabase?.let { runCatching { connection.catalog = it } }
    }

    override fun connect(host: String, port: Int, database: String?): Connection {
        fun attempt(ssl: Boolean): Connection {
            val props = Properties().apply {
                setProperty("user", profile.user)
                setProperty("password", profile.password)
                setProperty("connectTimeout", "15000")
                setProperty("tcpKeepAlive", "true")
                // TINYINT(1) stays a number (0/1), as the server stores it and as edits write it back.
                setProperty("tinyInt1isBit", "false")
                setProperty("yearIsDateType", "false")
                // MySQL 8's caching_sha2_password over a plain connection needs the server's RSA key.
                setProperty("allowPublicKeyRetrieval", "true")
                // "trust": encrypted without checking the certificate; "verify-ca": checked against Android's CAs.
                setProperty("sslMode", if (!ssl) "disable" else if (profile.sslMode == SslMode.VERIFY_CA) "verify-ca" else "trust")
            }
            val url = "jdbc:mariadb://$host:$port/" + (database ?: "")
            return org.mariadb.jdbc.Driver().connect(url, props) ?: throw SQLException("The MariaDB driver didn't accept $url")
        }
        return when (profile.sslMode) {
            SslMode.DISABLE -> attempt(false)
            SslMode.REQUIRED, SslMode.VERIFY_CA -> attempt(true)
            // Preferred: TLS when the server offers it, else a plain connection, as the desktop's driver does.
            SslMode.PREFERRED -> try {
                attempt(true)
            } catch (e: SQLException) {
                if (e.message.orEmpty().contains("Access denied", true)) throw e
                attempt(false)
            }
        }
    }

    override val readOnlySessionSql get() = "SET SESSION TRANSACTION READ ONLY"

    override fun databases(): List<String> = rows("SHOW DATABASES") { it.getString(1) }

    override fun useDatabase(name: String) {
        wrap { connection.catalog = name }
        currentDatabase = name
    }

    override fun afterStatement(statement: String) {
        if (stripComments(statement, dialect).trim().startsWith("USE", ignoreCase = true)) {
            currentDatabase = runCatching { connection.catalog }.getOrNull() ?: currentDatabase
        }
    }

    override fun objects(): List<DbObject> {
        val db = currentDatabase ?: return emptyList()
        val out = rows(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            db,
        ) { rs ->
            val view = rs.getString(2).orEmpty().contains("VIEW")
            DbObject(rs.getString(1), if (view) ObjectKind.VIEW else ObjectKind.TABLE, rows = if (view) null else rs.getLong(3).takeIf { !rs.wasNull() })
        }.toMutableList()
        out += runCatching {
            rows("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME", db) {
                DbObject(it.getString(1), ObjectKind.ROUTINE, detail = it.getString(2)?.lowercase())
            }
        }.getOrDefault(emptyList())
        out += runCatching {
            rows("SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", db) {
                DbObject(it.getString(1), ObjectKind.TRIGGER, detail = "${it.getString(2)} on ${it.getString(3)}")
            }
        }.getOrDefault(emptyList())
        return out
    }

    private fun schemaOf(table: TableRef) = table.database ?: currentDatabase ?: throw DbException("Pick a database first.")

    override fun primaryKey(table: TableRef): List<String> = rows(
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
        schemaOf(table), table.name,
    ) { it.getString(1) }

    override fun structure(table: TableRef): TableStructure {
        val db = schemaOf(table)
        val columns = rows(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS " +
                "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            db, table.name,
        ) { ColumnInfo(it.getString(1), it.getString(2), it.getString(3) == "YES", it.getString(4), it.getString(5).orEmpty(), it.getString(6).orEmpty(), it.getString(7).orEmpty()) }

        data class IndexRow(val name: String, val unique: Boolean, val column: String, val type: String)
        val indexes = rows(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            db, table.name,
        ) { IndexRow(it.getString(1), it.getInt(2) == 0, it.getString(3).orEmpty(), it.getString(4).orEmpty()) }
            .groupBy { it.name }
            .map { (name, parts) -> IndexInfo(name, parts.map { it.column }, parts.first().unique, primary = name == "PRIMARY", definition = parts.first().type) }
            .sortedByDescending { it.primary }

        data class FkRow(val name: String, val column: String, val refTable: String, val refColumn: String, val onUpdate: String, val onDelete: String)
        val foreignKeys = runCatching {
            rows(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE " +
                    "FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r " +
                    "ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME " +
                    "WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                db, table.name,
            ) { FkRow(it.getString(1), it.getString(2), it.getString(3), it.getString(4), it.getString(5).orEmpty(), it.getString(6).orEmpty()) }
                .groupBy { it.name }
                .map { (name, parts) -> ForeignKeyInfo(name, parts.map { it.column }, parts.first().refTable, parts.map { it.refColumn }, parts.first().onUpdate, parts.first().onDelete) }
        }.getOrDefault(emptyList())

        val view = table.kind == ObjectKind.VIEW
        val ddl = runCatching {
            query((if (view) "SHOW CREATE VIEW " else "SHOW CREATE TABLE ") + dialect.qualified(table.copy(database = db))) { if (it.next()) it.getString(2) else null }
        }.getOrNull()

        val info = runCatching {
            query(
                "SELECT ENGINE, TABLE_COLLATION, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT " +
                    "FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                db, table.name,
            ) { rs ->
                if (!rs.next()) emptyList() else listOfNotNull(
                    rs.getString(1)?.let { "Engine" to it },
                    rs.getString(2)?.let { "Collation" to it },
                    rs.getString(3)?.let { "Rows (estimate)" to it },
                    rs.getString(4)?.let { "Data size" to formatBytes(it.toLong()) },
                    rs.getString(5)?.let { "Index size" to formatBytes(it.toLong()) },
                    rs.getString(6)?.let { "Next AUTO_INCREMENT" to it },
                    rs.getString(7)?.let { "Created" to it },
                    rs.getString(8)?.let { "Updated" to it },
                    rs.getString(9)?.takeIf { it.isNotBlank() }?.let { "Comment" to it },
                )
            }
        }.getOrDefault(emptyList())
        return TableStructure(columns, indexes, foreignKeys, ddl, info)
    }

    override fun definition(obj: DbObject): String? {
        val db = currentDatabase ?: return null
        val name = dialect.quote(db) + "." + dialect.quote(obj.name)
        val (sql, column) = when (obj.kind) {
            ObjectKind.ROUTINE -> (if (obj.detail == "function") "SHOW CREATE FUNCTION $name" else "SHOW CREATE PROCEDURE $name") to 3
            ObjectKind.TRIGGER -> "SHOW CREATE TRIGGER $name" to 3
            ObjectKind.VIEW -> "SHOW CREATE VIEW $name" to 2
            else -> "SHOW CREATE TABLE $name" to 2
        }
        return query(sql) { if (it.next()) it.getString(column) else null }
    }

    /** Spatial values come as SRID + WKB bytes; the grid shows them as WKT. */
    override fun readValue(rs: java.sql.ResultSet, i: Int, typeName: String): Any? {
        val v = super.readValue(rs, i, typeName)
        return if (v is ByteArray && typeName.uppercase() in MYSQL_GEOMETRY_TYPES) mysqlGeometryToWkt(v) ?: v else v
    }

    override fun processList(): ResultTable = wrap {
        connection.createStatement().use { st -> st.executeQuery("SHOW FULL PROCESSLIST").use { readTable(it, 2000) } }
    }

    override fun processKill(id: Any?) {
        val n = id?.toString()?.toLongOrNull() ?: throw DbException("Not a process id: $id")
        execUpdate("KILL $n")
    }

    companion object {
        private val SYSTEM = setOf("information_schema", "mysql", "performance_schema", "sys")
    }
}

/** 1536 → "1.5 KB". */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes / 1024.0
    var u = 0
    while (v >= 1024 && u < units.lastIndex) { v /= 1024; u++ }
    return "%.1f %s".format(v, units[u])
}
