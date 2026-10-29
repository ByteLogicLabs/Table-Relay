package com.brainfactory.db.engine

import com.mongodb.spi.dns.DnsClient
import com.mongodb.spi.dns.DnsException
import java.math.BigDecimal
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Date
import org.bson.BsonDocument
import org.bson.Document
import org.bson.json.JsonMode
import org.bson.json.JsonWriterSettings
import org.bson.types.Binary
import org.bson.types.Decimal128
import org.bson.types.ObjectId
import org.json.JSONObject

/**
 * The SRV and TXT lookups `mongodb+srv://` needs. The driver does them through JNDI, which Android doesn't have, so
 * they go to Google's and Cloudflare's DNS-over-HTTPS instead; answers are in JNDI's text form ("0 5 27017 host.").
 */
internal object DohDnsClient : DnsClient {
    private val resolvers = listOf("https://dns.google/resolve", "https://cloudflare-dns.com/dns-query")

    override fun getResourceRecordData(name: String, type: String): List<String> {
        var last: Exception? = null
        for (resolver in resolvers) {
            try {
                return lookup(resolver, name, type)
            } catch (e: Exception) {
                last = e
            }
        }
        throw DnsException("DNS lookup of $type $name failed: ${last?.message}", last)
    }

    private fun lookup(resolver: String, name: String, type: String): List<String> {
        val connection = (URL("$resolver?name=" + URLEncoder.encode(name, "UTF-8") + "&type=" + type).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Accept", "application/dns-json")
        }
        try {
            if (connection.responseCode != 200) throw java.io.IOException("$resolver answered ${connection.responseCode}")
            val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            val wanted = if (type == "SRV") 33 else 16
            val answers = json.optJSONArray("Answer") ?: return emptyList()
            return (0 until answers.length()).map { answers.getJSONObject(it) }
                .filter { it.optInt("type") == wanted }
                .map { a ->
                    val data = a.optString("data")
                    // TXT data comes quoted, possibly split into several quoted strings.
                    if (type == "TXT") Regex("\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(data).joinToString("") { it.groupValues[1] }.ifEmpty { data } else data
                }
        } finally {
            connection.disconnect()
        }
    }
}

/** A value shown as [display] (ObjectId("…"), an ISO date) but written back as [raw], the driver's own object. */
data class TaggedValue(val display: String, val raw: Any?) {
    override fun toString() = display
}

/** A field a document doesn't have (as opposed to one that is null). */
data object Absent {
    override fun toString() = ""
}

internal val SHELL_JSON: JsonWriterSettings = JsonWriterSettings.builder().outputMode(JsonMode.SHELL).build()
internal val SHELL_JSON_INDENT: JsonWriterSettings = JsonWriterSettings.builder().outputMode(JsonMode.SHELL).indent(true).build()

/** [value] as shell-mode JSON: ObjectId("…"), ISODate("…"), NumberLong(…), as mongosh writes them. */
internal fun bsonJson(value: Any?, indent: Boolean = false): String {
    val wrapped = Document("v", value).toJson(if (indent) SHELL_JSON_INDENT else SHELL_JSON)
    val start = wrapped.indexOf(':') + 1
    return wrapped.substring(start, wrapped.lastIndexOf('}')).trim()
}

/** A document's field for the grid: scalars as such, documents and arrays as [JsonText], the rest as [TaggedValue]. */
internal fun cellOf(value: Any?): Any? = when (value) {
    null -> null
    is String, is Boolean, is Int, is Long, is Double -> value
    is Decimal128 -> TaggedValue(value.bigDecimalValue().toPlainString(), value)
    is ObjectId -> TaggedValue("ObjectId(\"${value.toHexString()}\")", value)
    is Date -> TaggedValue(java.time.Instant.ofEpochMilli(value.time).toString(), value)
    is Binary -> TaggedValue("BinData(${value.type}, ${value.data.size} bytes)", value)
    is Document, is Map<*, *>, is List<*> -> JsonText(bsonJson(value))
    else -> TaggedValue(bsonJson(value), value)
}

/** A BSON value as the Java value a Document would hold (String, Integer, ObjectId, Date, Document, List…). */
internal fun fromBson(value: org.bson.BsonValue): Any? {
    val doc = org.bson.codecs.DocumentCodec().decode(
        org.bson.BsonDocumentReader(org.bson.BsonDocument("v", value)),
        org.bson.codecs.DecoderContext.builder().build(),
    )
    return doc["v"]
}

/** What a grid cell holds, back as the driver's value. */
internal fun rawOf(cell: Any?): Any? = when (cell) {
    is TaggedValue -> cell.raw
    is JsonText -> parseValue(cell.text)
    Absent -> null
    is BigDecimal -> Decimal128(cell)
    else -> cell
}

/**
 * Text typed into a cell or a filter, as a BSON value: JSON or shell syntax when it parses (42, true, null,
 * {"a": 1}, ObjectId("…"), ISODate("…")), else the text itself as a string.
 */
internal fun parseValue(text: String): Any? {
    val t = text.trim()
    if (t.isEmpty()) return text
    return runCatching { Document.parse("{\"v\": $t}")["v"] }.getOrElse { text }
}

/** A filter or document typed by hand; `{}` when blank. */
internal fun parseDocument(text: String, what: String = "document"): Document {
    if (text.isBlank()) return Document()
    return try {
        Document.parse(text)
    } catch (e: Exception) {
        throw DbException("That isn't a valid $what: ${e.message}", e)
    }
}

internal fun parseBsonDocument(text: String): BsonDocument = try {
    BsonDocument.parse(text.ifBlank { "{}" })
} catch (e: Exception) {
    throw DbException("That isn't a valid document: ${e.message}", e)
}

/** Documents as a grid: the union of their top-level fields, `_id` first, in the order they appear. */
internal fun documentsTable(docs: List<Document>, truncated: Boolean = false): ResultTable {
    val names = LinkedHashSet<String>()
    if (docs.any { it.containsKey("_id") }) names += "_id"
    docs.forEach { names += it.keys }
    val columns = names.map { ColumnMeta(it, key = it == "_id") }
    val rows = docs.map { d -> names.map { n -> if (d.containsKey(n)) cellOf(d[n]) else Absent } }
    return ResultTable(columns, rows, truncated)
}

/** The BSON type mongosh would name for [value], for the schema view. */
internal fun bsonTypeName(value: Any?): String = when (value) {
    null -> "null"
    is String -> "string"
    is Int -> "int"
    is Long -> "long"
    is Double -> "double"
    is Decimal128 -> "decimal"
    is Boolean -> "bool"
    is ObjectId -> "objectId"
    is Date -> "date"
    is Document, is Map<*, *> -> "object"
    is List<*> -> "array"
    is Binary -> "binData"
    else -> value.javaClass.simpleName.replaceFirstChar { it.lowercase() }
}
