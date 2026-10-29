package com.brainfactory.db.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.engine.RedisValue
import com.brainfactory.db.workspace.RedisBrowserState
import com.brainfactory.db.workspace.RedisKeyState
import com.brainfactory.db.workspace.WorkTab
import com.brainfactory.db.workspace.Workspace
import kotlinx.coroutines.launch

private val REDIS_TYPES = listOf(null, "string", "hash", "list", "set", "zset", "stream")

/** A Redis type's colour, as the desktop's badges colour them. */
@Composable
fun redisTypeColor(type: String): Color {
    val t = bd
    return when (type) {
        "string" -> Color(0xFF22C55E)
        "hash" -> Color(0xFF3B82F6)
        "list" -> Color(0xFFF59E0B)
        "set" -> Color(0xFFA855F7)
        "zset" -> Color(0xFFEC4899)
        "stream" -> Color(0xFF14B8A6)
        else -> t.textDim
    }
}

/** A type as a badge: STR, HASH, LIST, SET, ZSET, XSTR (stream). */
fun typeBadge(type: String): String = when (type) {
    "string" -> "STR"
    "stream" -> "XSTR"
    "ReJSON-RL" -> "JSON"
    else -> type.uppercase().take(4)
}

/** "1h 2m", "45s", "no expiry". */
fun formatTtl(ttl: Long): String = when {
    ttl < 0 -> "no expiry"
    ttl < 60 -> "${ttl}s"
    ttl < 3600 -> "${ttl / 60}m ${ttl % 60}s"
    ttl < 86400 -> "${ttl / 3600}h ${(ttl % 3600) / 60}m"
    else -> "${ttl / 86400}d ${(ttl % 86400) / 3600}h"
}

/** The key browser: a SCAN pattern, a type filter, the keys found (more on demand), and New Key. */
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun RedisKeysPane(ws: Workspace, state: RedisBrowserState) {
    val t = bd
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(start = 10.dp, end = 4.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            BdTextField(state.pattern, { state.pattern = it }, Modifier.weight(1f), placeholder = "Pattern, e.g. user:*", mono = true, imeAction = ImeAction.Search, onAction = { scope.launch { state.reload() } })
            IconButton(onClick = { scope.launch { state.reload() } }) { Icon(Icons.Filled.Refresh, "Search", tint = t.textDim) }
        }
        FlowRow(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            REDIS_TYPES.forEach { type ->
                val on = state.type == type
                Text(
                    type ?: "all", fontSize = 12.sp, color = if (on) t.onAccent else t.textDim,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(if (on) t.accent else t.field).clickable {
                        state.type = type
                        scope.launch { state.reload() }
                    }.padding(horizontal = 10.dp, vertical = 5.dp),
                )
            }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = t.accent, trackColor = Color.Transparent)
        state.error?.let { Text(it, color = t.danger, fontSize = 13.sp, modifier = Modifier.padding(12.dp)) }
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            val inDb = state.keyspace[ws.currentDatabase]
            Text("${state.keys.size}${if (state.hasMore) "+" else ""} keys" + (inDb?.let { " · $it in ${ws.currentDatabase}" } ?: ""), color = t.textFaint, fontSize = 12.sp, modifier = Modifier.weight(1f))
            if (!ws.profile.readOnly) BdButton("New Key", { creating = true }, icon = Icons.Filled.Add)
        }
        BdDivider()
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(state.keys, key = { it.name }) { key ->
                val open = ws.activeTab.let { it is WorkTab.RedisKey && it.key == key.name }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(if (open) t.selection else Color.Transparent)
                        .combinedClickable(onClick = { ws.openRedisKey(key.name) }, onLongClick = { if (!ws.profile.readOnly) deleting = key.name })
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        typeBadge(key.type), color = redisTypeColor(key.type), fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.width(44.dp).clip(RoundedCornerShape(4.dp)).background(redisTypeColor(key.type).copy(alpha = 0.14f)).padding(vertical = 2.dp),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(key.name, color = if (open) t.accent else t.text, style = monoStyle(13), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (key.ttl >= 0) {
                        Spacer(Modifier.width(6.dp))
                        Icon(Icons.Outlined.Timer, "Expires", tint = t.textFaint, modifier = Modifier.size(13.dp))
                        Text(formatTtl(key.ttl), color = t.textFaint, fontSize = 11.sp)
                    }
                }
            }
            if (state.hasMore) item {
                Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                    BdButton(if (state.loading) "Scanning…" else "Load More", { scope.launch { state.loadMore() } }, enabled = !state.loading)
                }
            }
            if (state.keys.isEmpty() && !state.loading && state.error == null) item {
                Text(if (state.pattern == "*" && state.type == null) "This database has no keys." else "No keys match.", color = t.textFaint, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
            }
        }
    }
    LaunchedEffect(Unit) { if (state.keys.isEmpty()) state.reload() }

    if (creating) NewKeyDialog(onDismiss = { creating = false }) { name, type, a, b, ttl ->
        scope.launch {
            val e = state.create(name, type, a, b, ttl)
            if (e == null) { creating = false; ws.openRedisKey(name) } else error = e
        }
    }
    deleting?.let { name ->
        BdDialog("Delete $name?", { deleting = null }, confirmLabel = "Delete", danger = true, onConfirm = {
            deleting = null
            scope.launch { state.delete(listOf(name))?.let { error = it } }
        }) { Text("The key and its value are deleted from Redis.", color = t.textDim) }
    }
    error?.let { m -> BdDialog("Redis", { error = null }, confirmLabel = "OK", onConfirm = { error = null }, dismissLabel = null) { Text(m) } }
}

@Composable
private fun NewKeyDialog(onDismiss: () -> Unit, onCreate: (String, String, String, String, Long?) -> Unit) {
    val t = bd
    var name by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("string") }
    var first by remember { mutableStateOf("") }
    var second by remember { mutableStateOf("") }
    var ttl by remember { mutableStateOf("") }
    BdDialog("New Key", onDismiss, confirmLabel = "Create", confirmEnabled = name.isNotBlank(), onConfirm = { onCreate(name.trim(), type, first, second, ttl.toLongOrNull()) }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            BdTextField(name, { name = it }, label = "Key", placeholder = "user:42", mono = true)
            BdSelect(REDIS_TYPES.filterNotNull(), type, { type = it }, { it }, title = "Type")
            when (type) {
                "string" -> BdTextField(first, { first = it }, label = "Value", singleLine = false, minLines = 2, mono = true)
                "hash", "stream" -> {
                    BdTextField(first, { first = it }, label = "Field", mono = true)
                    BdTextField(second, { second = it }, label = "Value", mono = true)
                }
                "zset" -> {
                    BdTextField(first, { first = it }, label = "Member", mono = true)
                    BdTextField(second, { second = it }, label = "Score", keyboardType = KeyboardType.Decimal)
                }
                else -> BdTextField(first, { first = it }, label = if (type == "list") "First item" else "First member", mono = true)
            }
            BdTextField(ttl, { ttl = it.filter(Char::isDigit) }, label = "Expire after (seconds, optional)", keyboardType = KeyboardType.Number)
            Text("Redis keeps a collection only while it has an item, so a new one starts with one.", color = t.textFaint, fontSize = 12.sp)
        }
    }
}

/** One key: its type, TTL and value, with the edits that type allows. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RedisKeyTab(ws: Workspace, state: RedisKeyState) {
    val t = bd
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val writable = !ws.profile.readOnly
    var error by remember { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf<RedisDialog?>(null) }
    var deleting by remember { mutableStateOf(false) }

    fun edit(description: String, block: (com.brainfactory.db.engine.RedisSession) -> Unit) {
        scope.launch { state.edit(description, block)?.let { error = it } }
    }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().background(t.panel).padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val type = when (state.value) {
                    is RedisValue.Str -> "string"
                    is RedisValue.HashV -> "hash"
                    is RedisValue.ListV -> "list"
                    is RedisValue.SetV -> "set"
                    is RedisValue.ZSetV -> "zset"
                    is RedisValue.StreamV -> "stream"
                    is RedisValue.Other -> (state.value as RedisValue.Other).type
                    null -> ""
                }
                if (type.isNotEmpty()) { BdBadge(type.uppercase(), redisTypeColor(type)); Spacer(Modifier.width(8.dp)) }
                Box(Modifier.weight(1f)) { SelectionContainer { Text(state.key, style = monoStyle(14), color = t.text, maxLines = 2, overflow = TextOverflow.Ellipsis) } }
                IconButton(onClick = { state.load() }) { Icon(Icons.Filled.Refresh, "Refresh", tint = t.textDim) }
                if (writable) IconButton(onClick = { deleting = true }) { Icon(Icons.Filled.Delete, "Delete key", tint = t.danger) }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("TTL: " + formatTtl(state.ttl), color = t.textDim, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
                state.value?.let { v -> Text(if (v is RedisValue.Str) "${v.total} bytes" else "${v.total} items", color = t.textDim, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
                if (writable) {
                    BdButton("Set TTL", { dialog = RedisDialog.Ttl })
                    BdButton("Rename", { dialog = RedisDialog.Rename })
                }
            }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = t.accent, trackColor = Color.Transparent)
        BdDivider()
        state.error?.let { Text(it, color = t.danger, fontSize = 13.sp, modifier = Modifier.padding(12.dp)) }
        when (val v = state.value) {
            null -> if (state.loading) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = t.accent) }
            is RedisValue.Str -> StringValue(v, writable, onCopy = { copyToClipboard(context, v.text) }) { text -> edit("SET ${state.key}") { it.setString(state.key, text) } }
            is RedisValue.HashV -> ItemList(
                v.fields.map { it.first to it.second }, "field", writable,
                onAdd = { dialog = RedisDialog.Pair("Add Field", "Field", "Value") { f, value -> edit("HSET ${state.key} $f") { it.hashSet(state.key, f, value) } } },
                onEdit = { (f, value) -> dialog = RedisDialog.Pair("Edit $f", "Field", "Value", f, value, firstLocked = true) { _, nv -> edit("HSET ${state.key} $f") { it.hashSet(state.key, f, nv) } } },
                onDelete = { (f, _) -> edit("HDEL ${state.key} $f") { it.hashDelete(state.key, f) } },
            )
            is RedisValue.ListV -> ItemList(
                v.items.mapIndexed { i, s -> i.toString() to s }, "item", writable,
                onAdd = { dialog = RedisDialog.ListPush },
                onEdit = { (i, value) -> dialog = RedisDialog.Single("Edit item $i", "Value", value) { nv -> edit("LSET ${state.key} $i") { it.listSet(state.key, i.toLong(), nv) } } },
                onDelete = { (i, _) -> edit("remove item $i of ${state.key}") { it.listRemoveAt(state.key, i.toLong()) } },
            )
            is RedisValue.SetV -> ItemList(
                v.members.map { "" to it }, "member", writable,
                onAdd = { dialog = RedisDialog.Single("Add Member", "Member", "") { m -> edit("SADD ${state.key}") { it.setAdd(state.key, m) } } },
                onEdit = null,
                onDelete = { (_, m) -> edit("SREM ${state.key} $m") { it.setRemove(state.key, m) } },
            )
            is RedisValue.ZSetV -> ItemList(
                v.members.map { formatScore(it.second) to it.first }, "member", writable,
                onAdd = { dialog = RedisDialog.Pair("Add Member", "Member", "Score") { m, s -> edit("ZADD ${state.key}") { it.zsetAdd(state.key, m, s.toDoubleOrNull() ?: 0.0) } } },
                onEdit = { (score, m) -> dialog = RedisDialog.Pair("Score of $m", "Member", "Score", m, score, firstLocked = true) { _, s -> edit("ZADD ${state.key} $m") { it.zsetAdd(state.key, m, s.toDoubleOrNull() ?: 0.0) } } },
                onDelete = { (_, m) -> edit("ZREM ${state.key} $m") { it.zsetRemove(state.key, m) } },
            )
            is RedisValue.StreamV -> ItemList(
                v.entries.map { (id, fields) -> id to fields.joinToString("  ") { "${it.first}=${it.second}" } }, "entry", writable,
                onAdd = { dialog = RedisDialog.Pair("Add Entry", "Field", "Value") { f, value -> edit("XADD ${state.key}") { it.streamAdd(state.key, listOf(f to value)) } } },
                onEdit = null,
                onDelete = { (id, _) -> edit("XDEL ${state.key} $id") { it.streamDelete(state.key, id) } },
            )
            is RedisValue.Other -> Text(v.text, color = t.textDim, modifier = Modifier.padding(16.dp))
        }
        state.value?.let { v ->
            val shown = when (v) {
                is RedisValue.HashV -> v.fields.size
                is RedisValue.ListV -> v.items.size
                is RedisValue.SetV -> v.members.size
                is RedisValue.ZSetV -> v.members.size
                is RedisValue.StreamV -> v.entries.size
                else -> null
            }
            if (shown != null && shown < v.total) Text("Showing the first $shown of ${v.total}; use the console for the rest.", color = t.warning, fontSize = 12.sp, modifier = Modifier.padding(10.dp))
        }
    }

    when (val d = dialog) {
        null -> Unit
        RedisDialog.Ttl -> {
            var text by remember { mutableStateOf(if (state.ttl > 0) state.ttl.toString() else "") }
            BdDialog("Expiry of ${state.key}", { dialog = null }, confirmLabel = "Save", onConfirm = {
                dialog = null
                val seconds = text.toLongOrNull()?.takeIf { it > 0 }
                edit(if (seconds == null) "PERSIST ${state.key}" else "EXPIRE ${state.key} $seconds") { it.expire(state.key, seconds) }
            }) { BdTextField(text, { text = it.filter(Char::isDigit) }, label = "Seconds (empty: never expires)", keyboardType = KeyboardType.Number, imeAction = ImeAction.Done) }
        }
        RedisDialog.Rename -> {
            var text by remember { mutableStateOf(state.key) }
            BdDialog("Rename Key", { dialog = null }, confirmLabel = "Rename", confirmEnabled = text.isNotBlank() && text != state.key, onConfirm = {
                dialog = null
                scope.launch { state.rename(text.trim())?.let { error = it } }
            }) { BdTextField(text, { text = it }, label = "New name", mono = true, imeAction = ImeAction.Done) }
        }
        RedisDialog.ListPush -> {
            var text by remember { mutableStateOf("") }
            BdDialog("Add Item", { dialog = null }, confirmLabel = "Add to End", onConfirm = {
                dialog = null
                edit("RPUSH ${state.key}") { it.listPush(state.key, text, head = false) }
            }, dismissLabel = "Cancel") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BdTextField(text, { text = it }, label = "Value", mono = true)
                    BdButton("Add to Start", { dialog = null; edit("LPUSH ${state.key}") { it.listPush(state.key, text, head = true) } })
                }
            }
        }
        is RedisDialog.Single -> {
            var text by remember(d) { mutableStateOf(d.value) }
            BdDialog(d.title, { dialog = null }, confirmLabel = "Save", onConfirm = { dialog = null; d.onSave(text) }) {
                BdTextField(text, { text = it }, label = d.label, singleLine = false, minLines = 2, mono = true)
            }
        }
        is RedisDialog.Pair -> {
            var a by remember(d) { mutableStateOf(d.first) }
            var b by remember(d) { mutableStateOf(d.second) }
            BdDialog(d.title, { dialog = null }, confirmLabel = "Save", confirmEnabled = a.isNotBlank(), onConfirm = { dialog = null; d.onSave(a, b) }) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BdTextField(a, { a = it }, label = d.firstLabel, mono = true, enabled = !d.firstLocked)
                    BdTextField(b, { b = it }, label = d.secondLabel, singleLine = false, minLines = 2, mono = true)
                }
            }
        }
    }
    if (deleting) BdDialog("Delete ${state.key}?", { deleting = false }, confirmLabel = "Delete", danger = true, onConfirm = {
        deleting = false
        scope.launch {
            val e = ws.redisKeys?.delete(listOf(state.key))
            if (e != null) error = e
        }
    }) { Text("The key and its value are deleted from Redis.", color = t.textDim) }
    error?.let { m -> BdDialog("Redis", { error = null }, confirmLabel = "OK", onConfirm = { error = null }, dismissLabel = null) { Text(m) } }
}

private sealed interface RedisDialog {
    data object Ttl : RedisDialog
    data object Rename : RedisDialog
    data object ListPush : RedisDialog
    class Single(val title: String, val label: String, val value: String, val onSave: (String) -> Unit) : RedisDialog
    class Pair(
        val title: String, val firstLabel: String, val secondLabel: String, val first: String = "", val second: String = "",
        val firstLocked: Boolean = false, val onSave: (String, String) -> Unit,
    ) : RedisDialog
}

private fun formatScore(d: Double) = if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()

@Composable
private fun StringValue(v: RedisValue.Str, writable: Boolean, onCopy: () -> Unit, onSave: (String) -> Unit) {
    val t = bd
    var text by remember(v) { mutableStateOf(v.text) }
    var pretty by remember(v) { mutableStateOf(false) }
    val json = remember(v) { v.text.trimStart().let { it.startsWith("{") || it.startsWith("[") } && prettyJson(v.text) != v.text }
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (pretty) {
            SelectionContainer(Modifier.weight(1f)) {
                Text(prettyJson(v.text), style = monoStyle(13), color = t.text, modifier = Modifier.fillMaxSize().background(t.field, SmallRadius).padding(10.dp))
            }
        } else {
            BdTextField(text, { text = it }, Modifier.weight(1f, fill = false).heightIn(min = 120.dp), singleLine = false, minLines = 5, mono = true, enabled = writable)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BdButton("Copy", onCopy, icon = Icons.Outlined.ContentCopy)
            if (json) BdButton(if (pretty) "Edit" else "Format JSON", { pretty = !pretty })
            Spacer(Modifier.weight(1f))
            if (writable && !pretty) BdButton("Save", { onSave(text) }, primary = true, enabled = text != v.text)
        }
    }
}

/** Items as rows: [first] is the field, index or score; tap edits, the bin deletes. */
@Composable
private fun ItemList(
    items: List<kotlin.Pair<String, String>>,
    noun: String,
    writable: Boolean,
    onAdd: () -> Unit,
    onEdit: ((kotlin.Pair<String, String>) -> Unit)?,
    onDelete: (kotlin.Pair<String, String>) -> Unit,
) {
    val t = bd
    val context = LocalContext.current
    var confirm by remember { mutableStateOf<kotlin.Pair<String, String>?>(null) }
    Column(Modifier.fillMaxSize()) {
        if (writable) Row(Modifier.padding(10.dp)) { BdButton("Add ${noun.replaceFirstChar { it.uppercase() }}", onAdd, icon = Icons.Filled.Add) }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            itemsIndexed(items) { _, item ->
                Row(
                    Modifier.fillMaxWidth().clickable { if (writable && onEdit != null) onEdit(item) else copyToClipboard(context, item.second) }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (item.first.isNotEmpty()) {
                        Text(item.first, style = monoStyle(12), color = t.keyword, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp))
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(item.second, style = monoStyle(13), color = t.text, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (writable && onEdit != null) Icon(Icons.Outlined.Edit, "Edit", tint = t.textFaint, modifier = Modifier.size(16.dp))
                    if (writable) IconButton(onClick = { confirm = item }, modifier = Modifier.size(36.dp)) { Icon(Icons.Filled.Delete, "Delete", tint = t.textFaint, modifier = Modifier.size(18.dp)) }
                }
                BdDivider()
            }
        }
    }
    confirm?.let { item ->
        BdDialog("Remove this $noun?", { confirm = null }, confirmLabel = "Remove", danger = true, onConfirm = { confirm = null; onDelete(item) }) {
            Text(item.second, style = monoStyle(13), color = t.text, maxLines = 6, overflow = TextOverflow.Ellipsis)
        }
    }
}
