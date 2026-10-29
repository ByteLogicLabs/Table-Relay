package com.brainfactory.db.host

import java.io.EOFException
import java.io.FilterInputStream
import java.io.InputStream
import java.util.zip.GZIPInputStream
import org.tukaani.xz.XZInputStream

/** A view of the next [length] bytes of [input]; closing it doesn't close [input]. */
internal class BoundedInputStream(input: InputStream, private var remaining: Long) : FilterInputStream(input) {
    override fun read(): Int {
        if (remaining <= 0) return -1
        val b = super.read()
        if (b >= 0) remaining-- else throw EOFException("The archive ends early.")
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), remaining).toInt())
        if (n < 0) throw EOFException("The archive ends early.")
        remaining -= n
        return n
    }

    override fun skip(n: Long): Long {
        val skipped = super.skip(minOf(n, remaining))
        remaining -= skipped
        return skipped
    }

    override fun available(): Int = minOf(super.available().toLong(), remaining).toInt()
    override fun close() {}
    override fun markSupported() = false

    /** Reads past whatever is left. */
    fun drain() {
        val buffer = ByteArray(8192)
        while (remaining > 0) if (read(buffer) < 0) break
    }
}

/** Fills [buffer] from [input]; false at a clean end of stream, an error when it ends part way. */
internal fun readFully(input: InputStream, buffer: ByteArray): Boolean {
    var off = 0
    while (off < buffer.size) {
        val n = input.read(buffer, off, buffer.size - off)
        if (n < 0) {
            if (off == 0) return false
            throw EOFException("The archive ends early.")
        }
        off += n
    }
    return true
}

/**
 * Hands [onData] the data.tar of a .deb (an ar archive holding debian-binary, control.tar.* and data.tar.*),
 * decompressed. Termux compresses it with xz; gzip and none are read too.
 */
internal fun readDebData(input: InputStream, onData: (InputStream) -> Unit) {
    val magic = ByteArray(8)
    if (!readFully(input, magic) || String(magic, Charsets.US_ASCII) != "!<arch>\n") throw HostException("The download isn't a .deb package.")
    val header = ByteArray(60)
    while (readFully(input, header)) {
        val name = String(header, 0, 16, Charsets.US_ASCII).trim().trimEnd('/')
        val size = String(header, 48, 10, Charsets.US_ASCII).trim().toLongOrNull() ?: throw HostException("The .deb package is damaged.")
        val body = BoundedInputStream(input, size)
        when (name) {
            "data.tar.xz" -> return onData(XZInputStream(body))
            "data.tar.gz" -> return onData(GZIPInputStream(body))
            "data.tar" -> return onData(body)
            else -> if (name.startsWith("data.tar")) throw HostException("The package's $name uses a compression Brain DB can't unpack.")
        }
        body.drain()
        if (size % 2 == 1L) input.read()
    }
    throw HostException("The .deb package has no data.")
}

/** One entry of a tar archive. [type] is tar's type flag: '0' file, '1' hard link, '2' symlink, '5' directory. */
internal class TarEntry(val name: String, val type: Char, val mode: Int, val size: Long, val linkName: String)

/**
 * Calls [onEntry] for each entry of a tar archive (POSIX ustar, with GNU long names and pax path headers), with a
 * stream of its contents; whatever [onEntry] leaves unread is skipped.
 */
internal fun readTar(input: InputStream, onEntry: (TarEntry, InputStream) -> Unit) {
    val block = ByteArray(512)
    var longName: String? = null
    var longLink: String? = null
    var paxPath: String? = null
    var paxLink: String? = null
    while (readFully(input, block)) {
        if (block.all { it == 0.toByte() }) break
        val type = block[156].toInt().toChar()
        val size = tarNumber(block, 124, 12)
        val data = BoundedInputStream(input, size)
        when (type) {
            'L' -> longName = String(data.readBytes(), Charsets.UTF_8).trimEnd('\u0000')
            'K' -> longLink = String(data.readBytes(), Charsets.UTF_8).trimEnd('\u0000')
            'x' -> paxRecords(String(data.readBytes(), Charsets.UTF_8)).let { pax ->
                pax["path"]?.let { paxPath = it }
                pax["linkpath"]?.let { paxLink = it }
            }
            'g' -> data.drain()
            else -> {
                var name = tarString(block, 0, 100)
                val ustar = String(block, 257, 5, Charsets.US_ASCII) == "ustar"
                val prefix = if (ustar) tarString(block, 345, 155) else ""
                if (prefix.isNotEmpty()) name = "$prefix/$name"
                val entry = TarEntry(
                    name = paxPath ?: longName ?: name,
                    type = type,
                    mode = tarNumber(block, 100, 8).toInt(),
                    size = size,
                    linkName = paxLink ?: longLink ?: tarString(block, 157, 100),
                )
                longName = null
                longLink = null
                paxPath = null
                paxLink = null
                onEntry(entry, data)
            }
        }
        data.drain()
        val padding = (512 - size % 512) % 512
        var skipped = 0L
        while (skipped < padding) {
            if (input.read() < 0) throw EOFException("The archive ends early.")
            skipped++
        }
    }
}

private fun tarString(block: ByteArray, offset: Int, length: Int): String {
    var end = offset
    while (end < offset + length && block[end] != 0.toByte()) end++
    return String(block, offset, end - offset, Charsets.UTF_8)
}

/** An octal field, or GNU's base-256 form (high bit set) for sizes over 8 GiB. */
private fun tarNumber(block: ByteArray, offset: Int, length: Int): Long {
    if (block[offset].toInt() and 0x80 != 0) {
        var value = (block[offset].toLong() and 0x7f)
        for (i in offset + 1 until offset + length) value = (value shl 8) or (block[i].toLong() and 0xff)
        return value
    }
    val text = tarString(block, offset, length).trim(' ', '\u0000')
    return if (text.isEmpty()) 0 else text.toLongOrNull(8) ?: throw HostException("The archive is damaged.")
}

/** pax extended header records: "<length> <key>=<value>\n", the length counting the whole record. */
private fun paxRecords(text: String): Map<String, String> {
    val out = HashMap<String, String>()
    val bytes = text.toByteArray(Charsets.UTF_8)
    var pos = 0
    while (pos < bytes.size) {
        var space = pos
        while (space < bytes.size && bytes[space] != ' '.code.toByte()) space++
        val length = String(bytes, pos, space - pos, Charsets.US_ASCII).toIntOrNull() ?: break
        if (length <= 0 || pos + length > bytes.size) break
        val record = String(bytes, space + 1, pos + length - space - 2, Charsets.UTF_8)
        val eq = record.indexOf('=')
        if (eq > 0) out[record.substring(0, eq)] = record.substring(eq + 1)
        pos += length
    }
    return out
}
