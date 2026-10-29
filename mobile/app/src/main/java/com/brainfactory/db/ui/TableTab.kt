package com.brainfactory.db.ui

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.FileDownload
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
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
import androidx.compose.ui.zIndex
import com.brainfactory.db.data.Settings
import com.brainfactory.db.engine.Absent
import com.brainfactory.db.engine.CellInput
import com.brainfactory.db.engine.ColumnMeta
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.FilterOp
import com.brainfactory.db.engine.FilterSpec
import com.brainfactory.db.engine.JsonText
import com.brainfactory.db.engine.ObjectKind
import com.brainfactory.db.engine.SqliteSession
import com.brainfactory.db.engine.TableStructure
import com.brainfactory.db.workspace.TableState
import com.brainfactory.db.workspace.Workspace
import kotlinx.coroutines.launch

/** A table, view or collection: Data (the grid), Structure, and for MongoDB a JSON view of the documents. */
@Composable
fun TableTab(ws: Workspace, state: TableState) {
    val t = bd
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val modes = if (state.isMongo) listOf(TableState.Mode.DATA, TableState.Mode.JSON, TableState.Mode.STRUCTURE) else listOf(TableState.Mode.DATA, TableState.Mode.STRUCTURE)
            BdSegmented(modes, state.mode, { state.mode = it; if (it == TableState.Mode.STRUCTURE) state.loadStructure() }, {
                when (it) {
                    TableState.Mode.DATA -> "Data"
                    TableState.Mode.JSON -> "JSON"
                    TableState.Mode.STRUCTURE -> if (state.isMongo) "Schema" else "Structure"
                }
            })
            Spacer(Modifier.weight(1f))
            if (state.mode != TableState.Mode.STRUCTURE) {
                IconButton(onClick = { state.filtersOpen = !state.filtersOpen }) {
                    Icon(Icons.Filled.FilterList, "Filter", tint = if (state.filtered) t.accent else t.textDim)
                }
            }
            IconButton(onClick = { if (state.mode == TableState.Mode.STRUCTURE) state.loadStructure(force = true) else state.load() }) {
                Icon(Icons.Filled.Refresh, "Refresh", tint = t.textDim)
            }
        }
        BdDivider()
        when (state.mode) {
            TableState.Mode.STRUCTURE -> StructureView(state)
            else -> DataView(ws, state)
        }
    }
}

private enum class EditMode { NONE, INSERT, DUPLICATE }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DataView(ws: Workspace, state: TableState) {
    val t = bd
    val context = LocalContext.current
    val settings = remember { Settings.get(context) }
    val scope = rememberCoroutineScope()
    var cell by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    var rowSheet by remember { mutableStateOf<Int?>(null) }
    var editing by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    var inserting by remember { mutableStateOf(EditMode.NONE) }
    var insertFrom by remember { mutableStateOf<Int?>(null) }
    var documentEditor by remember { mutableStateOf<Pair<Int?, String>?>(null) }
    var deleteRows by remember { mutableStateOf<List<Int>?>(null) }
    var exporting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val page = state.page
    val editable = page?.editable == true && !state.readOnly && state.ref.kind != ObjectKind.VIEW

    Column(Modifier.fillMaxSize()) {
        if (state.filtersOpen) FilterPanel(state, page?.table?.columns.orEmpty())
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = t.accent, trackColor = Color.Transparent)

        Box(Modifier.weight(1f).fillMaxWidth()) {
            // Picking rows: a bar floating over the grid's bottom, so the rows don't move under the finger.
            if (state.selecting) {
                Row(
                    Modifier.align(Alignment.BottomCenter).zIndex(1f).padding(10.dp).fillMaxWidth()
                        .background(t.selection, CardRadius).padding(horizontal = 4.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { state.selected.clear() }) { Icon(Icons.Filled.Close, "Cancel selection", tint = t.text) }
                    Text("${state.selected.size} selected", color = t.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = {
                        val rows = state.selected.sorted().mapNotNull { page?.table?.rows?.getOrNull(it) }
                        copyToClipboard(context, rowsAsJson(page?.table?.columns.orEmpty(), rows))
                    }) { Icon(Icons.Outlined.ContentCopy, "Copy as JSON", tint = t.text) }
                    if (editable) IconButton(onClick = { deleteRows = state.selected.sorted() }) { Icon(Icons.Filled.Delete, "Delete selected", tint = t.danger) }
                }
            }
            val error2 = state.error
            when {
                error2 != null && page == null -> BdEmpty("Couldn't load ${state.ref.display}", Modifier.align(Alignment.Center), message = error2) { BdButton("Try Again", { state.load() }) }
                page == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = t.accent) }
                state.mode == TableState.Mode.JSON -> JsonDocuments(page.documents.orEmpty(), editable) { i -> documentEditor = i to page.documents!![i] }
                page.table.columns.isEmpty() -> BdEmpty(if (state.filtered) "No rows match the filter" else "No rows", Modifier.align(Alignment.Center))
                else -> DataGrid(
                    page.table,
                    settings.nullText,
                    settings.gridFontSize,
                    Modifier.fillMaxSize(),
                    rowOffset = state.request.offset,
                    sort = state.request.sort,
                    onSort = state::sortBy,
                    selectedRows = state.selected.toSet(),
                    onCellClick = { row, col ->
                        if (state.selecting) { if (row in state.selected) state.selected.remove(row) else state.selected.add(row) } else cell = row to col
                    },
                    onRowClick = { row -> if (state.selecting) { if (row in state.selected) state.selected.remove(row) else state.selected.add(row) } else rowSheet = row },
                    onRowLongPress = { row -> if (row !in state.selected) state.selected.add(row) },
                )
            }
            if (error2 != null && page != null) {
                Text(error2, color = t.danger, fontSize = 13.sp, modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(t.panel).padding(10.dp))
            }
        }

        // Footer: count, timing, page size, pager, add row, export
        BdDivider()
        Row(
            Modifier.fillMaxWidth().background(t.chrome).padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(start = 6.dp)) {
                val shown = page?.table?.rows?.size ?: 0
                Text(
                    buildString {
                        append(shown)
                        state.total?.let { append(" of ").append(formatCount(it)) }
                        append(if (state.isMongo) " docs" else " rows")
                    },
                    color = t.textDim, fontSize = 12.sp, maxLines = 1,
                )
                page?.let { Text(formatMillis(it.millis), color = t.textFaint, fontSize = 11.sp) }
            }
            if (editable || (state.isMongo && !state.readOnly && state.ref.kind == ObjectKind.COLLECTION)) {
                IconButton(onClick = { if (state.isMongo) documentEditor = null to "{\n  \n}" else inserting = EditMode.INSERT }) { Icon(Icons.Filled.Add, "Add row", tint = t.accent) }
            }
            IconButton(onClick = { exporting = true }, enabled = page != null) { Icon(Icons.Outlined.FileDownload, "Export", tint = t.textDim) }
            BdSelect(Settings.PAGE_SIZES, state.request.limit, { state.setPageSize(it) }, { it.toString() }, Modifier.width(84.dp))
            IconButton(onClick = { state.goToPage(state.pageIndex - 1) }, enabled = state.pageIndex > 0 && !state.loading) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous page", tint = if (state.pageIndex > 0) t.text else t.textFaint)
            }
            Text("${state.pageIndex + 1}" + (state.pageCount?.let { " / $it" } ?: ""), color = t.textDim, fontSize = 12.sp)
            IconButton(onClick = { state.goToPage(state.pageIndex + 1) }, enabled = state.hasNext && !state.loading) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next page", tint = if (state.hasNext) t.text else t.textFaint)
            }
        }
    }

    val table = page?.table
    // Tapping a cell: its whole value, copy, edit, set NULL, filter by it.
    cell?.let { (row, col) ->
        if (table == null || row >= table.rows.size || col >= table.columns.size) { cell = null; return@let }
        val column = table.columns[col]
        val value = table.rows[row][col]
        ModalBottomSheet(onDismissRequest = { cell = null }, containerColor = t.panel) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(column.name, color = t.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (column.type.isNotBlank()) Text(column.type.lowercase(), color = t.textFaint, fontSize = 12.sp)
                }
                Spacer(Modifier.height(8.dp))
                SelectionContainer {
                    Text(
                        if (value == null) settings.nullText.ifBlank { "NULL" } else if (value === Absent) "(field not in this document)" else fullCell(value),
                        style = monoStyle(14), color = if (value == null || value === Absent) t.nullText else t.text,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).background(t.field, SmallRadius).verticalScroll(rememberScrollState()).padding(10.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BdButton("Copy", { copyToClipboard(context, fullCell(value)) }, icon = Icons.Outlined.ContentCopy)
                    if (editable && !(state.isMongo && column.name == "_id") && column.name != SqliteSession.ROWID) {
                        BdButton("Edit", { cell = null; editing = row to col }, primary = true, icon = Icons.Outlined.Edit)
                        if (value != null) BdButton("Set NULL", {
                            cell = null
                            scope.launch { state.updateCell(row, column.name, CellInput.Null)?.let { error = it } }
                        })
                    }
                    if (value !== Absent) BdButton("Filter by Value", {
                        cell = null
                        val spec = if (value == null) FilterSpec(column.name, FilterOp.IS_NULL) else FilterSpec(column.name, FilterOp.EQ, if (value is JsonText || value is com.brainfactory.db.engine.TaggedValue) fullCell(value) else value.toString())
                        state.applyFilters(state.request.filters + spec, state.request.rawFilter)
                        state.filtersOpen = true
                    })
                    if (state.isMongo && editable) BdButton("Edit Document", { cell = null; documentEditor = row to (page.documents?.getOrNull(row) ?: "{}") })
                }
            }
        }
    }

    // Tapping a row number: the row as a form, with row actions.
    rowSheet?.let { row ->
        if (table == null || row >= table.rows.size) { rowSheet = null; return@let }
        val values = table.rows[row]
        ModalBottomSheet(onDismissRequest = { rowSheet = null }, containerColor = t.panel) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                Text("Row ${state.request.offset + row + 1}", color = t.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.heightIn(max = 380.dp)) {
                    itemsIndexed(table.columns) { i, c ->
                        val v = values.getOrNull(i)
                        Row(Modifier.fillMaxWidth().clickable { rowSheet = null; cell = row to i }.padding(vertical = 6.dp)) {
                            Text(c.name, color = t.textDim, fontSize = 13.sp, modifier = Modifier.width(130.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (v === Absent) "—" else formatCell(v, settings.nullText.ifBlank { "NULL" }, 500),
                                color = if (v == null || v === Absent) t.nullText else t.text, style = monoStyle(13), maxLines = 3, overflow = TextOverflow.Ellipsis,
                            )
                        }
                        BdDivider()
                    }
                }
                Spacer(Modifier.height(12.dp))
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BdButton("Copy as JSON", { copyToClipboard(context, if (state.isMongo) page.documents?.getOrNull(row) ?: rowsAsJson(table.columns, listOf(values)) else rowsAsJson(table.columns, listOf(values))) }, icon = Icons.Outlined.ContentCopy)
                    if (!state.isMongo) BdButton("Copy as INSERT", { copyToClipboard(context, rowAsInsert(ws, state, table.columns, values)) })
                    if (editable) {
                        if (state.isMongo) {
                            BdButton("Edit Document", { rowSheet = null; documentEditor = row to (page.documents?.getOrNull(row) ?: "{}") }, primary = true)
                            BdButton("Duplicate", { rowSheet = null; documentEditor = null to withoutId(page.documents?.getOrNull(row) ?: "{}") })
                        } else {
                            BdButton("Duplicate", { rowSheet = null; insertFrom = row; inserting = EditMode.DUPLICATE })
                        }
                        BdButton("Delete", { rowSheet = null; deleteRows = listOf(row) }, danger = true)
                    }
                }
            }
        }
    }

    editing?.let { (row, col) ->
        val column = table?.columns?.getOrNull(col)
        if (column == null) { editing = null; return@let }
        CellEditor(column, table.rows[row][col], onDismiss = { editing = null }) { input ->
            editing = null
            scope.launch { state.updateCell(row, column.name, input)?.let { error = it } }
        }
    }

    if (inserting != EditMode.NONE && table != null) {
        val prefill = insertFrom?.takeIf { inserting == EditMode.DUPLICATE }?.let { r -> table.rows.getOrNull(r) }
        InsertRowDialog(table.columns, prefill, onDismiss = { inserting = EditMode.NONE; insertFrom = null }) { values ->
            inserting = EditMode.NONE
            insertFrom = null
            scope.launch { state.insertRow(values)?.let { error = it } }
        }
    }

    documentEditor?.let { (row, json) ->
        DocumentEditor(if (row == null) "New Document" else "Edit Document", json, onDismiss = { documentEditor = null }) { text ->
            scope.launch {
                val e = if (row == null) state.insertDocument(text) else state.replaceDocument(row, text)
                if (e == null) documentEditor = null else error = e
            }
        }
    }

    deleteRows?.let { rows ->
        BdDialog("Delete ${rows.size} ${if (state.isMongo) "document" else "row"}${if (rows.size == 1) "" else "s"}?", { deleteRows = null }, confirmLabel = "Delete", danger = true, onConfirm = {
            deleteRows = null
            scope.launch { state.deleteRows(rows)?.let { error = it } }
        }) { Text("They are deleted from ${state.ref.display} on the server. This can't be undone.", color = t.textDim) }
    }

    if (exporting) ExportDialog(ws, onDismiss = { exporting = false }, tableState = state, result = null, baseName = state.ref.name)

    error?.let { m -> BdDialog("Couldn't save", { error = null }, confirmLabel = "OK", onConfirm = { error = null }, dismissLabel = null) { Text(m) } }
}

/** Column filters (column, operator, value), ANDed, plus a WHERE clause or Mongo filter typed by hand. */
@Composable
private fun FilterPanel(state: TableState, columns: List<ColumnMeta>) {
    val t = bd
    val drafts = remember(state.request) { mutableStateListOf<FilterSpec>().apply { addAll(state.request.filters) } }
    var raw by remember(state.request) { mutableStateOf(state.request.rawFilter) }
    val names = columns.map { it.name }.ifEmpty { listOf("") }
    Column(Modifier.fillMaxWidth().background(t.panel).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        drafts.forEachIndexed { i, f ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BdSelect(names, f.column.ifBlank { names.first() }, { drafts[i] = f.copy(column = it) }, { it }, Modifier.weight(1.1f))
                BdSelect(FilterOp.entries.toList(), f.op, { drafts[i] = f.copy(op = it) }, { it.label }, Modifier.weight(0.9f))
                if (f.op.needsValue) BdTextField(f.value, { drafts[i] = f.copy(value = it) }, Modifier.weight(1.2f), placeholder = "value", imeAction = ImeAction.Done, onAction = { state.applyFilters(drafts.toList(), raw) })
                IconButton(onClick = { drafts.removeAt(i) }, modifier = Modifier.size(36.dp)) { Icon(Icons.Filled.Close, "Remove filter", tint = t.textDim, modifier = Modifier.size(18.dp)) }
            }
        }
        BdTextField(
            raw, { raw = it },
            placeholder = if (state.isMongo) "{ \"age\": { \"\$gt\": 30 } }" else "WHERE clause, e.g. city = 'Jakarta' AND active = 1",
            mono = true, imeAction = ImeAction.Done, onAction = { state.applyFilters(drafts.toList(), raw) },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BdButton("Add Filter", { drafts.add(FilterSpec(names.first(), FilterOp.EQ)) }, icon = Icons.Filled.Add)
            Spacer(Modifier.weight(1f))
            if (state.filtered) BdButton("Clear", { drafts.clear(); raw = ""; state.clearFilters() })
            BdButton("Apply", { state.applyFilters(drafts.toList(), raw) }, primary = true)
        }
    }
    BdDivider()
}

/** MongoDB documents as indented JSON; tapping one edits it. */
@Composable
private fun JsonDocuments(documents: List<String>, editable: Boolean, onEdit: (Int) -> Unit) {
    val t = bd
    if (documents.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { BdEmpty("No documents") }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(documents) { i, doc ->
            Text(
                doc, style = monoStyle(12), color = t.text, maxLines = 40, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().background(t.panel, CardRadius).then(if (editable) Modifier.clickable { onEdit(i) } else Modifier).padding(12.dp),
            )
        }
    }
}

/** Edits one cell: its text, or NULL. */
@Composable
private fun CellEditor(column: ColumnMeta, value: Any?, onDismiss: () -> Unit, onSave: (CellInput) -> Unit) {
    val t = bd
    var text by remember { mutableStateOf(fullCell(value)) }
    var isNull by remember { mutableStateOf(value == null) }
    BdDialog("Edit ${column.name}", onDismiss, confirmLabel = "Save", onConfirm = { onSave(if (isNull) CellInput.Null else CellInput.Text(text)) }) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (column.type.isNotBlank()) Text(column.type.lowercase(), color = t.textFaint, fontSize = 12.sp)
            BdTextField(text, { text = it; isNull = false }, singleLine = false, minLines = 3, mono = true, enabled = !isNull, placeholder = if (isNull) "NULL" else null)
            BdSwitchRow("NULL", isNull, { isNull = it }, inset = 0.dp)
            if (value is JsonText || value is com.brainfactory.db.engine.TaggedValue) Text("JSON and shell values (ObjectId(\"…\"), ISODate(\"…\")) are read as such; other text is saved as a string.", color = t.textFaint, fontSize = 12.sp)
        }
    }
}

private enum class FieldMode { VALUE, NULL, DEFAULT }

/** A new row: each column a value, NULL or its default; [prefill] duplicates a row. */
@Composable
private fun InsertRowDialog(columns: List<ColumnMeta>, prefill: List<Any?>?, onDismiss: () -> Unit, onSave: (Map<String, CellInput>) -> Unit) {
    val t = bd
    val cols = columns.filter { it.name != SqliteSession.ROWID }
    val texts = remember { mutableStateMapOf<String, String>() }
    val modes = remember { mutableStateMapOf<String, FieldMode>() }
    LaunchedEffect(Unit) {
        cols.forEach { c ->
            val v = prefill?.getOrNull(columns.indexOf(c))
            // A duplicated row keeps its values but not its key, which would clash.
            if (prefill != null && !c.key && v != null) { texts[c.name] = fullCell(v); modes[c.name] = FieldMode.VALUE }
            else modes[c.name] = if (prefill != null && v == null && !c.key) FieldMode.NULL else FieldMode.DEFAULT
        }
    }
    BdDialog(if (prefill != null) "Duplicate Row" else "Add Row", onDismiss, confirmLabel = "Insert", onConfirm = {
        onSave(cols.associate { c ->
            c.name to when (modes[c.name] ?: FieldMode.DEFAULT) {
                FieldMode.VALUE -> CellInput.Text(texts[c.name].orEmpty())
                FieldMode.NULL -> CellInput.Null
                FieldMode.DEFAULT -> CellInput.Default
            }
        })
    }) {
        LazyColumn(Modifier.heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(cols) { c ->
                val mode = modes[c.name] ?: FieldMode.DEFAULT
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.name, color = t.text, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        BdSegmented(FieldMode.entries.toList(), mode, { modes[c.name] = it }, { when (it) { FieldMode.VALUE -> "Value"; FieldMode.NULL -> "NULL"; FieldMode.DEFAULT -> "Default" } })
                    }
                    if (mode == FieldMode.VALUE) {
                        Spacer(Modifier.height(4.dp))
                        BdTextField(texts[c.name].orEmpty(), { texts[c.name] = it }, placeholder = c.type.lowercase(), mono = true)
                    }
                }
            }
        }
    }
}

/** A Mongo document as JSON (shell syntax accepted), for editing or inserting. */
@Composable
fun DocumentEditor(title: String, json: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    val t = bd
    var text by remember { mutableStateOf(json) }
    BdDialog(title, onDismiss, confirmLabel = "Save", onConfirm = { onSave(text) }) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BdTextField(text, { text = it }, Modifier.heightIn(min = 200.dp, max = 460.dp), singleLine = false, minLines = 10, mono = true)
            Text("Shell syntax works: ObjectId(\"…\"), ISODate(\"…\"), NumberLong(…). The _id can't change.", color = t.textFaint, fontSize = 12.sp)
        }
    }
}

private fun withoutId(json: String): String = runCatching {
    val doc = org.bson.Document.parse(json)
    doc.remove("_id")
    doc.toJson(org.bson.json.JsonWriterSettings.builder().outputMode(org.bson.json.JsonMode.SHELL).indent(true).build())
}.getOrDefault(json)

/** Rows as a JSON array of objects. */
fun rowsAsJson(columns: List<ColumnMeta>, rows: List<List<Any?>>): String {
    val out = java.io.StringWriter()
    val exporter = com.brainfactory.db.engine.ResultExporter(com.brainfactory.db.engine.ExportFormat.JSON, columns.map { it.name }, out, com.brainfactory.db.engine.SqlDialect.MYSQL, "")
    exporter.begin()
    rows.forEach(exporter::row)
    exporter.end()
    return out.toString().trim()
}

private fun rowAsInsert(ws: Workspace, state: TableState, columns: List<ColumnMeta>, values: List<Any?>): String {
    val dialect = ws.profile.driver.dialect
    val cols = columns.indices.filter { columns[it].name != SqliteSession.ROWID }
    return "INSERT INTO " + dialect.qualified(state.ref) + " (" + cols.joinToString(", ") { dialect.quote(columns[it].name) } + ") VALUES (" +
        cols.joinToString(", ") { dialect.literal((values[it] as? JsonText)?.text ?: values[it]) } + ");"
}

/** Columns, indexes, foreign keys, facts and the CREATE statement. */
@Composable
private fun StructureView(state: TableState) {
    val t = bd
    val context = LocalContext.current
    val s: TableStructure? = state.structure
    when {
        state.structureLoading && s == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = t.accent) }
        state.structureError != null && s == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            BdEmpty("Couldn't read the structure", message = state.structureError) { BdButton("Try Again", { state.loadStructure(force = true) }) }
        }
        s != null -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { BdSectionHeader(if (state.isMongo) "Fields (sampled)" else "Columns", trailing = s.columns.size.toString()) }
            items(s.columns) { c ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.name, color = t.text, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
                        Spacer(Modifier.width(6.dp))
                        when (c.key) {
                            "PRI" -> BdBadge("PK", t.warning)
                            "UNI" -> BdBadge("UNIQUE", t.accent)
                            "MUL" -> BdBadge("INDEX", t.textDim)
                        }
                        if (!c.nullable && !state.isMongo) { Spacer(Modifier.width(4.dp)); BdBadge("NOT NULL", t.textDim) }
                    }
                    Text(c.type, color = t.keyword, style = monoStyle(12))
                    val extra = listOfNotNull(c.default?.let { "default $it" }, c.extra.takeIf { it.isNotBlank() }, c.comment.takeIf { it.isNotBlank() }?.let { "“$it”" }).joinToString(" · ")
                    if (extra.isNotBlank()) Text(extra, color = t.textFaint, fontSize = 12.sp)
                }
                BdDivider(Modifier.padding(start = 16.dp))
            }
            if (s.indexes.isNotEmpty()) {
                item { BdSectionHeader("Indexes", trailing = s.indexes.size.toString()) }
                items(s.indexes) { ix ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(ix.name, color = t.text, fontSize = 14.sp, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.width(6.dp))
                            if (ix.primary) BdBadge("PRIMARY", t.warning) else if (ix.unique) BdBadge("UNIQUE", t.accent)
                        }
                        Text(ix.columns.joinToString(", "), color = t.textDim, style = monoStyle(12))
                        if (ix.definition.isNotBlank() && !state.isMongo) Text(ix.definition, color = t.textFaint, style = monoStyle(11), maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    BdDivider(Modifier.padding(start = 16.dp))
                }
            }
            if (s.foreignKeys.isNotEmpty()) {
                item { BdSectionHeader("Foreign keys", trailing = s.foreignKeys.size.toString()) }
                items(s.foreignKeys) { fk ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text(fk.name, color = t.text, fontSize = 14.sp)
                        Text("(${fk.columns.joinToString(", ")}) → ${fk.refTable}(${fk.refColumns.joinToString(", ")})", color = t.textDim, style = monoStyle(12))
                        val rules = listOfNotNull(fk.onUpdate.takeIf { it.isNotBlank() }?.let { "ON UPDATE $it" }, fk.onDelete.takeIf { it.isNotBlank() }?.let { "ON DELETE $it" }).joinToString(" · ")
                        if (rules.isNotBlank()) Text(rules, color = t.textFaint, fontSize = 12.sp)
                    }
                    BdDivider(Modifier.padding(start = 16.dp))
                }
            }
            if (s.info.isNotEmpty()) {
                item { BdSectionHeader("Info") }
                items(s.info) { (k, v) ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                        Text(k, color = t.textDim, fontSize = 13.sp, modifier = Modifier.weight(0.45f).padding(end = 8.dp))
                        Text(v, color = t.text, fontSize = 13.sp, modifier = Modifier.weight(0.55f))
                    }
                }
            }
            s.ddl?.let { ddl ->
                item {
                    BdSectionHeader(if (state.isMongo) "Collection options" else "Definition")
                    Box(Modifier.padding(horizontal = 12.dp)) {
                        SelectionContainer {
                            Text(
                                ddl, style = monoStyle(12), color = t.text,
                                modifier = Modifier.fillMaxWidth().background(t.field, SmallRadius).horizontalScroll(rememberScrollState()).padding(10.dp),
                            )
                        }
                    }
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { BdButton("Copy", { copyToClipboard(context, ddl) }, icon = Icons.Outlined.ContentCopy) }
                }
            }
        }
    }
}
