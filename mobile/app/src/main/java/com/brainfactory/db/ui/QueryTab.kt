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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FileDownload
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.UnfoldLess
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.HistoryEntry
import com.brainfactory.db.data.Settings
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.QueryLanguage
import com.brainfactory.db.engine.StatementResult
import com.brainfactory.db.workspace.QueryState
import com.brainfactory.db.workspace.Workspace
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Examples to start from, per driver (the desktop's query_editor.examples). */
private fun examples(driver: Driver): List<String> = when (driver) {
    Driver.MYSQL -> listOf("SELECT * FROM users LIMIT 100;", "SHOW TABLES;", "SELECT COUNT(*) AS total FROM users;", "SHOW FULL PROCESSLIST;", "EXPLAIN SELECT * FROM users WHERE id = 1;")
    Driver.POSTGRES -> listOf("SELECT * FROM users LIMIT 100;", "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');", "SELECT version();", "EXPLAIN ANALYZE SELECT 1;", "NOTIFY my_channel, 'hello';")
    Driver.SQLITE -> listOf("SELECT * FROM sqlite_master;", "SELECT name FROM sqlite_master WHERE type = 'table';", "PRAGMA table_info(users);", "PRAGMA integrity_check;")
    Driver.MONGO -> listOf("db.users.find({}).limit(20)", "db.users.find({ age: { \$gt: 30 } }).sort({ age: -1 })", "db.users.countDocuments({})", "db.users.aggregate([{ \$group: { _id: \"\$city\", n: { \$sum: 1 } } }])", "show collections", "db.stats()")
    Driver.REDIS -> listOf("PING", "INFO server", "DBSIZE", "KEYS user:*", "SCAN 0 MATCH * COUNT 100", "SET greeting \"hello\"", "GET greeting", "TTL greeting")
}

private fun placeholder(language: QueryLanguage) = when (language) {
    QueryLanguage.SQL -> "SELECT * FROM users LIMIT 100;"
    QueryLanguage.MONGO -> "db.users.find({ age: { \$gt: 30 } })"
    QueryLanguage.REDIS -> "GET key"
}

/** A query tab: the editor above, each statement's result below (the desktop's SQL editor and results). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueryTab(ws: Workspace, state: QueryState) {
    val t = bd
    val context = LocalContext.current
    val settings = remember { Settings.get(context) }
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    /** 0: editor and results share the height; 1: results only; -1: editor only. */
    var split by rememberSaveable { mutableStateOf(0) }
    val focus = remember { FocusRequester() }
    val names = remember(ws.objects) { ws.objects.map { it.name } }

    val opener = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { it.readBytes().decodeToString() } } }
                .onSuccess { state.setText(it) }.onFailure { ws.notice = "The file couldn't be read: ${it.message}" }
        }
    }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri: Uri? ->
        if (uri != null) scope.launch {
            ws.notice = runCatching { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(state.text.text.toByteArray()) } } }
                .fold({ "Saved." }, { "The file couldn't be saved: ${it.message}" })
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Toolbar
        Row(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.running) {
                BdButton("Stop", state::stop, danger = true, icon = Icons.Filled.Stop)
                Spacer(Modifier.width(8.dp))
                CircularProgressIndicator(Modifier.size(16.dp), color = t.accent, strokeWidth = 2.dp)
                Spacer(Modifier.width(6.dp))
                Text(formatMillis(state.elapsed), color = t.textDim, fontSize = 12.sp)
            } else {
                BdButton(if (state.text.selection.collapsed) "Run" else "Run Selection", { state.run(currentOnly = false, confirm = settings.confirmDestructive) }, primary = true, icon = Icons.Filled.PlayArrow)
                Spacer(Modifier.width(6.dp))
                if (state.text.selection.collapsed) BdButton(if (state.language == QueryLanguage.REDIS) "Run Line" else "Run Current", { state.run(currentOnly = true, confirm = settings.confirmDestructive) })
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { history = true }) { Icon(Icons.Outlined.History, "History", tint = t.textDim) }
            IconButton(onClick = { split = if (split == 1) 0 else 1 }) { Icon(if (split == 1) Icons.Outlined.UnfoldMore else Icons.Outlined.UnfoldLess, if (split == 1) "Show editor" else "Maximise results", tint = t.textDim) }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Query menu", tint = t.textDim) }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Open File…") }, onClick = { menu = false; opener.launch(arrayOf("*/*")) })
                    DropdownMenuItem(text = { Text("Save As…") }, onClick = { menu = false; saver.launch(if (state.language == QueryLanguage.SQL) "query.sql" else "query.txt") })
                    DropdownMenuItem(text = { Text("Export Results…") }, enabled = state.results.any { it.table != null }, onClick = { menu = false; exporting = true })
                    DropdownMenuItem(text = { Text(if (split == -1) "Show Results" else "Hide Results") }, onClick = { menu = false; split = if (split == -1) 0 else -1 })
                    DropdownMenuItem(text = { Text("Clear") }, onClick = { menu = false; state.setText("") })
                    BdDivider()
                    examples(ws.profile.driver).forEach { ex ->
                        DropdownMenuItem(text = { Text(ex, style = monoStyle(12), maxLines = 1, overflow = TextOverflow.Ellipsis) }, onClick = {
                            menu = false
                            state.setText(if (state.text.text.isBlank()) ex else state.text.text.trimEnd() + "\n" + ex)
                        })
                    }
                }
            }
        }
        BdDivider()

        if (split != 1) {
            QueryEditorField(
                state.text, { state.text = it }, state.language, settings.editorFontSize,
                Modifier.fillMaxWidth().weight(if (split == -1) 1f else 0.42f),
                focusRequester = focus, placeholder = placeholder(state.language),
            )
            EditorAccessoryBar(state.text, { state.text = it }, state.language, names, settings.symbolBar)
            BdDivider()
        }
        if (split != -1) {
            Box(Modifier.fillMaxWidth().weight(if (split == 1) 1f else 0.58f)) { Results(state, settings) }
        }
    }

    state.pendingDestructive?.let { list ->
        BdDialog("Run destructive statement${if (list.size == 1) "" else "s"}?", state::dismissPending, confirmLabel = "Run Anyway", danger = true, onConfirm = state::confirmPending) {
            Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                list.forEach { d ->
                    Column(Modifier.fillMaxWidth().background(t.danger.copy(alpha = 0.1f), SmallRadius).padding(10.dp)) {
                        Text(d.detail, color = t.danger, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Spacer(Modifier.height(4.dp))
                        Text(d.sql, style = monoStyle(12), color = t.text, maxLines = 6, overflow = TextOverflow.Ellipsis)
                    }
                }
                Text("Turn this check off in Settings › Query editor.", color = t.textFaint, fontSize = 12.sp)
            }
        }
    }

    if (history) {
        val entries = remember { ws.history.list(ws.profile.id) }
        ModalBottomSheet(onDismissRequest = { history = false }, containerColor = t.panel) {
            Column(Modifier.padding(bottom = 16.dp)) {
                Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("History", color = t.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (entries.isNotEmpty()) BdButton("Clear", { ws.history.clear(ws.profile.id); history = false })
                }
                if (entries.isEmpty()) Text("Queries you run appear here.", color = t.textDim, modifier = Modifier.padding(16.dp))
                LazyColumn(Modifier.heightIn(max = 480.dp)) {
                    items(entries) { e: HistoryEntry ->
                        Column(Modifier.fillMaxWidth().clickable { state.setText(e.text); history = false }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(if (e.ok) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline, null, tint = if (e.ok) t.success else t.danger, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(TIME.format(Date(e.time)) + (e.database?.let { " · $it" } ?: ""), color = t.textFaint, fontSize = 11.sp)
                            }
                            Text(e.text.trim(), style = monoStyle(12), color = t.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                        BdDivider()
                    }
                }
            }
        }
    }

    if (exporting) {
        val table = (state.results.getOrNull(state.selectedResult)?.takeIf { it.table != null } ?: state.results.firstOrNull { it.table != null })?.table
        if (table != null) ExportDialog(ws, onDismiss = { exporting = false }, tableState = null, result = table, baseName = "result")
        else exporting = false
    }
}

private val TIME = SimpleDateFormat("d MMM HH:mm:ss", Locale.getDefault())

/** The statements' results: a chip per statement, and the chosen one's rows or message. */
@Composable
private fun Results(state: QueryState, settings: Settings) {
    val t = bd
    val results = state.results
    if (results.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(if (state.running) "Running…" else "Results appear here.", color = t.textFaint, fontSize = 13.sp)
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        if (results.size > 1) {
            Row(Modifier.fillMaxWidth().background(t.chrome).horizontalScroll(rememberScrollState()).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                results.forEachIndexed { i, r ->
                    val on = i == state.selectedResult
                    Row(
                        Modifier.clip(RoundedCornerShape(6.dp)).background(if (on) t.panel else Color.Transparent).clickable { state.selectedResult = i }.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(if (r.ok) Icons.Outlined.CheckCircle else Icons.Outlined.ErrorOutline, null, tint = if (r.ok) t.success else t.danger, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(5.dp))
                        Text("${i + 1}. " + summary(r), color = if (on) t.text else t.textDim, fontSize = 12.sp, maxLines = 1)
                    }
                }
            }
            BdDivider()
        }
        val r = results.getOrNull(state.selectedResult) ?: results.first()
        Row(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(r.statement.replace(Regex("\\s+"), " "), style = monoStyle(11), color = t.textFaint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Text(summary(r) + " · " + formatMillis(r.millis), color = if (r.ok) t.textDim else t.danger, fontSize = 11.sp)
        }
        BdDivider()
        if (state.pagedStatement != null && results.size == 1) {
            Pager(state, r.table?.rows?.size ?: 0)
            BdDivider()
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val error = r.error
            val table = r.table
            val affected = r.affected
            when {
                error != null -> SelectionContainer {
                    Text(error, color = t.danger, style = monoStyle(13), modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp))
                }
                table != null && table.columns.isNotEmpty() -> Column(Modifier.fillMaxSize()) {
                    var cell by remember(r) { mutableStateOf<Pair<Int, Int>?>(null) }
                    // A paged result numbers its rows from the page's first one.
                    val offset = if (state.pagedStatement != null && results.size == 1 && state.pageSize > 0) state.page.toLong() * state.pageSize else 0L
                    DataGrid(table, settings.nullText, settings.gridFontSize, Modifier.weight(1f).fillMaxWidth(), rowOffset = offset, onCellClick = { row, col -> cell = row to col })
                    if (table.truncated) Text("Showing the first ${table.rows.size} rows (Settings › Query editor › Result rows).", color = t.warning, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().background(t.panel).padding(8.dp))
                    cell?.let { (row, col) -> ResultCellSheet(r, row, col, settings.nullText) { cell = null } }
                }
                else -> Column(Modifier.fillMaxSize().padding(16.dp)) {
                    Text(r.message ?: (affected?.let { "$it row${if (it == 1L) "" else "s"} affected" } ?: "Done."), color = t.text, fontSize = 14.sp)
                    if (r.message != null && affected != null) Text("$affected row${if (affected == 1L) "" else "s"} affected", color = t.textDim, fontSize = 13.sp)
                }
            }
        }
    }
}

/** Page sizes for auto-paging; 0 runs the statement whole (up to Settings › Result rows). */
private val PAGE_SIZES = listOf(25, 50, 100, 200, 500, 1000, 0)

/** The auto-paging bar: which page, its rows, the page size, previous and next. */
@Composable
private fun Pager(state: QueryState, rows: Int) {
    val t = bd
    Row(Modifier.fillMaxWidth().background(t.chrome).padding(horizontal = 6.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (state.pageSize > 0) "Page ${state.page + 1} · $rows row${if (rows == 1) "" else "s"}" + if (state.hasNextPage) " · more" else "" else "$rows rows, all",
            color = t.textDim, fontSize = 12.sp, modifier = Modifier.weight(1f).padding(start = 6.dp),
        )
        BdSelect(PAGE_SIZES, state.pageSize, state::changePageSize, { if (it == 0) "All" else it.toString() }, Modifier.width(84.dp), enabled = !state.running)
        IconButton(onClick = state::previousPage, enabled = state.pageSize > 0 && state.page > 0 && !state.running) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous page", tint = if (state.page > 0) t.text else t.textFaint)
        }
        IconButton(onClick = state::nextPage, enabled = state.pageSize > 0 && state.hasNextPage && !state.running) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next page", tint = if (state.hasNextPage) t.text else t.textFaint)
        }
    }
}

private fun summary(r: StatementResult): String {
    val table = r.table
    val message = r.message
    return when {
        r.error != null -> "Error"
        table != null -> "${table.rows.size}${if (table.truncated) "+" else ""} row${if (table.rows.size == 1) "" else "s"}"
        r.affected != null -> "${r.affected} affected"
        message != null && message.length <= 24 -> message
        else -> "OK"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResultCellSheet(r: StatementResult, row: Int, col: Int, nullText: String, onDismiss: () -> Unit) {
    val t = bd
    val context = LocalContext.current
    val table = r.table ?: return
    val value = table.rows.getOrNull(row)?.getOrNull(col)
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = t.panel) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text(table.columns[col].name, color = t.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            SelectionContainer {
                Text(
                    if (value == null) nullText.ifBlank { "NULL" } else fullCell(value), style = monoStyle(14), color = if (value == null) t.nullText else t.text,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).background(t.field, SmallRadius).verticalScroll(rememberScrollState()).padding(10.dp),
                )
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BdButton("Copy", { copyToClipboard(context, fullCell(value)) })
                BdButton("Copy Row as JSON", { copyToClipboard(context, rowsAsJson(table.columns, listOf(table.rows[row]))) })
            }
        }
    }
}
