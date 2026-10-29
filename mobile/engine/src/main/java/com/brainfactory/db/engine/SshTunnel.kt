package com.brainfactory.db.engine

import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import java.io.Closeable
import java.io.File
import org.json.JSONObject

/**
 * Trust on first use, as Table Relay does: the first time a jump host is reached its key's fingerprint is pinned,
 * and later connections refuse a host that shows a different key.
 */
class KnownHosts(private val file: File) {
    @Synchronized
    fun check(hostPort: String, fingerprint: String) {
        val known = load()
        val pinned = known.optString(hostPort).takeIf { it.isNotEmpty() }
        if (pinned == null) {
            known.put(hostPort, fingerprint)
            file.parentFile?.mkdirs()
            file.writeText(known.toString())
        } else if (pinned != fingerprint) {
            throw DbException(
                "The SSH host key of $hostPort has changed (was $pinned, now $fingerprint). " +
                    "If the server was reinstalled, forget its key in the connection's SSH settings.",
            )
        }
    }

    @Synchronized
    fun forget(hostPort: String) {
        val known = load()
        known.remove(hostPort)
        file.writeText(known.toString())
    }

    private fun load(): JSONObject = runCatching { JSONObject(file.readText()) }.getOrElse { JSONObject() }
}

/**
 * A local port forwarded through [config]'s jump host to [targetHost]:[targetPort]; the database driver connects to
 * 127.0.0.1:[localPort]. The session sends keep-alives so an idle tunnel isn't dropped by the network.
 */
class SshTunnel private constructor(private val session: Session, val localPort: Int) : Closeable {

    val alive: Boolean get() = session.isConnected

    override fun close() {
        runCatching { session.disconnect() }
    }

    companion object {
        fun open(config: SshConfig, targetHost: String, targetPort: Int, knownHosts: KnownHosts): SshTunnel {
            if (config.host.isBlank()) throw DbException("Enter the SSH host.")
            val jsch = JSch()
            if (config.auth == SshAuth.KEY) {
                if (config.privateKey.isBlank()) throw DbException("Paste the SSH private key, or choose password authentication.")
                try {
                    jsch.addIdentity(
                        "key",
                        config.privateKey.trim().toByteArray() + '\n'.code.toByte(),
                        null,
                        config.passphrase.takeIf { it.isNotEmpty() }?.toByteArray(),
                    )
                } catch (e: JSchException) {
                    throw DbException("The SSH private key couldn't be read: ${e.message}", e)
                }
            }
            val session = jsch.getSession(config.user.ifBlank { "root" }, config.host.trim(), config.port)
            if (config.auth == SshAuth.PASSWORD) session.setPassword(config.password)
            session.setConfig("StrictHostKeyChecking", "no")
            session.setConfig("PreferredAuthentications", if (config.auth == SshAuth.KEY) "publickey" else "password,keyboard-interactive")
            session.serverAliveInterval = 15_000
            session.serverAliveCountMax = 3
            try {
                session.connect(20_000)
            } catch (e: JSchException) {
                throw DbException("SSH: " + friendly(e), e)
            }
            try {
                knownHosts.check("${config.host.trim()}:${config.port}", session.hostKey.getFingerPrint(jsch))
                val port = session.setPortForwardingL("127.0.0.1", 0, targetHost.ifBlank { "127.0.0.1" }, targetPort)
                return SshTunnel(session, port)
            } catch (e: Exception) {
                session.disconnect()
                throw if (e is DbException) e else DbException("SSH: " + (e.message ?: e.javaClass.simpleName), e)
            }
        }

        private fun friendly(e: JSchException): String {
            val m = e.message.orEmpty()
            return when {
                m.contains("Auth fail", true) || m.contains("Auth cancel", true) -> "authentication failed; check the user and password or key."
                m.contains("UnknownHost", true) -> "the host couldn't be found."
                m.contains("timeout", true) -> "the connection timed out."
                m.contains("refused", true) -> "the connection was refused."
                else -> m.ifBlank { e.javaClass.simpleName }
            }
        }
    }
}
