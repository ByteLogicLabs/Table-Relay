package com.brainfactory.db.host

/** Something about local servers went wrong in a way worth telling the user as is. */
class HostException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** One package of an apt repository's index (a stanza of its Packages file). */
data class DebPackage(
    val name: String,
    /** The Debian version, `[epoch:]upstream[-revision]` ("1:8.10.2", "9.1.2-2"). */
    val version: String,
    /** Each entry is one dependency: its alternatives ("a | b"), version constraints dropped. */
    val depends: List<List<String>>,
    /** The path of the .deb under the repository's root. */
    val filename: String,
    val sha256: String,
    val size: Long,
    /** Bytes on disk once unpacked (the index gives KiB). */
    val installedSize: Long,
)

/** The upstream part of a Debian version: "1:8.10.2" → "8.10.2", "9.1.2-2" → "9.1.2". */
fun upstreamVersion(debVersion: String): String {
    val v = debVersion.substringAfter(':')
    return if ('-' in v) v.substringBeforeLast('-') else v
}

/**
 * An index's packages by name, each name's versions newest first. Fields continued on indented lines are joined;
 * stanzas missing what a download needs (Filename, SHA256, Size) are skipped.
 */
fun parsePackages(text: String): Map<String, List<DebPackage>> {
    val byName = HashMap<String, MutableList<DebPackage>>()
    for (stanza in text.replace("\r\n", "\n").split(Regex("\n\\s*\n"))) {
        val fields = HashMap<String, String>()
        var key: String? = null
        for (line in stanza.lines()) {
            if (line.isBlank()) continue
            if (line[0] == ' ' || line[0] == '\t') {
                key?.let { fields[it] = fields[it] + "\n" + line.trim() }
                continue
            }
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            key = line.substring(0, colon)
            fields[key] = line.substring(colon + 1).trim()
        }
        val pkg = DebPackage(
            name = fields["Package"] ?: continue,
            version = fields["Version"] ?: continue,
            depends = listOfNotNull(fields["Pre-Depends"], fields["Depends"]).flatMap(::parseDepends),
            filename = fields["Filename"] ?: continue,
            sha256 = fields["SHA256"]?.lowercase() ?: continue,
            size = fields["Size"]?.toLongOrNull() ?: continue,
            installedSize = (fields["Installed-Size"]?.toLongOrNull() ?: 0) * 1024,
        )
        byName.getOrPut(pkg.name) { mutableListOf() } += pkg
    }
    return byName.mapValues { (_, versions) -> versions.sortedWith { a, b -> compareDebVersions(b.version, a.version) } }
}

/** "libc++, openssl (>= 3.0) | libressl" → [[libc++], [openssl, libressl]]. */
internal fun parseDepends(field: String): List<List<String>> = field.split(',').mapNotNull { dep ->
    dep.split('|').map { it.replace(Regex("\\(.*?\\)|\\[.*?]"), "").trim().substringBefore(':') }.filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() }
}

/**
 * [root] and every package it needs, [root] first. Each dependency takes the newest version the index has, and the
 * first alternative it has.
 */
fun resolveDependencies(index: Map<String, List<DebPackage>>, root: DebPackage): List<DebPackage> {
    val picked = LinkedHashMap<String, DebPackage>()
    val queue = ArrayDeque(listOf(root))
    while (queue.isNotEmpty()) {
        val pkg = queue.removeFirst()
        if (pkg.name in picked) continue
        picked[pkg.name] = pkg
        for (alternatives in pkg.depends) {
            val name = alternatives.firstOrNull { it in index }
                ?: throw HostException("${pkg.name} needs ${alternatives.joinToString(" or ")}, which the repository doesn't have.")
            if (name !in picked) queue += index.getValue(name).first()
        }
    }
    return picked.values.toList()
}

/** Compares Debian versions as dpkg does: epoch, then upstream version, then revision; `~` sorts before anything. */
fun compareDebVersions(a: String, b: String): Int {
    fun epoch(v: String) = if (':' in v) v.substringBefore(':').toIntOrNull() ?: 0 else 0
    fun split(v: String): Pair<String, String> {
        val rest = v.substringAfter(':')
        return if ('-' in rest) rest.substringBeforeLast('-') to rest.substringAfterLast('-') else rest to ""
    }
    val byEpoch = epoch(a).compareTo(epoch(b))
    if (byEpoch != 0) return byEpoch
    val (ua, ra) = split(a)
    val (ub, rb) = split(b)
    return verrevcmp(ua, ub).takeIf { it != 0 } ?: verrevcmp(ra, rb)
}

/** dpkg's verrevcmp: alternating runs of non-digits (compared by [order]) and digits (compared as numbers). */
private fun verrevcmp(a: String, b: String): Int {
    fun digit(c: Char) = c in '0'..'9'
    fun order(c: Char): Int = when {
        digit(c) || c == '\u0000' -> 0
        c in 'a'..'z' || c in 'A'..'Z' -> c.code
        c == '~' -> -1
        else -> c.code + 256
    }
    fun at(s: String, k: Int) = if (k < s.length) s[k] else '\u0000'
    var i = 0
    var j = 0
    while (i < a.length || j < b.length) {
        var firstDiff = 0
        while ((i < a.length && !digit(a[i])) || (j < b.length && !digit(b[j]))) {
            val ac = order(at(a, i))
            val bc = order(at(b, j))
            if (ac != bc) return ac - bc
            i++
            j++
        }
        while (at(a, i) == '0') i++
        while (at(b, j) == '0') j++
        while (digit(at(a, i)) && digit(at(b, j))) {
            if (firstDiff == 0) firstDiff = at(a, i) - at(b, j)
            i++
            j++
        }
        if (digit(at(a, i))) return 1
        if (digit(at(b, j))) return -1
        if (firstDiff != 0) return firstDiff
    }
    return 0
}
