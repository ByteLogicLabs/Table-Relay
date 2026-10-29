package com.brainfactory.db.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.Functions
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.data.Settings
import com.brainfactory.db.engine.DbObject
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.ObjectKind
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.ServerState
import com.brainfactory.db.workspace.WorkTab
import com.brainfactory.db.workspace.Workspace
import com.brainfactory.db.workspace.Workspaces
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A connected workspace, laid out like Table Relay's: the objects (tables, views, collections, Redis keys) in a
 * sidebar, and tabs for tables, queries, processes, the query log and realtime channels. On a phone the sidebar
 * is the first page and a tab fills the screen; from 840 dp wide (tablets, unfolded foldables) they sit side by side.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(nav: Navigator, ws: Workspace) {
    val t = bd
    val context = LocalContext.current
    val settings = remember { Settings.get(context) }
    ws.pageSize = settings.pageSize
    ws.maxResultRows = settings.maxResultRows
    var menu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(ws.notice) {
        ws.notice?.let { snackbar.showSnackbar(it); ws.notice = null }
    }

    val exportDb = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/vnd.sqlite3")) { uri ->
        if (uri != null) scope.launch {
            ws.notice = runCatching {
                withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")!!.use { out -> File(ws.profile.database).inputStream().use { it.copyTo(out) } } }
            }.fold({ "Database file saved." }, { "The file couldn't be saved: ${it.message}" })
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(t.background)) {
        val wide = maxWidth >= 840.dp
        BackHandler(enabled = !wide && ws.activeTabId != null) { ws.activeTabId = null }

        Scaffold(
            containerColor = t.background,
            snackbarHost = { SnackbarHost(snackbar) },
            topBar = {
                Column {
                    TopAppBar(
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                        navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Connections", tint = t.text) } },
                        title = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                ws.profile.color?.let { Box(Modifier.size(10.dp).clip(CircleShape).background(Color(it))); Spacer(Modifier.width(8.dp)) }
                                Column(Modifier.clickable(enabled = ws.capabilities.databases && ws.status == Workspace.Status.Ready) { ws.pickingDatabase = true }) {
                                    Text(ws.profile.name.ifBlank { ws.profile.summary }, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            ws.currentDatabase ?: (if (ws.capabilities.databases) "Choose a database" else ws.profile.driver.label),
                                            color = t.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                        if (ws.capabilities.databases) Icon(Icons.Filled.ArrowDropDown, "Choose database", tint = t.textDim, modifier = Modifier.size(16.dp))
                                    }
                                }
                            }
                        },
                        actions = {
                            if (ws.status == Workspace.Status.Ready) {
                                IconButton(onClick = { ws.openQuery() }) { Icon(Icons.Filled.Add, "New query", tint = t.text) }
                                IconButton(onClick = { ws.refreshObjects() }) { Icon(Icons.Filled.Refresh, "Refresh", tint = t.text) }
                            }
                            Box {
                                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Menu", tint = t.text) }
                                DropdownMenu(menu, { menu = false }) {
                                    val ready = ws.status == Workspace.Status.Ready
                                    DropdownMenuItem(text = { Text(if (ws.profile.driver == Driver.REDIS) "New Console" else "New Query") }, enabled = ready, onClick = { menu = false; ws.openQuery() })
                                    if (ws.capabilities.databases) DropdownMenuItem(text = { Text("Switch Database…") }, enabled = ready, onClick = { menu = false; ws.pickingDatabase = true })
                                    if (ws.capabilities.processList) DropdownMenuItem(text = { Text(if (ws.profile.driver == Driver.REDIS) "Clients" else "Process List") }, enabled = ready, onClick = { menu = false; ws.openProcesses() })
                                    ws.capabilities.realtime?.let { kind -> DropdownMenuItem(text = { Text("Realtime ($kind)") }, enabled = ready, onClick = { menu = false; ws.openRealtime() }) }
                                    DropdownMenuItem(text = { Text("Query Log") }, onClick = { menu = false; ws.openLog() })
                                    if (ws.profile.driver == Driver.SQLITE) DropdownMenuItem(text = { Text("Export Database File…") }, onClick = { menu = false; exportDb.launch(File(ws.profile.database).name) })
                                    DropdownMenuItem(text = { Text("Edit Connection") }, onClick = { menu = false; nav.push(Screen.EditConnection(ws.profile.id)) })
                                    DropdownMenuItem(text = { Text("Disconnect", color = t.danger) }, onClick = { menu = false; Workspaces.close(ws.profile.id); nav.pop() })
                                }
                            }
                        },
                    )
                    if (ws.status == Workspace.Status.Reconnecting) {
                        Row(Modifier.fillMaxWidth().background(t.warning.copy(alpha = 0.15f)).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(12.dp), color = t.warning, strokeWidth = 1.5.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("Reconnecting…", color = t.warning, fontSize = 12.sp)
                        }
                    }
                    BdDivider()
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
                when (val status = ws.status) {
                    Workspace.Status.Connecting -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(color = t.accent)
                        Spacer(Modifier.height(14.dp))
                        Text(connectingText(ws), color = t.textDim, textAlign = TextAlign.Center)
                    }
                    is Workspace.Status.Failed -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        BdEmpty("Couldn't connect", message = status.message) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                val localServer = remember(ws.profile.id) { ServerStore.get(context).forProfile(ws.profile.id) }
                                if (localServer != null) BdButton("Server Log", { nav.push(Screen.ServerLog(localServer.id)) })
                                else BdButton("Edit Connection", { nav.push(Screen.EditConnection(ws.profile.id)) })
                                BdButton("Try Again", { ws.connect() }, primary = true)
                            }
                        }
                    }
                    else -> if (wide) {
                        Row(Modifier.fillMaxSize()) {
                            Box(Modifier.width(300.dp).fillMaxHeight().background(t.panel)) { Sidebar(ws) }
                            VerticalDivider(color = t.border)
                            Column(Modifier.weight(1f).fillMaxHeight()) {
                                if (ws.tabs.isNotEmpty()) TabStrip(ws, showObjects = false)
                                Box(Modifier.weight(1f).fillMaxWidth()) {
                                    val tab = ws.activeTab
                                    if (tab == null) WelcomePane(ws) else TabContent(ws, tab)
                                }
                            }
                        }
                    } else {
                        Column(Modifier.fillMaxSize()) {
                            if (ws.tabs.isNotEmpty()) TabStrip(ws, showObjects = true)
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                val tab = ws.activeTab
                                if (tab == null) Sidebar(ws) else TabContent(ws, tab)
                            }
                        }
                    }
                }
            }
        }
    }

    if (ws.pickingDatabase) DatabasePicker(ws) { ws.pickingDatabase = false }
}

/** The open tabs, newest last; on a phone the first chip goes back to the object list. */
@Composable
private fun TabStrip(ws: Workspace, showObjects: Boolean) {
    val t = bd
    Row(
        Modifier.fillMaxWidth().background(t.chrome).horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showObjects) {
            TabChip(
                if (ws.profile.driver == Driver.REDIS) "Keys" else if (ws.profile.driver == Driver.MONGO) "Collections" else "Objects",
                Icons.AutoMirrored.Outlined.List, ws.activeTabId == null, onClick = { ws.activeTabId = null }, onClose = null,
            )
        }
        ws.tabs.forEach { tab ->
            TabChip(tab.title, tabIcon(tab), tab.id == ws.activeTabId, onClick = { ws.activeTabId = tab.id }, onClose = { ws.closeTab(tab.id) })
        }
    }
    BdDivider()
}

private fun tabIcon(tab: WorkTab): ImageVector = when (tab) {
    is WorkTab.Table -> if (tab.ref.kind == ObjectKind.VIEW) Icons.Outlined.Visibility else if (tab.ref.kind == ObjectKind.COLLECTION) Icons.Outlined.DataObject else Icons.Outlined.TableChart
    is WorkTab.Query -> Icons.Outlined.Terminal
    is WorkTab.Definition -> Icons.Outlined.Code
    is WorkTab.Processes -> Icons.Outlined.Memory
    is WorkTab.Log -> Icons.Outlined.History
    is WorkTab.Realtime -> Icons.Outlined.Bolt
    is WorkTab.RedisKey -> Icons.Outlined.Key
}

@Composable
private fun TabChip(title: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit, onClose: (() -> Unit)?) {
    val t = bd
    Row(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) t.panel else Color.Transparent)
            .clickable(onClick = onClick)
            .heightIn(min = 32.dp)
            .padding(start = 10.dp, end = if (onClose != null) 2.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (selected) t.accent else t.textDim, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(6.dp))
        Text(title, color = if (selected) t.text else t.textDim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
        if (onClose != null) {
            Box(Modifier.size(28.dp).clip(CircleShape).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Close, "Close $title", tint = t.textFaint, modifier = Modifier.size(14.dp))
            }
        }
    }
}

@Composable
private fun TabContent(ws: Workspace, tab: WorkTab) {
    when (tab) {
        is WorkTab.Table -> TableTab(ws, tab.state)
        is WorkTab.Query -> QueryTab(ws, tab.state)
        is WorkTab.Definition -> DefinitionTab(ws, tab)
        is WorkTab.Processes -> ProcessTab(ws, tab.state)
        is WorkTab.Log -> LogTab(ws)
        is WorkTab.Realtime -> RealtimeTab(ws, tab.state)
        is WorkTab.RedisKey -> RedisKeyTab(ws, tab.state)
    }
}

/** What the wide layout shows before a tab is opened. */
@Composable
private fun WelcomePane(ws: Workspace) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        BdEmpty(
            ws.profile.name.ifBlank { ws.profile.summary },
            message = when (ws.profile.driver) {
                Driver.REDIS -> "Pick a key on the left, or open the console to run commands."
                Driver.MONGO -> "Pick a collection on the left, or open a query to run shell commands."
                else -> "Pick a table on the left, or open a query."
            },
            icon = Icons.Outlined.Terminal,
        ) { BdButton(if (ws.profile.driver == Driver.REDIS) "Open Console" else "New Query", { ws.openQuery() }, primary = true) }
    }
}

/** The object list for SQL and Mongo, the key browser for Redis. */
@Composable
private fun Sidebar(ws: Workspace) {
    if (ws.redisKeys != null) RedisKeysPane(ws, ws.redisKeys) else ObjectsPane(ws)
}

/** Tables, views, routines and triggers (collections and views for Mongo), filterable, in collapsible groups. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ObjectsPane(ws: Workspace) {
    val t = bd
    val context = LocalContext.current
    var filter by rememberSaveable { mutableStateOf("") }
    val collapsed = remember { mutableStateMapOf<ObjectKind, Boolean>() }
    var actions by remember { mutableStateOf<DbObject?>(null) }
    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        BdTextField(filter, { filter = it }, Modifier.padding(10.dp), placeholder = "Filter…", imeAction = androidx.compose.ui.text.input.ImeAction.Search)
        if (ws.objectsLoading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = t.accent, trackColor = Color.Transparent)
        ws.objectsError?.let { Text(it, color = t.danger, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) }
        if (ws.currentDatabase == null && ws.capabilities.databases && !ws.objectsLoading) {
            BdEmpty("No database chosen", message = "Choose a database to see its tables.") {
                BdButton("Choose Database", { ws.pickingDatabase = true }, primary = true)
            }
        }
        val visible = ws.objects.filter { filter.isBlank() || it.name.contains(filter.trim(), ignoreCase = true) }
        val groups = visible.groupBy { it.kind }
        LazyColumn(Modifier.fillMaxSize()) {
            ObjectKind.entries.forEach { kind ->
                val items = groups[kind] ?: return@forEach
                item(key = "h:$kind") {
                    val isCollapsed = collapsed[kind] == true
                    Row(
                        Modifier.fillMaxWidth().clickable { collapsed[kind] = !isCollapsed }.padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(if (isCollapsed) Icons.Filled.ExpandMore else Icons.Filled.ExpandLess, null, tint = t.textFaint, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(kind.label, color = t.textDim, fontSize = 13.sp, modifier = Modifier.weight(1f))
                        Text(items.size.toString(), color = t.textFaint, fontSize = 12.sp)
                    }
                }
                if (collapsed[kind] != true) {
                    items(items, key = { "o:${it.kind}:${it.schema}:${it.name}" }) { obj ->
                        val open = ws.tabs.any { tab -> tab is WorkTab.Table && tab.ref.name == obj.name && tab.ref.schema == obj.schema && tab.id == ws.activeTabId }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 6.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(if (open) t.selection else Color.Transparent)
                                .combinedClickable(
                                    onClick = { if (obj.browsable) ws.openTable(obj) else ws.openDefinition(obj) },
                                    onLongClick = { actions = obj },
                                )
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(objectIcon(obj.kind), null, tint = if (open) t.accent else t.textDim, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    (if (obj.schema != null && obj.schema != "public") obj.schema + "." else "") + obj.name,
                                    color = if (open) t.accent else t.text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                obj.detail?.let { Text(it, color = t.textFaint, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            }
                            obj.rows?.let { Text(compactCount(it), color = t.textFaint, fontSize = 11.sp) }
                        }
                    }
                }
            }
            if (visible.isEmpty() && !ws.objectsLoading && ws.objectsError == null && ws.currentDatabase != null) {
                item { Text(if (filter.isBlank()) "This database is empty." else "Nothing matches “$filter”.", color = t.textFaint, fontSize = 13.sp, modifier = Modifier.padding(16.dp)) }
            }
        }
    }

    actions?.let { obj ->
        ObjectActions(ws, obj, onDismiss = { actions = null }, onConfirm = { title, sql -> actions = null; confirm = title to sql }, onCopy = { copyToClipboard(context, it); actions = null })
    }
    confirm?.let { (title, statement) ->
        BdDialog(title, { confirm = null }, confirmLabel = "Run", danger = true, onConfirm = {
            confirm = null
            scope.launch {
                val start = System.nanoTime()
                val results = runCatching { ws.call(read = false) { it.execute(statement) } }
                val error = results.exceptionOrNull()?.message ?: results.getOrNull()?.firstOrNull { !it.ok }?.error
                ws.logStatement(statement, (System.nanoTime() - start) / 1_000_000, error, "objects")
                ws.notice = error ?: "Done."
                ws.closeTabsFor { it is WorkTab.Table && statement.contains(it.ref.name) && statement.startsWith("DROP", true) }
                ws.refreshObjects()
                ws.tabs.filterIsInstance<WorkTab.Table>().forEach { tab -> if (statement.contains(tab.ref.name)) tab.state.load() }
            }
        }) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This can't be undone.", color = t.danger, fontSize = 13.sp)
                Text(statement, style = monoStyle(13), color = t.text, modifier = Modifier.fillMaxWidth().background(t.field, SmallRadius).padding(10.dp))
            }
        }
    }
}

/** Long press on an object: open, copy its name or a SELECT, open its definition, empty or drop it. */
@Composable
private fun ObjectActions(ws: Workspace, obj: DbObject, onDismiss: () -> Unit, onConfirm: (String, String) -> Unit, onCopy: (String) -> Unit) {
    val t = bd
    val driver = ws.profile.driver
    val dialect = driver.dialect
    val qualified = when (driver) {
        Driver.POSTGRES -> dialect.quote(obj.schema ?: "public") + "." + dialect.quote(obj.name)
        else -> dialect.quote(obj.name)
    }
    BdDialog(obj.name, onDismiss, confirmLabel = null, dismissLabel = "Close") {
        Column {
            if (obj.browsable) BdListRow("Open", icon = Icons.Outlined.TableChart, onClick = { onDismiss(); ws.openTable(obj) })
            if (driver.sql && obj.kind != ObjectKind.COLLECTION) {
                BdListRow("Show Definition", icon = Icons.Outlined.Code, onClick = { onDismiss(); ws.openDefinition(obj) })
            }
            if (obj.browsable) {
                val select = if (driver == Driver.MONGO) "db.${obj.name}.find({}).limit(50)" else "SELECT * FROM $qualified LIMIT 100;"
                BdListRow("New Query with SELECT", icon = Icons.Outlined.Terminal, onClick = { onDismiss(); ws.openInQuery(select) })
            }
            BdListRow("Copy Name", onClick = { onCopy(obj.name) })
            if (!ws.profile.readOnly) {
                when {
                    driver == Driver.MONGO && obj.kind == ObjectKind.COLLECTION -> {
                        BdListRow("Delete All Documents…", onClick = { onConfirm("Empty ${obj.name}?", "db.${obj.name}.deleteMany({})") })
                        BdListRow("Drop Collection…", onClick = { onConfirm("Drop ${obj.name}?", "db.${obj.name}.drop()") })
                    }
                    driver == Driver.MONGO -> BdListRow("Drop View…", onClick = { onConfirm("Drop ${obj.name}?", "db.${obj.name}.drop()") })
                    obj.kind == ObjectKind.TABLE -> {
                        BdListRow("Truncate…", onClick = { onConfirm("Empty ${obj.name}?", if (driver == Driver.SQLITE) "DELETE FROM $qualified;" else "TRUNCATE TABLE $qualified;") })
                        BdListRow("Drop Table…", onClick = { onConfirm("Drop ${obj.name}?", "DROP TABLE $qualified;") })
                    }
                    obj.kind == ObjectKind.VIEW -> BdListRow("Drop View…", onClick = { onConfirm("Drop ${obj.name}?", "DROP VIEW $qualified;") })
                    obj.kind == ObjectKind.TRIGGER && driver != Driver.POSTGRES -> BdListRow("Drop Trigger…", onClick = { onConfirm("Drop ${obj.name}?", "DROP TRIGGER $qualified;") })
                    else -> Unit
                }
            }
            Text(obj.kind.label.removeSuffix("s") + (obj.detail?.let { " · $it" } ?: ""), color = t.textFaint, fontSize = 12.sp, modifier = Modifier.padding(start = 16.dp, top = 8.dp))
        }
    }
}

private fun objectIcon(kind: ObjectKind): ImageVector = when (kind) {
    ObjectKind.TABLE -> Icons.Outlined.TableChart
    ObjectKind.VIEW -> Icons.Outlined.Visibility
    ObjectKind.COLLECTION -> Icons.Outlined.DataObject
    ObjectKind.ROUTINE -> Icons.Outlined.Functions
    ObjectKind.TRIGGER -> Icons.Outlined.Bolt
}

/** 3037 → "3k", for the sidebar's row estimates. */
fun compactCount(n: Long): String = when {
    n < 1000 -> n.toString()
    n < 1_000_000 -> "%.1fk".format(n / 1000.0).replace(".0k", "k")
    else -> "%.1fM".format(n / 1_000_000.0).replace(".0M", "M")
}

/** The server's databases (with key counts for Redis); picking one switches to it. */
@Composable
private fun DatabasePicker(ws: Workspace, onDismiss: () -> Unit) {
    val t = bd
    LaunchedEffect(Unit) { ws.loadDatabases() }
    BdDialog("Database", onDismiss, confirmLabel = null, dismissLabel = "Close") {
        if (ws.databases.isEmpty()) Text("This server lists no databases you can open.", color = t.textDim)
        LazyColumn(Modifier.heightIn(max = 420.dp)) {
            items(ws.databases) { name ->
                val on = name == ws.currentDatabase
                val keys = ws.redisKeys?.keyspace?.get(name)
                BdListRow(
                    name,
                    subtitle = keys?.let { "$it keys" },
                    icon = Icons.Outlined.Memory,
                    iconTint = if (on) t.accent else null,
                    trailing = { if (on) Text("current", color = t.accent, fontSize = 12.sp) },
                    onClick = { onDismiss(); ws.switchDatabase(name) },
                )
            }
        }
    }
}

/** What the workspace waits for: a local server downloading or starting, or the connection itself. */
@Composable
private fun connectingText(ws: Workspace): String {
    val context = LocalContext.current
    val server = remember(ws.profile.id) { ServerStore.get(context).forProfile(ws.profile.id) } ?: return "Connecting to ${ws.profile.summary}…"
    val states by remember { LocalHost.get(context) }.states.collectAsState()
    return when (val state = states[server.id]) {
        is ServerState.Installing -> "Downloading ${server.engine.label}… ${formatBytes(state.done)} of ${formatBytes(state.total)}"
        is ServerState.Starting -> "${server.name}: ${state.step}"
        else -> "Connecting to ${server.name}…"
    }
}
