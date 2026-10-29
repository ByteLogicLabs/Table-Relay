package com.brainfactory.db.engine

import java.io.Writer
import java.math.BigDecimal
import org.json.JSONArray
import org.json.JSONObject

/** The formats a result or a table can be saved in, as the desktop's Export offers them. */
enum class ExportFormat(val label: String, val extension: String, val mime: String) {
    CSV("CSV", "csv", "text/csv"),
    TSV("TSV", "tsv", "text/tab-separated-values"),
    JSON("JSON", "json", "application/json"),
    NDJSON("NDJSON", "ndjson", "application/x-ndjson"),
    SQL("SQL INSERT", "sql", "application/sql"),
}

/** Writes rows in [format]; [table] names the INSERT target for SQL. Values are written as the grid shows them. */
class ResultExporter(private val format: ExportFormat, private val columns: List<String>, private val out: Writer, private val dialect: SqlDialect, private val table: String) {
    private var count = 0

    fun begin() {
        when (format) {
            ExportFormat.CSV -> line(columns.joinToString(",") { csv(it) })
            ExportFormat.TSV -> line(columns.joinToString("\t") { tsv(it) })
            ExportFormat.JSON -> out.write("[\n")
            else -> Unit
        }
    }

    fun row(values: List<Any?>) {
        when (format) {
            ExportFormat.CSV -> line(values.joinToString(",") { v -> if (v == null) "" else csv(text(v)) })
            ExportFormat.TSV -> line(values.joinToString("\t") { v -> if (v == null) "" else tsv(text(v)) })
            ExportFormat.JSON -> {
                if (count > 0) out.write(",\n")
                out.write("  " + jsonObject(values))
            }
            ExportFormat.NDJSON -> line(jsonObject(values))
            ExportFormat.SQL -> line(
                "INSERT INTO " + dialect.quote(table) + " (" + columns.joinToString(", ") { dialect.quote(it) } + ") VALUES (" +
                    values.joinToString(", ") { v -> dialect.literal(sqlValue(v)) } + ");",
            )
        }
        count++
    }

    fun end() {
        if (format == ExportFormat.JSON) out.write(if (count > 0) "\n]\n" else "]\n")
        out.flush()
    }

    private fun line(s: String) {
        out.write(s)
        out.write("\n")
    }

    /** A row as a JSON object with its keys in column order (org.json's objects don't keep an order). */
    private fun jsonObject(values: List<Any?>): String = columns.indices
        .filter { values.getOrNull(it) !== Absent }
        .joinToString(",", "{", "}") { i -> JSONObject.quote(columns[i]) + ":" + jsonValue(values.getOrNull(i)) }

    private fun jsonValue(v: Any?): String = when (v) {
        null -> "null"
        is Boolean, is Int, is Long, is Short, is Byte -> v.toString()
        is Double -> if (v.isFinite()) v.toString() else JSONObject.quote(v.toString())
        is Float -> if (v.isFinite()) v.toString() else JSONObject.quote(v.toString())
        is BigDecimal -> v.toPlainString()
        is Number -> v.toString()
        // JSON from the database goes in as it is (its own key order kept) when it is valid JSON.
        is JsonText -> v.text.trim().takeIf { t -> runCatching { if (t.startsWith("[")) JSONArray(t) else JSONObject(t) }.isSuccess } ?: JSONObject.quote(v.text)
        is ByteArray -> JSONObject.quote("0x" + v.toHex())
        else -> JSONObject.quote(v.toString())
    }

    private fun sqlValue(v: Any?): Any? = when (v) {
        is JsonText -> v.text
        is TaggedValue -> v.display
        Absent -> null
        else -> v
    }

    private fun text(v: Any): String = when (v) {
        is ByteArray -> "0x" + v.toHex()
        else -> v.toString()
    }

    private fun csv(s: String) = if (s.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

    private fun tsv(s: String) = s.replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")
}
