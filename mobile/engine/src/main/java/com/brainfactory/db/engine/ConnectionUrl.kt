package com.brainfactory.db.engine

import java.net.URI
import java.net.URLDecoder

/**
 * A connection URL, as Table Relay's parser reads them: mysql://, postgres(ql)://, mongodb(+srv)://, redis(s)://,
 * sqlite:///path. MongoDB keeps the whole URL as its host (the driver reads its options).
 */
fun parseConnectionUrl(input: String): ConnectionProfile? {
    val raw = input.trim()
    val scheme = Regex("^([a-z][a-z0-9+]*)://", RegexOption.IGNORE_CASE).find(raw)?.groupValues?.get(1)?.lowercase() ?: return null
    val driver = when (scheme) {
        "mysql", "mariadb" -> Driver.MYSQL
        "postgres", "postgresql" -> Driver.POSTGRES
        "mongodb", "mongodb+srv" -> Driver.MONGO
        "redis", "rediss" -> Driver.REDIS
        "sqlite" -> Driver.SQLITE
        else -> return null
    }
    if (driver == Driver.SQLITE) return ConnectionProfile(driver = driver, database = raw.removePrefix("sqlite://"), port = 0)
    if (driver == Driver.MONGO) return ConnectionProfile(driver = driver, host = raw, sslMode = SslMode.DISABLE)
    val uri = runCatching { URI(raw) }.getOrNull() ?: return null
    val (user, password) = (uri.rawUserInfo ?: "").split(':', limit = 2).map { URLDecoder.decode(it, "UTF-8") }.let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
    val query = uri.rawQuery.orEmpty()
    val ssl = when {
        scheme == "rediss" -> SslMode.REQUIRED
        Regex("sslmode=(require|verify-ca|verify-full)").containsMatchIn(query) || query.contains("ssl=true") -> SslMode.REQUIRED
        Regex("sslmode=disable").containsMatchIn(query) -> SslMode.DISABLE
        driver == Driver.REDIS -> SslMode.DISABLE
        else -> SslMode.PREFERRED
    }
    return ConnectionProfile(
        driver = driver,
        host = uri.host ?: "",
        port = if (uri.port > 0) uri.port else driver.defaultPort,
        user = user,
        password = password,
        database = uri.path.orEmpty().removePrefix("/").let { URLDecoder.decode(it, "UTF-8") },
        sslMode = ssl,
    )
}
