package com.brainfactory.db.engine

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** MySQL's spatial types, whose values arrive as bytes. */
internal val MYSQL_GEOMETRY_TYPES = setOf("GEOMETRY", "POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON", "GEOMETRYCOLLECTION", "GEOMCOLLECTION")

/**
 * A MySQL geometry value (a 4-byte SRID, then WKB) as WKT: "POINT(1 2)", with "SRID=4326;" in front when the SRID
 * isn't 0. Null when the bytes aren't a geometry this reads.
 */
fun mysqlGeometryToWkt(bytes: ByteArray): String? = runCatching {
    val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val srid = buf.int
    val wkt = readWkb(buf)
    if (buf.hasRemaining()) return null
    if (srid != 0) "SRID=$srid;$wkt" else wkt
}.getOrNull()

private fun readWkb(buf: ByteBuffer): String {
    buf.order(if (buf.get().toInt() == 0) ByteOrder.BIG_ENDIAN else ByteOrder.LITTLE_ENDIAN)
    fun number(d: Double) = if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()
    fun point() = number(buf.double) + " " + number(buf.double)
    fun points() = (0 until buf.int).joinToString(", ") { point() }
    fun rings() = (0 until buf.int).joinToString(", ") { "(" + points() + ")" }
    fun parts(prefix: String) = (0 until buf.int).joinToString(", ") { readWkb(buf).removePrefix(prefix) }
    return when (val type = buf.int) {
        1 -> "POINT(" + point() + ")"
        2 -> "LINESTRING(" + points() + ")"
        3 -> "POLYGON(" + rings() + ")"
        4 -> "MULTIPOINT(" + parts("POINT") + ")"
        5 -> "MULTILINESTRING(" + parts("LINESTRING") + ")"
        6 -> "MULTIPOLYGON(" + parts("POLYGON") + ")"
        7 -> "GEOMETRYCOLLECTION(" + (0 until buf.int).joinToString(", ") { readWkb(buf) } + ")"
        else -> throw IllegalArgumentException("WKB type $type")
    }
}
