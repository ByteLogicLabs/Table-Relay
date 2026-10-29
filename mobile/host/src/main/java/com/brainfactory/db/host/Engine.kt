package com.brainfactory.db.host

/** The database servers Brain DB can run on the phone: Termux's Android builds of them. */
enum class Engine(
    val label: String,
    /** Its package in Termux's repository. */
    val pkg: String,
    val defaultPort: Int,
    /** The account it is set up with; Redis and Valkey have only a password. */
    val user: String?,
    /** One line for the engine picker. */
    val about: String,
) {
    POSTGRESQL("PostgreSQL", "postgresql", 5432, "postgres", "The relational database, with its bundled extensions (pgcrypto, hstore, pg_trgm…)."),
    MARIADB("MariaDB", "mariadb", 3306, "root", "MySQL-compatible: MySQL clients and Brain DB's MySQL driver connect to it."),
    REDIS("Redis", "redis", 6379, null, "The in-memory key-value store."),
    VALKEY("Valkey", "valkey", 6379, null, "The open-source fork of Redis; it speaks the same protocol.");

    /** The server program, relative to the installation. */
    val program: String
        get() = when (this) {
            POSTGRESQL -> "bin/postgres"
            MARIADB -> "bin/mariadbd"
            REDIS -> "bin/redis-server"
            VALKEY -> "bin/valkey-server"
        }

    /**
     * Whether [path] (under the package's usr/) of the engine's own package is unpacked: the server and what it
     * reads, not headers, manuals or (for MariaDB, 170 MB of them) client tools.
     */
    internal fun keeps(path: String): Boolean = when (this) {
        POSTGRESQL -> path.startsWith("bin/") || path.startsWith("share/postgresql/") || keepsLibrary(path)
        MARIADB -> path == "bin/mariadbd" || path.startsWith("share/mariadb/") || path.startsWith("lib/mysql/plugin/")
        REDIS, VALKEY -> path == program
    }

    companion object {
        fun parse(name: String?): Engine? = entries.firstOrNull { it.name.equals(name, ignoreCase = true) || it.pkg == name }
    }
}

/** What a dependency contributes: its shared libraries and their modules (OpenSSL's providers, say). */
internal fun keepsLibrary(path: String) = path.startsWith("lib/") && !path.startsWith("lib/pkgconfig/") && !path.startsWith("lib/cmake/") &&
    !path.endsWith(".a") && !path.endsWith(".la")
