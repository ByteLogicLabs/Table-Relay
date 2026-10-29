package com.brainfactory.db.engine

import java.util.UUID
import org.json.JSONObject

/** The databases Brain DB talks to. [label] is Table Relay's driver name, which its connection exports use too. */
enum class Driver(val label: String, val defaultPort: Int, val language: QueryLanguage, val networked: Boolean) {
    MYSQL("MySQL", 3306, QueryLanguage.SQL, true),
    POSTGRES("PostgreSQL", 5432, QueryLanguage.SQL, true),
    SQLITE("SQLite", 0, QueryLanguage.SQL, false),
    MONGO("MongoDB", 27017, QueryLanguage.MONGO, true),
    REDIS("Redis", 6379, QueryLanguage.REDIS, true);

    val sql: Boolean get() = language == QueryLanguage.SQL

    /** The dialect its SQL is written in; [SqlDialect.MYSQL] for the drivers that don't speak SQL (it's never used for them). */
    val dialect: SqlDialect
        get() = when (this) {
            POSTGRES -> SqlDialect.POSTGRES
            SQLITE -> SqlDialect.SQLITE
            else -> SqlDialect.MYSQL
        }

    companion object {
        /** By Table Relay's label ("PostgreSQL") or a plain key ("postgres", "mongodb"), ignoring case. */
        fun parse(name: String?): Driver? {
            val n = name?.trim()?.lowercase() ?: return null
            return entries.firstOrNull { it.label.lowercase() == n || it.name.lowercase() == n }
                ?: when (n) {
                    "mariadb" -> MYSQL
                    "postgresql", "pg", "postgis" -> POSTGRES
                    "mongodb" -> MONGO
                    "sqlite3" -> SQLITE
                    else -> null
                }
        }
    }
}

enum class QueryLanguage(val label: String) { SQL("SQL"), MONGO("Mongo shell"), REDIS("Redis commands") }

/** Table Relay's SSL modes; [label] is what its exports store. */
enum class SslMode(val label: String) {
    DISABLE("Disable"),
    PREFERRED("Preferred"),
    REQUIRED("Required"),
    VERIFY_CA("Verify-CA");

    companion object {
        fun parse(value: String?): SslMode = entries.firstOrNull { it.label.equals(value?.trim(), ignoreCase = true) || it.name.equals(value?.trim(), ignoreCase = true) }
            ?: when (value?.trim()?.lowercase()) {
                "require", "true", "enabled" -> REQUIRED
                "disabled", "false", "off" -> DISABLE
                "prefer" -> PREFERRED
                "verify-full", "verify_ca", "verifyca" -> VERIFY_CA
                else -> PREFERRED
            }
    }
}

enum class SshAuth { PASSWORD, KEY }

/** A jump host the database is reached through. [privateKey] is the key's text (OpenSSH or PEM), kept with the profile. */
data class SshConfig(
    val host: String = "",
    val port: Int = 22,
    val user: String = "",
    val auth: SshAuth = SshAuth.PASSWORD,
    val password: String = "",
    val privateKey: String = "",
    val passphrase: String = "",
)

/**
 * A saved connection. The fields follow Table Relay's: for SQLite [database] is the file's path; for MongoDB [host]
 * may be a whole `mongodb://` or `mongodb+srv://` connection string; for Redis [database] is the database number.
 */
data class ConnectionProfile(
    val id: String = UUID.randomUUID().toString(),
    val name: String = "",
    val driver: Driver = Driver.MYSQL,
    val host: String = "",
    val port: Int = driver.defaultPort,
    val user: String = "",
    val password: String = "",
    val database: String = "",
    val sslMode: SslMode = SslMode.PREFERRED,
    val ssh: SshConfig? = null,
    /** An ARGB colour tag, or null. */
    val color: Long? = null,
    val favorite: Boolean = false,
    /** Refuses edits and writing statements, for a production server one only wants to look at. */
    val readOnly: Boolean = false,
) {
    val usesUri: Boolean get() = driver == Driver.MONGO && (host.startsWith("mongodb://") || host.startsWith("mongodb+srv://"))

    /** "MySQL · db.example.com" for the connection list. */
    val summary: String
        get() = when {
            driver == Driver.SQLITE -> "SQLite · ${database.substringAfterLast('/')}"
            usesUri -> "MongoDB · " + host.substringAfter("://").substringAfter('@').substringBefore('/').substringBefore('?')
            else -> "${driver.label} · $host" + if (port != driver.defaultPort) ":$port" else ""
        }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("driver", driver.label).put("host", host).put("port", port)
        .put("user", user).put("password", password).put("database", database).put("sslMode", sslMode.label)
        .put("sshEnabled", ssh != null)
        .put("sshHost", ssh?.host).put("sshPort", ssh?.port).put("sshUser", ssh?.user)
        .put("sshAuthKind", ssh?.auth?.let { if (it == SshAuth.KEY) "key" else "password" })
        .put("sshPassword", ssh?.password).put("sshPrivateKey", ssh?.privateKey).put("sshKeyPassphrase", ssh?.passphrase)
        .put("color", color?.let { "#%08X".format(it) }).put("isFavorite", favorite).put("readOnly", readOnly)

    companion object {
        /**
         * Reads a profile from Brain DB's own JSON or a Table Relay connections export (the same field names; a
         * Table Relay key file path can't come along, so such a profile needs the key pasted in once).
         */
        fun fromJson(json: JSONObject): ConnectionProfile? {
            val driver = Driver.parse(json.optString("driver")) ?: return null
            val ssh = if (json.optBoolean("sshEnabled")) {
                SshConfig(
                    host = json.optStringOrEmpty("sshHost"),
                    port = json.optInt("sshPort", 22).takeIf { it > 0 } ?: 22,
                    user = json.optStringOrEmpty("sshUser"),
                    auth = if (json.optStringOrEmpty("sshAuthKind") == "key") SshAuth.KEY else SshAuth.PASSWORD,
                    password = json.optStringOrEmpty("sshPassword"),
                    privateKey = json.optStringOrEmpty("sshPrivateKey"),
                    passphrase = json.optStringOrEmpty("sshKeyPassphrase"),
                )
            } else null
            return ConnectionProfile(
                id = json.optStringOrEmpty("id").ifBlank { UUID.randomUUID().toString() },
                name = json.optStringOrEmpty("name"),
                driver = driver,
                host = json.optStringOrEmpty("host"),
                port = json.optInt("port", driver.defaultPort).takeIf { it > 0 } ?: driver.defaultPort,
                user = json.optStringOrEmpty("user"),
                password = json.optStringOrEmpty("password"),
                database = json.optStringOrEmpty("database"),
                sslMode = SslMode.parse(json.optStringOrEmpty("sslMode")),
                ssh = ssh,
                color = parseColor(json.optStringOrEmpty("color")),
                favorite = json.optBoolean("isFavorite"),
                readOnly = json.optBoolean("readOnly"),
            )
        }

        private fun parseColor(text: String): Long? {
            val hex = text.removePrefix("#").takeIf { it.length == 6 || it.length == 8 } ?: return null
            val value = hex.toLongOrNull(16) ?: return null
            return if (hex.length == 6) 0xFF000000 or value else value
        }
    }
}

/** org.json's optString gives "null" for a JSON null; this gives "". */
internal fun JSONObject.optStringOrEmpty(key: String): String = if (isNull(key)) "" else optString(key)

enum class ObjectKind(val label: String) {
    TABLE("Tables"), COLLECTION("Collections"), VIEW("Views"), ROUTINE("Routines"), TRIGGER("Triggers")
}

/** A table, view, collection, routine or trigger. [schema] is PostgreSQL's schema; [rows] an estimate when known. */
data class DbObject(val name: String, val kind: ObjectKind, val schema: String? = null, val rows: Long? = null, val detail: String? = null) {
    val browsable: Boolean get() = kind == ObjectKind.TABLE || kind == ObjectKind.VIEW || kind == ObjectKind.COLLECTION
}

/** Where a table lives: the database (MySQL schema, Mongo database), PostgreSQL's schema, and its name. */
data class TableRef(val database: String?, val schema: String?, val name: String, val kind: ObjectKind = ObjectKind.TABLE) {
    val display: String get() = if (schema != null && schema != "public") "$schema.$name" else name
}

/** A value from the database that is JSON (a Mongo document or array, a JSON column): exported and edited as JSON. */
data class JsonText(val text: String) {
    override fun toString() = text
}

data class ColumnMeta(val name: String, val type: String = "", val key: Boolean = false)

/**
 * Rows from a query or a browse. Values are null, String, Number, Boolean, ByteArray or [JsonText]; dates and
 * times arrive as the text the server gives them.
 */
data class ResultTable(val columns: List<ColumnMeta>, val rows: List<List<Any?>>, val truncated: Boolean = false) {
    companion object {
        val EMPTY = ResultTable(emptyList(), emptyList())
    }
}

/** What one statement did: rows, an affected-row count or a message, or the error it failed with. */
data class StatementResult(
    val statement: String,
    val table: ResultTable? = null,
    val affected: Long? = null,
    val message: String? = null,
    val error: String? = null,
    val millis: Long = 0,
) {
    val ok: Boolean get() = error == null
}

enum class FilterOp(val label: String, val needsValue: Boolean = true) {
    EQ("="), NE("≠"), GT(">"), GE("≥"), LT("<"), LE("≤"), CONTAINS("contains"), NOT_CONTAINS("doesn't contain"),
    STARTS_WITH("starts with"), IS_NULL("is NULL", false), IS_NOT_NULL("is not NULL", false),
}

data class FilterSpec(val column: String, val op: FilterOp, val value: String = "")

data class SortSpec(val column: String, val descending: Boolean = false)

/** One page of a table: [rawFilter] is a WHERE clause (SQL) or a filter document (Mongo) typed by hand. */
data class BrowseRequest(
    val limit: Int = 100,
    val offset: Long = 0,
    val sort: List<SortSpec> = emptyList(),
    val filters: List<FilterSpec> = emptyList(),
    val rawFilter: String = "",
)

data class BrowsePage(
    val table: ResultTable,
    /** The columns that identify a row (primary key, Mongo `_id`); empty when rows can't be edited. */
    val keyColumns: List<String>,
    /** The statement that read the page, for the query log. */
    val statement: String,
    val millis: Long,
    /** Each row's whole document, as shell JSON, for MongoDB's JSON view and document editor. */
    val documents: List<String>? = null,
) {
    val editable: Boolean get() = keyColumns.isNotEmpty()
}

data class ColumnInfo(
    val name: String,
    val type: String,
    val nullable: Boolean = true,
    val default: String? = null,
    /** "PRI", "UNI", "MUL" or "" (MySQL's COLUMN_KEY; the other drivers fill PRI the same way). */
    val key: String = "",
    val extra: String = "",
    val comment: String = "",
)

data class IndexInfo(val name: String, val columns: List<String>, val unique: Boolean, val primary: Boolean = false, val definition: String = "")

data class ForeignKeyInfo(
    val name: String,
    val columns: List<String>,
    val refTable: String,
    val refColumns: List<String>,
    val onUpdate: String = "",
    val onDelete: String = "",
)

data class TableStructure(
    val columns: List<ColumnInfo>,
    val indexes: List<IndexInfo> = emptyList(),
    val foreignKeys: List<ForeignKeyInfo> = emptyList(),
    /** CREATE statement, when the server can give one. */
    val ddl: String? = null,
    /** Table facts: engine, collation, size, document count… */
    val info: List<Pair<String, String>> = emptyList(),
)

/** A value to write into a cell. */
sealed interface CellInput {
    data object Null : CellInput
    /** The column's default (inserts only). */
    data object Default : CellInput
    data class Text(val value: String) : CellInput
}

/** What a driver can do, which decides what the workspace offers. */
data class Capabilities(
    val databases: Boolean = true,
    val editRows: Boolean = true,
    val structure: Boolean = true,
    val processList: Boolean = true,
    /** "LISTEN / NOTIFY", "Pub/Sub", "Change streams", or null when the driver has none. */
    val realtime: String? = null,
    val routines: Boolean = false,
)

/** A message that arrived on a realtime channel. */
data class RealtimeMessage(val channel: String, val payload: String, val time: Long = System.currentTimeMillis())

/** The database refused or failed; [message] is ready to show. */
class DbException(message: String, cause: Throwable? = null) : Exception(message, cause)
