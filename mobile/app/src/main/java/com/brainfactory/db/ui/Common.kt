package com.brainfactory.db.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.brainfactory.db.engine.Absent
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.JsonText
import com.brainfactory.db.engine.TaggedValue
import com.brainfactory.db.engine.toHex
import com.caverock.androidsvg.SVG
import java.math.BigDecimal

/** A cell's value as the grid shows it: [nullText] for NULL, binary as hex, numbers plainly. */
fun formatCell(value: Any?, nullText: String, maxLength: Int = 300): String = when (value) {
    null -> nullText
    Absent -> ""
    is ByteArray -> if (value.size <= 32) "0x" + value.toHex() else "0x" + value.copyOf(32).toHex() + "… (${value.size} bytes)"
    is BigDecimal -> value.toPlainString()
    is Double -> if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
    is JsonText -> value.text
    is TaggedValue -> value.display
    else -> value.toString()
}.let { if (it.length > maxLength) it.take(maxLength) + "…" else it }.replace('\n', ' ')

/** A cell's whole value, for the cell sheet and editing. */
fun fullCell(value: Any?): String = when (value) {
    null, Absent -> ""
    is ByteArray -> "0x" + value.toHex()
    is BigDecimal -> value.toPlainString()
    is JsonText -> prettyJson(value.text)
    is TaggedValue -> value.display
    else -> value.toString()
}

/** Indents JSON for reading; text that isn't JSON comes back as it was. */
fun prettyJson(text: String): String = runCatching {
    val t = text.trim()
    when {
        t.startsWith("{") -> org.json.JSONObject(t).toString(2)
        t.startsWith("[") -> org.json.JSONArray(t).toString(2)
        else -> text
    }
}.getOrDefault(text).replace("\\/", "/")

fun isNumeric(value: Any?) = value is Number

fun copyToClipboard(context: Context, text: String, label: String = "Brain DB") {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    // Android 13+ shows its own confirmation.
    if (android.os.Build.VERSION.SDK_INT < 33) Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

private val logoCache = mutableMapOf<Driver, ImageBitmap?>()

private fun driverAsset(driver: Driver) = when (driver) {
    Driver.MYSQL -> "mysql"
    Driver.POSTGRES -> "postgres"
    Driver.SQLITE -> "sqlite"
    Driver.MONGO -> "mongo"
    Driver.REDIS -> "redis"
}

/** The driver's logo, Table Relay's own SVG. */
@Composable
fun DriverLogo(driver: Driver, size: Dp = 28.dp, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val bitmap = remember(driver) {
        logoCache.getOrPut(driver) {
            runCatching {
                val svg = context.assets.open("drivers/${driverAsset(driver)}.svg").use { SVG.getFromInputStream(it) }
                val px = 128
                svg.setDocumentWidth(px.toFloat())
                svg.setDocumentHeight(px.toFloat())
                val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
                svg.renderToCanvas(Canvas(bmp))
                bmp.asImageBitmap()
            }.getOrNull()
        }
    }
    if (bitmap != null) Image(bitmap, driver.label, modifier.size(size))
}

/** "12 ms", "1.4 s". */
fun formatMillis(ms: Long): String = if (ms < 1000) "$ms ms" else "%.1f s".format(ms / 1000.0)

/** "3,037". */
fun formatCount(n: Long): String = "%,d".format(n)
