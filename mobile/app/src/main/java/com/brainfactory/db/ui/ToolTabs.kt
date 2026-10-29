package com.brainfactory.db.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.Settings
import com.brainfactory.db.engine.ExportFormat
import com.brainfactory.db.engine.ResultExporter
import com.brainfactory.db.engine.ResultTable
import com.brainfactory.db.workspace.ProcessState
import com.brainfactory.db.workspace.RealtimeState
import com.brainfactory.db.workspace.TableState
import com.brainfactory.db.workspace.WorkTab
import com.brainfactory.db.workspace.Workspace
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val CLOCK = SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault())

/** A routine's, trigger's or view's CREATE statement, read-only, with a way into the query editor. */
@Composable
fun DefinitionTab(ws: Workspace, tab: WorkTab.Definition) {
    val t = bd
    val context = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(tab.obj.kind.label.removeSuffix("s") + " " + tab.obj.name, color = t.text, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            IconButton(onClick = { copyToClipboard(context, tab.text) }) { Icon(Icons.Outlined.ContentCopy, "Copy", tint = t.textDim) }
            IconButton(onClick = { ws.openInQuery(tab.text) }) { Icon(Icons.Outlined.Terminal, "Open in query", tint = t.textDim) }
        }
        BdDivider()
        SelectionContainer(Modifier.weight(1f)) {
            Text(
                remember(tab.text, t) { SyntaxHighlight(ws.profile.driver.language, t).filter(androidx.compose.ui.text.AnnotatedString(tab.text)).text },
                style = monoStyle(13), color = t.text,
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(12.dp),
            )
        }
    }
}

/** Running queries or clients; tap a row to end it. */
@Composable
fun ProcessTab(ws: Workspace, state: ProcessState) {
    val t = bd
    val context = LocalContext.current
    val settings = remember { Settings.get(context) }
    val scope = rememberCoroutineScope()
    var kill by remember { mutableStateOf<Any?>(null) }
    var result by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            val noun = if (ws.profile.driver == com.brainfactory.db.engine.Driver.REDIS) "client" else "process"
            Text(state.table?.let { "${it.rows.size} $noun" + if (it.rows.size == 1) "" else if (noun == "process") "es" else "s" } ?: "", color = t.textDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
            BdSwitchRow("Auto-refresh", state.auto, { state.toggleAuto() }, Modifier.width(190.dp), inset = 0.dp)
            IconButton(onClick = { state.load() }) { Icon(Icons.Filled.Refresh, "Refresh", tint = t.textDim) }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = t.accent, trackColor = Color.Transparent)
        BdDivider()
        state.error?.let { Text(it, color = t.danger, fontSize = 13.sp, modifier = Modifier.padding(12.dp)) }
        val table = state.table
        if (table != null) {
            DataGrid(table, settings.nullText, settings.gridFontSize, Modifier.weight(1f).fillMaxWidth(), onRowClick = { row -> kill = table.rows[row].firstOrNull() }, onCellClick = { row, _ -> kill = table.rows[row].firstOrNull() })
        } else if (state.loading) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = t.accent) }
        Text("Tap a row to end that ${if (ws.profile.driver == com.brainfactory.db.engine.Driver.REDIS) "client" else "process"}.", color = t.textFaint, fontSize = 12.sp, modifier = Modifier.padding(8.dp))
    }
    if (kill != null) {
        val id = kill
        BdDialog("End $id?", { kill = null }, confirmLabel = "End", danger = true, confirmEnabled = !ws.profile.readOnly, onConfirm = {
            kill = null
            scope.launch { result = state.kill(id) }
        }) { Text(if (ws.profile.readOnly) "This connection is read-only." else "The server stops what it is running and closes the connection.", color = t.textDim) }
    }
    result?.let { m -> BdDialog("Couldn't end it", { result = null }, confirmLabel = "OK", onConfirm = { result = null }, dismissLabel = null) { Text(m) } }
}

/** Every statement the workspace ran (grid reads and edits, queries), newest first: the desktop's Query Log. */
@Composable
fun LogTab(ws: Workspace) {
    val t = bd
    val context = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${ws.log.size} statement${if (ws.log.size == 1) "" else "s"}", color = t.textDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
            BdButton("Clear", { ws.log.clear() }, enabled = ws.log.isNotEmpty())
        }
        BdDivider()
        if (ws.log.isEmpty()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Statements appear here as they run.", color = t.textFaint) }
        LazyColumn(Modifier.fillMaxSize()) {
            items(ws.log) { e ->
                Column(Modifier.fillMaxWidth().clickable { copyToClipboard(context, e.statement) }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(
                        "-- ${CLOCK.format(Date(e.time))} · ${formatMillis(e.millis)} · " + (if (e.error == null) "OK" else "ERROR") + " · ${e.source}",
                        color = if (e.error == null) t.textFaint else t.danger, style = monoStyle(11),
                    )
                    Text(
                        remember(e.statement, t) { SyntaxHighlight(ws.profile.driver.language, t).filter(androidx.compose.ui.text.AnnotatedString(e.statement)).text },
                        style = monoStyle(12), color = t.text, maxLines = 6, overflow = TextOverflow.Ellipsis,
                    )
                    e.error?.let { Text(it, color = t.danger, fontSize = 12.sp, maxLines = 4, overflow = TextOverflow.Ellipsis) }
                }
                BdDivider()
            }
        }
    }
}

/** Subscribe to channels (or watch collections), see messages arrive, and publish. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RealtimeTab(ws: Workspace, state: RealtimeState) {
    val t = bd
    val scope = rememberCoroutineScope()
    var target by remember { mutableStateOf("") }
    var pubChannel by remember { mutableStateOf("") }
    var payload by remember { mutableStateOf("") }
    val canPublish = ws.profile.driver != com.brainfactory.db.engine.Driver.MONGO
    val label = when (ws.profile.driver) {
        com.brainfactory.db.engine.Driver.POSTGRES -> "Channel"
        com.brainfactory.db.engine.Driver.REDIS -> "Channel or pattern (news.*)"
        else -> "Collection (* for the whole database)"
    }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().background(t.panel).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ws.capabilities.realtime ?: "Realtime", color = t.text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BdTextField(target, { target = it }, Modifier.weight(1f), placeholder = label, imeAction = ImeAction.Done, onAction = { state.subscribe(target); target = "" })
                BdButton(if (ws.profile.driver == com.brainfactory.db.engine.Driver.MONGO) "Watch" else "Subscribe", { state.subscribe(target); target = "" }, primary = true, enabled = target.isNotBlank() && !state.connecting)
            }
            if (state.subscriptions.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    state.subscriptions.forEach { s ->
                        Row(Modifier.background(t.selection, SmallRadius).padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(s, color = t.text, fontSize = 13.sp)
                            IconButton(onClick = { state.unsubscribe(s) }, modifier = Modifier.size(30.dp)) { Icon(Icons.Filled.Close, "Unsubscribe $s", tint = t.textDim, modifier = Modifier.size(14.dp)) }
                        }
                    }
                }
            }
            if (canPublish) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BdTextField(pubChannel, { pubChannel = it }, Modifier.weight(0.8f), placeholder = "Channel")
                    BdTextField(payload, { payload = it }, Modifier.weight(1.2f), placeholder = "Message")
                    BdButton("Publish", {
                        val c = pubChannel
                        val p = payload
                        scope.launch { state.publish(c, p)?.let { state.error = it } ?: run { payload = "" } }
                    }, enabled = pubChannel.isNotBlank())
                }
            }
            state.error?.let { Text(it, color = t.danger, fontSize = 13.sp) }
        }
        BdDivider()
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${state.messages.size} message${if (state.messages.size == 1) "" else "s"}", color = t.textDim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            BdSwitchRow("Pause", state.paused, { state.paused = it }, Modifier.width(130.dp), inset = 0.dp)
            BdButton("Clear", { state.messages.clear() })
        }
        BdDivider()
        if (state.messages.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (state.subscriptions.isEmpty()) "Subscribe to a channel to see its messages." else "Waiting for messages…", color = t.textFaint)
            }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
            items(state.messages) { m ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Row {
                        Text(m.channel, color = t.accent, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                        Text(CLOCK.format(Date(m.time)), color = t.textFaint, style = monoStyle(11))
                    }
                    SelectionContainer { Text(m.payload, style = monoStyle(12), color = t.text, maxLines = 20, overflow = TextOverflow.Ellipsis) }
                }
                BdDivider()
            }
        }
    }
}

/**
 * Saves rows as CSV, TSV, JSON, NDJSON or SQL INSERTs: a query [result] as it is, or a whole table (all pages
 * matching the tab's filters, read in batches, with progress and a Cancel).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ExportDialog(ws: Workspace, onDismiss: () -> Unit, tableState: TableState?, result: ResultTable?, baseName: String) {
    val t = bd
    val context = LocalContext.current
    var format by remember { mutableStateOf(ExportFormat.CSV) }
    var progress by remember { mutableLongStateOf(-1L) }
    var done by remember { mutableStateOf<String?>(null) }
    var job by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    val total = tableState?.total

    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(format.mime)) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        job = scope.launch {
            progress = 0
            done = runCatching {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri, "wt")!!.bufferedWriter().use { out ->
                        if (result != null) {
                            val exporter = ResultExporter(format, result.columns.map { it.name }, out, ws.profile.driver.dialect, baseName)
                            exporter.begin()
                            result.rows.forEach { exporter.row(it); progress++ }
                            exporter.end()
                        } else if (tableState != null) {
                            var offset = 0L
                            var exporter: ResultExporter? = null
                            while (isActive) {
                                val req = tableState.request.copy(offset = offset, limit = 1000)
                                val page = ws.call { it.browse(tableState.ref, req) }
                                if (exporter == null) {
                                    exporter = ResultExporter(format, page.table.columns.map { it.name }, out, ws.profile.driver.dialect, tableState.ref.name)
                                    exporter.begin()
                                }
                                page.table.rows.forEach { exporter.row(it) }
                                offset += page.table.rows.size
                                withContext(Dispatchers.Main) { progress = offset }
                                if (page.table.rows.size < 1000) break
                            }
                            exporter?.end()
                        }
                    }
                }
            }.fold({ "Exported ${formatCount(progress)} row${if (progress == 1L) "" else "s"}." }, { if (it is kotlinx.coroutines.CancellationException) "Export cancelled." else "Export failed: ${it.message}" })
        }
    }

    if (done != null) {
        BdDialog("Export", onDismiss, confirmLabel = "OK", onConfirm = onDismiss, dismissLabel = null) { Text(done!!) }
        return
    }
    if (progress >= 0) {
        BdDialog("Exporting…", { job?.cancel(); onDismiss() }, confirmLabel = null, dismissLabel = "Cancel") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(formatCount(progress) + (total?.let { " of " + formatCount(it) } ?: "") + " rows", color = t.text)
                if (total != null && total > 0) LinearProgressIndicator(progress = { (progress.toFloat() / total).coerceIn(0f, 1f) }, Modifier.fillMaxWidth(), color = t.accent, trackColor = t.field)
                else LinearProgressIndicator(Modifier.fillMaxWidth(), color = t.accent, trackColor = t.field)
            }
        }
        return
    }
    BdDialog("Export", onDismiss, confirmLabel = "Export…", onConfirm = { saver.launch("$baseName.${format.extension}") }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                if (result != null) "The ${result.rows.size} rows of this result." else "Every row of ${tableState?.ref?.display}" + (if (tableState?.filtered == true) " that matches the filter" else "") + (total?.let { " (${formatCount(it)})" } ?: "") + ".",
                color = t.textDim, fontSize = 13.sp,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ExportFormat.entries.forEach { f ->
                    Text(
                        f.label, color = if (f == format) t.onAccent else t.text, fontSize = 13.sp,
                        modifier = Modifier.background(if (f == format) t.accent else t.field, SmallRadius).clickable { format = f }.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}
