package com.brainfactory.db.engine

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** A Redis reply (RESP2). */
sealed interface Resp {
    data class Simple(val text: String) : Resp
    data class Error(val text: String) : Resp
    data class Integer(val value: Long) : Resp
    /** null is Redis's nil. */
    data class Bulk(val bytes: ByteArray?) : Resp {
        val text: String? get() = bytes?.let { decodeRedisText(it) }
        override fun equals(other: Any?) = other is Bulk && bytes.contentEqualsNullable(other.bytes)
        override fun hashCode() = bytes?.contentHashCode() ?: 0
    }
    data class Multi(val items: List<Resp>?) : Resp
}

private fun ByteArray?.contentEqualsNullable(other: ByteArray?) = if (this == null) other == null else other != null && contentEquals(other)

/** Bytes as text when they are UTF-8, else as hex (0x…), so binary values stay readable. */
fun decodeRedisText(bytes: ByteArray): String = try {
    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()
} catch (e: CharacterCodingException) {
    "0x" + bytes.toHex()
}

/** A plain Redis connection: commands go out as RESP arrays, replies come back parsed. Not thread-safe. */
class RespClient(host: String, port: Int, tls: Boolean, verify: Boolean, timeoutMs: Int = 15_000) : Closeable {
    private val socket: Socket
    private val reader: RespReader
    private val output: BufferedOutputStream

    init {
        val plain = Socket()
        plain.connect(InetSocketAddress(host, port), timeoutMs)
        plain.soTimeout = 30_000
        plain.keepAlive = true
        socket = if (tls) {
            val context = SSLContext.getInstance("TLS")
            context.init(null, if (verify) null else arrayOf<TrustManager>(TrustAll), null)
            (context.socketFactory.createSocket(plain, host, port, true) as SSLSocket).also { it.startHandshake() }
        } else plain
        reader = RespReader(BufferedInputStream(socket.getInputStream()))
        output = BufferedOutputStream(socket.getOutputStream())
    }

    var readTimeout: Int
        get() = socket.soTimeout
        set(value) { socket.soTimeout = value }

    val connected: Boolean get() = socket.isConnected && !socket.isClosed

    fun send(args: List<Any>) {
        output.write("*${args.size}\r\n".toByteArray())
        for (a in args) {
            val bytes = if (a is ByteArray) a else a.toString().toByteArray()
            output.write("$${bytes.size}\r\n".toByteArray())
            output.write(bytes)
            output.write(CRLF)
        }
    }

    fun flush() = output.flush()

    fun command(vararg args: Any): Resp = command(args.toList())

    fun command(args: List<Any>): Resp {
        send(args)
        flush()
        return read()
    }

    /** Sends all [commands] before reading any reply, so a hundred TYPE lookups cost one round trip. */
    fun pipeline(commands: List<List<Any>>): List<Resp> {
        if (commands.isEmpty()) return emptyList()
        commands.forEach { send(it) }
        flush()
        return commands.map { read() }
    }

    fun read(): Resp = reader.read()

    override fun close() {
        runCatching { socket.close() }
    }

    private object TrustAll : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
    }

    companion object {
        private val CRLF = "\r\n".toByteArray()
    }
}

/**
 * Splits a redis-cli line into arguments: spaces separate, "double" and 'single' quotes group, and inside double
 * quotes \n, \t, \r, \" and \xHH escapes work as in redis-cli. \xHH is one raw byte, so arguments are bytes:
 * text is UTF-8, `"\xff"` is the byte FF.
 */
fun splitRedisArgBytes(line: String): List<ByteArray> {
    val out = mutableListOf<ByteArray>()
    val current = java.io.ByteArrayOutputStream()
    fun text(s: String) = current.write(s.toByteArray(Charsets.UTF_8))
    var i = 0
    var inArg = false
    while (i < line.length) {
        val c = line[i]
        when {
            c == '"' -> {
                inArg = true
                i++
                while (i < line.length && line[i] != '"') {
                    if (line[i] == '\\' && i + 1 < line.length) {
                        when (val e = line[i + 1]) {
                            'n' -> text("\n")
                            't' -> text("\t")
                            'r' -> text("\r")
                            'b' -> text("\b")
                            'a' -> current.write(7)
                            'x' -> {
                                val hex = line.substring(i + 2, minOf(line.length, i + 4))
                                val byte = hex.takeIf { it.length == 2 }?.toIntOrNull(16)
                                if (byte != null) { current.write(byte); i += 2 } else text("x")
                            }
                            else -> text(e.toString())
                        }
                        i += 2
                    } else {
                        val start = i
                        while (i < line.length && line[i] != '"' && line[i] != '\\') i++
                        text(line.substring(start, i))
                    }
                }
                if (i >= line.length) throw DbException("Unbalanced quotes in the command.")
            }
            c == '\'' -> {
                inArg = true
                i++
                while (i < line.length && line[i] != '\'') {
                    if (line[i] == '\\' && i + 1 < line.length && line[i + 1] == '\'') { text("'"); i += 2 } else { text(line[i].toString()); i++ }
                }
                if (i >= line.length) throw DbException("Unbalanced quotes in the command.")
            }
            c.isWhitespace() -> if (inArg) { out += current.toByteArray(); current.reset(); inArg = false }
            else -> { inArg = true; text(c.toString()) }
        }
        i++
    }
    if (inArg) out += current.toByteArray()
    return out
}

/** The arguments of a redis-cli line as text (for the command's name and checks); see [splitRedisArgBytes]. */
fun splitRedisArgs(line: String): List<String> = splitRedisArgBytes(line).map { String(it, Charsets.UTF_8) }

/** Parses RESP replies from [input], one per [read]. */
class RespReader(private val input: InputStream) {
    fun read(): Resp {
        val type = input.read()
        if (type < 0) throw IOException("Redis closed the connection")
        val line = readLine()
        return when (type.toChar()) {
            '+' -> Resp.Simple(line)
            '-' -> Resp.Error(line)
            ':' -> Resp.Integer(line.toLong())
            '$' -> {
                val n = line.toInt()
                if (n < 0) Resp.Bulk(null) else {
                    val bytes = ByteArray(n)
                    var off = 0
                    while (off < n) {
                        val r = input.read(bytes, off, n - off)
                        if (r < 0) throw IOException("Redis closed the connection")
                        off += r
                    }
                    input.read(); input.read()
                    Resp.Bulk(bytes)
                }
            }
            '*' -> {
                val n = line.toInt()
                if (n < 0) Resp.Multi(null) else Resp.Multi(List(n) { read() })
            }
            // RESP3 types a server may send anyway: treat maps, sets and pushes as arrays, doubles as text.
            '%' -> Resp.Multi(List(line.toInt() * 2) { read() })
            '~', '>' -> Resp.Multi(List(line.toInt()) { read() })
            ',' -> Resp.Simple(line)
            '#' -> Resp.Integer(if (line == "t") 1 else 0)
            '_' -> Resp.Bulk(null)
            else -> throw IOException("Unexpected reply from Redis: ${type.toChar()}$line")
        }
    }

    private fun readLine(): String {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) throw IOException("Redis closed the connection")
            if (c == '\r'.code) {
                input.read()
                return sb.toString()
            }
            sb.append(c.toChar())
        }
    }
}
