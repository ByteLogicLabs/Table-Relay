package com.brainfactory.db.host

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.brainfactory.db.engine.ConnectionProfile
import com.brainfactory.db.engine.DbSession
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.EngineEnv
import com.brainfactory.db.engine.SslMode
import com.brainfactory.db.engine.openSession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Each engine end to end on a device: download from Termux's repository (signature and hashes checked), set up, start,
 * connect with Brain DB's driver, stop, start again and find the data still there. Needs internet; the ports are
 * high ones no other test uses. The password has a quote, a backslash and a double quote in it, which each engine's
 * config or SQL has to carry through.
 */
@RunWith(AndroidJUnit4::class)
class LocalServersTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val host = LocalHost.get(context)
    private val env = EngineEnv(context.cacheDir)
    private val password = "it's a \\ \"test\""

    private fun log(message: String) = Log.i("LocalServersTest", message)

    private fun profile(server: LocalServer) = ConnectionProfile(
        name = server.name,
        driver = when (server.engine) {
            Engine.POSTGRESQL -> Driver.POSTGRES
            Engine.MARIADB -> Driver.MYSQL
            Engine.REDIS, Engine.VALKEY -> Driver.REDIS
        },
        host = "127.0.0.1",
        port = server.port,
        user = server.engine.user.orEmpty(),
        password = server.password,
        database = when (server.engine) {
            Engine.POSTGRESQL -> "postgres"
            Engine.REDIS, Engine.VALKEY -> "0"
            Engine.MARIADB -> ""
        },
        sslMode = SslMode.DISABLE,
    )

    private fun DbSession.run(text: String): List<List<Any?>> {
        val results = execute(text)
        results.firstOrNull { !it.ok }?.let { fail("$text failed: ${it.error}") }
        return results.last().table?.rows.orEmpty()
    }

    /** Installs [engine], runs [first] on a new server, restarts it and runs [second]; deletes the server after. */
    private fun roundTrip(engine: Engine, port: Int, first: DbSession.() -> Unit, second: DbSession.() -> Unit) = runBlocking {
        val release = host.releases().first { it.engine == engine }
        log("${engine.label} ${release.version}: ${release.packages.size} packages, ${release.downloadSize / 1000} kB")
        val started = System.currentTimeMillis()
        val install = host.install(release)
        log("installed ${install.id} (${install.bytes / 1000} kB unpacked) in ${System.currentTimeMillis() - started} ms")
        val server = LocalServer(name = "test ${engine.label}", engine = engine, install = install.id, port = port, password = password)
        try {
            val t0 = System.currentTimeMillis()
            host.start(server)
            log("set up and started in ${System.currentTimeMillis() - t0} ms: ${host.state(server.id)}")
            assertTrue(host.state(server.id) is ServerState.Running)
            openSession(profile(server), env).use { it.first() }
            host.stop(server.id)
            assertEquals(ServerState.Stopped, host.state(server.id))
            val t1 = System.currentTimeMillis()
            host.start(server)
            log("started again in ${System.currentTimeMillis() - t1} ms")
            openSession(profile(server), env).use { it.second() }
            host.stop(server.id)
        } catch (e: Throwable) {
            log("failed; log:\n" + runCatching { host.log(server.id).readText().takeLast(6000) }.getOrDefault(""))
            throw e
        } finally {
            host.delete(server.id)
        }
    }

    @Test
    fun postgresql() = roundTrip(
        Engine.POSTGRESQL, 25999,
        first = {
            log(run("SELECT version()").toString())
            run("CREATE TABLE kota (id serial PRIMARY KEY, nama text NOT NULL); INSERT INTO kota (nama) VALUES ('Bandung'), ('Jakarta')")
            // The builtin C.UTF-8 locale: Unicode-aware case mapping without ICU
            assertEquals("ÉCOLE", run("SELECT upper('école')")[0][0])
            assertEquals("sync", run("SHOW io_method")[0][0])
            assertEquals("127.0.0.1", run("SHOW listen_addresses")[0][0])
        },
        second = {
            assertEquals(listOf("Bandung", "Jakarta"), run("SELECT nama FROM kota ORDER BY id").map { it[0] })
        },
    )

    @Test
    fun mariadb() = roundTrip(
        Engine.MARIADB, 23999,
        first = {
            log(run("SELECT VERSION()").toString())
            run("CREATE DATABASE toko; CREATE TABLE toko.barang (id INT AUTO_INCREMENT PRIMARY KEY, nama VARCHAR(50)); INSERT INTO toko.barang (nama) VALUES ('kopi'), ('teh')")
            assertEquals(listOf("%", "localhost"), run("SELECT Host FROM mysql.user WHERE User = 'root' ORDER BY Host").map { it[0] })
            assertTrue(run("SHOW ENGINES").any { it[0] == "InnoDB" })
        },
        second = {
            assertEquals(listOf("kopi", "teh"), run("SELECT nama FROM toko.barang ORDER BY id").map { it[0] })
        },
    )

    @Test
    fun redis() = redisLike(Engine.REDIS, 26999)

    @Test
    fun valkey() = redisLike(Engine.VALKEY, 26998)

    private fun redisLike(engine: Engine, port: Int) = roundTrip(
        engine, port,
        first = {
            log(run("INFO server").filter { it[1] == "redis_version" || it[1] == "valkey_version" }.toString())
            run("SET greeting \"halo dunia\"\nRPUSH antrian a b c")
        },
        // SIGTERM makes it save its dataset (the config has save points), so the restart finds it
        second = {
            assertEquals("halo dunia", run("GET greeting")[0][0])
            assertEquals(3, run("LRANGE antrian 0 -1").size)
        },
    )
}
