package com.brainfactory.db.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.engine.Absent
import com.brainfactory.db.engine.ResultTable
import com.brainfactory.db.engine.SortSpec

/**
 * Rows in a scrolling grid, as the desktop's data grid: a header with sort arrows and key marks, numbered rows, and
 * NULLs drawn faint. Columns size to their content (within limits); the grid scrolls both ways.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DataGrid(
    table: ResultTable,
    nullText: String,
    fontSize: Int,
    modifier: Modifier = Modifier,
    rowOffset: Long = 0,
    sort: List<SortSpec> = emptyList(),
    onSort: ((String) -> Unit)? = null,
    selectedRows: Set<Int> = emptySet(),
    onCellClick: ((row: Int, column: Int) -> Unit)? = null,
    onRowClick: ((row: Int) -> Unit)? = null,
    onRowLongPress: ((row: Int) -> Unit)? = null,
) {
    val t = bd
    val charWidth = fontSize * 0.62f
    val widths: List<Dp> = remember(table, fontSize) {
        table.columns.mapIndexed { i, c ->
            val longest = table.rows.asSequence().take(200).map { formatCell(it.getOrNull(i), nullText, 60).length }.maxOrNull() ?: 0
            val chars = maxOf(c.name.length + if (c.key) 4 else 2, longest).coerceIn(4, 42)
            (chars * charWidth + 22).dp
        }
    }
    val numberWidth = remember(table, rowOffset, fontSize) { ((rowOffset + table.rows.size).toString().length.coerceAtLeast(2) * charWidth + 18).dp }
    val total = widths.fold(numberWidth) { a, b -> a + b }
    val hScroll = rememberScrollState()
    val listState = rememberLazyListState()
    val lineColor = t.border
    val rowHeight = (fontSize * 2.3f).dp

    Box(modifier.background(t.background).horizontalScroll(hScroll)) {
        Column(Modifier.width(total).fillMaxHeight()) {
            // Header
            Row(Modifier.height(rowHeight + 4.dp).background(t.chrome).gridLines(lineColor)) {
                HeaderCell("#", numberWidth, null, false, null, fontSize)
                table.columns.forEachIndexed { i, c ->
                    val s = sort.firstOrNull { it.column == c.name }
                    HeaderCell(c.name, widths[i], s, c.key, onSort?.let { { it(c.name) } }, fontSize)
                }
            }
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                itemsIndexed(table.rows, key = { index, _ -> index }) { index, row ->
                    val selected = index in selectedRows
                    Row(
                        Modifier
                            .height(rowHeight)
                            .background(if (selected) t.selection else if (index % 2 == 1) t.panel.copy(alpha = if (t.dark) 0.35f else 0.6f) else Color.Transparent)
                            .gridLines(lineColor),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .width(numberWidth)
                                .fillMaxHeight()
                                .combinedClickable(onClick = { onRowClick?.invoke(index) }, onLongClick = { onRowLongPress?.invoke(index) })
                                .padding(horizontal = 6.dp),
                            contentAlignment = Alignment.CenterEnd,
                        ) {
                            Text((rowOffset + index + 1).toString(), color = t.textFaint, style = monoStyle(fontSize - 1), maxLines = 1)
                        }
                        row.forEachIndexed { col, value ->
                            if (col < widths.size) {
                                val isNull = value == null
                                Box(
                                    Modifier
                                        .width(widths[col])
                                        .fillMaxHeight()
                                        .combinedClickable(onClick = { onCellClick?.invoke(index, col) }, onLongClick = { onRowLongPress?.invoke(index) })
                                        .padding(horizontal = 8.dp),
                                    contentAlignment = if (isNumeric(value)) Alignment.CenterEnd else Alignment.CenterStart,
                                ) {
                                    Text(
                                        if (value === Absent) "—" else formatCell(value, nullText),
                                        color = if (isNull || value === Absent) t.nullText else t.text,
                                        style = monoStyle(fontSize).copy(fontStyle = if (isNull) FontStyle.Italic else FontStyle.Normal),
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        textAlign = if (isNumeric(value)) TextAlign.End else TextAlign.Start,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HeaderCell(name: String, width: Dp, sort: SortSpec?, key: Boolean, onClick: (() -> Unit)?, fontSize: Int) {
    val t = bd
    Row(
        Modifier
            .width(width)
            .fillMaxHeight()
            .then(if (onClick != null) Modifier.combinedClickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (key) {
            Icon(Icons.Filled.Key, "Key", tint = t.warning, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(3.dp))
        }
        Column(Modifier.weight(1f, fill = false)) {
            Text(name, color = t.textDim, fontSize = (fontSize - 0.5f).sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (sort != null) {
            Spacer(Modifier.width(2.dp))
            Icon(if (sort.descending) Icons.Filled.ArrowDownward else Icons.Filled.ArrowUpward, if (sort.descending) "Descending" else "Ascending", tint = t.accent, modifier = Modifier.size(13.dp))
        }
    }
}

/** A bottom and right line on each cell row. */
private fun Modifier.gridLines(color: Color) = drawBehind {
    drawLine(color, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1f)
}
