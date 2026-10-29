package com.brainfactory.db.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.brainfactory.db.data.ProfileStore
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.engine.ConnectionProfile
import com.brainfactory.db.engine.ConnectionTransfer
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.ServerState
import com.brainfactory.db.update.UpdateBanner
import com.brainfactory.db.update.UpdatesDialog
import com.brainfactory.db.workspace.Workspace
import com.brainfactory.db.workspace.Workspaces
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The saved connections: tap to connect, ⋮ to edit; the menu has import, export, Settings and Check for Updates. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: Navigator) {
    val t = bd
    val context = LocalContext.current
    val store = remember { ProfileStore.get(context) }
    var menu by remember { mutableStateOf(false) }
    var updates by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    var importBytes by remember { mutableStateOf<ByteArray?>(null) }
    var deleting by remember { mutableStateOf<ConnectionProfile?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val serverStates by remember { LocalHost.get(context) }.states.collectAsState()
    val servers = remember { ServerStore.get(context) }

    val importPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            importBytes = runCatching { withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { it.readBytes() } } }
                .onFailure { message = "The file couldn't be read: ${it.message}" }.getOrNull()
        }
    }

    Scaffold(
        containerColor = t.background,
        topBar = {
            Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val logo = remember { context.getDrawable(context.applicationInfo.icon)?.toBitmap(96, 96)?.asImageBitmap() }
                            if (logo != null) {
                                Image(logo, null, Modifier.size(28.dp))
                                Spacer(Modifier.width(10.dp))
                            }
                            Text("Brain DB", fontWeight = FontWeight.SemiBold)
                        }
                    },
                    actions = {
                        val running = serverStates.values.any { it is ServerState.Running }
                        IconButton(onClick = { nav.push(Screen.Servers) }) {
                            Box {
                                Icon(Icons.Outlined.Dns, "Local Servers", tint = t.text)
                                if (running) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(t.success))
                            }
                        }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Menu", tint = t.text) }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(text = { Text("New Connection") }, onClick = { menu = false; nav.push(Screen.EditConnection(null)) })
                                DropdownMenuItem(text = { Text("Local Servers") }, onClick = { menu = false; nav.push(Screen.Servers) })
                                DropdownMenuItem(text = { Text("Import Connections…") }, onClick = { menu = false; importPicker.launch(arrayOf("*/*")) })
                                DropdownMenuItem(text = { Text("Export Connections…") }, enabled = store.profiles.isNotEmpty(), onClick = { menu = false; exporting = true })
                                DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; nav.push(Screen.Settings) })
                                DropdownMenuItem(text = { Text("Check for Updates") }, onClick = { menu = false; updates = true })
                            }
                        }
                    },
                )
                UpdateBanner()
            }
        },
        floatingActionButton = {
            if (store.profiles.isNotEmpty()) {
                ExtendedFloatingActionButton(
                    onClick = { nav.push(Screen.EditConnection(null)) },
                    containerColor = t.accent,
                    contentColor = t.onAccent,
                    icon = { Icon(Icons.Filled.Add, null) },
                    text = { Text("New Connection") },
                )
            }
        },
    ) { padding ->
        if (store.profiles.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                BdEmpty(
                    "No connections yet",
                    message = "Add a MySQL, PostgreSQL, SQLite, MongoDB or Redis connection, import the connections you exported from Table Relay, or run a database server on this phone.",
                    icon = Icons.Outlined.Storage,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        BdButton("New Connection", { nav.push(Screen.EditConnection(null)) }, primary = true, icon = Icons.Filled.Add)
                        BdButton("Import Connections…", { importPicker.launch(arrayOf("*/*")) })
                        BdButton("Local Servers", { nav.push(Screen.Servers) }, icon = Icons.Outlined.Dns)
                    }
                }
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                items(store.profiles, key = { it.id }) { profile ->
                    ConnectionCard(
                        profile,
                        Workspaces.get(profile.id),
                        local = servers.forProfile(profile.id) != null,
                        onOpen = {
                            Workspaces.open(context, profile)
                            nav.push(Screen.Workspace(profile.id))
                        },
                        onEdit = { nav.push(Screen.EditConnection(profile.id)) },
                        onDuplicate = { nav.push(Screen.EditConnection(null, duplicateOf = profile.id)) },
                        onFavorite = { store.save(profile.copy(favorite = !profile.favorite)) },
                        onDisconnect = { Workspaces.close(profile.id) },
                        onDelete = { deleting = profile },
                    )
                }
            }
        }
    }

    if (updates) UpdatesDialog { updates = false }
    if (exporting) ExportConnectionsDialog(store.profiles.toList(), onDone = { exporting = false; message = it })
    importBytes?.let { bytes -> ImportConnectionsDialog(bytes, onDone = { importBytes = null; message = it }) }
    deleting?.let { profile ->
        BdDialog("Delete ${profile.name.ifBlank { "connection" }}?", { deleting = null }, confirmLabel = "Delete", danger = true, onConfirm = {
            Workspaces.close(profile.id)
            store.delete(profile.id)
            deleting = null
        }) { Text("The saved connection and its password are removed from this phone. The database itself isn't touched.", color = t.textDim) }
    }
    message?.let { m -> BdDialog("Connections", { message = null }, confirmLabel = "OK", onConfirm = { message = null }, dismissLabel = null) { Text(m) } }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConnectionCard(
    profile: ConnectionProfile,
    workspace: Workspace?,
    local: Boolean,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    onDuplicate: () -> Unit,
    onFavorite: () -> Unit,
    onDisconnect: () -> Unit,
    onDelete: () -> Unit,
) {
    val t = bd
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .widthIn(max = 720.dp)
            .fillMaxWidth()
            .clip(CardRadius)
            .background(t.panel)
            .combinedClickable(onClick = onOpen, onLongClick = { menu = true })
            .heightIn(min = 64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(4.dp).height(64.dp).background(profile.color?.let { Color(it) } ?: Color.Transparent))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(t.field), contentAlignment = Alignment.Center) {
            DriverLogo(profile.driver, 26.dp)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(profile.name.ifBlank { profile.summary }, color = t.text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (profile.favorite) {
                    Spacer(Modifier.width(4.dp))
                    Icon(Icons.Filled.Star, "Favourite", tint = t.accent, modifier = Modifier.size(14.dp))
                }
            }
            Text(profile.summary, color = t.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                if (local) BdBadge("LOCAL SERVER", t.textDim)
                if (profile.ssh != null) BdBadge("SSH")
                if (profile.readOnly) BdBadge("READ-ONLY", t.warning)
                when (workspace?.status) {
                    Workspace.Status.Ready -> BdBadge("CONNECTED", t.success)
                    Workspace.Status.Connecting, Workspace.Status.Reconnecting -> BdBadge("CONNECTING", t.textDim)
                    is Workspace.Status.Failed -> BdBadge("FAILED", t.danger)
                    null -> Unit
                }
            }
        }
        if (workspace?.status == Workspace.Status.Connecting) {
            CircularProgressIndicator(Modifier.size(18.dp), color = t.accent, strokeWidth = 2.dp)
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Connection menu", tint = t.textDim) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text("Connect") }, onClick = { menu = false; onOpen() })
                DropdownMenuItem(text = { Text("Edit") }, onClick = { menu = false; onEdit() })
                DropdownMenuItem(text = { Text("Duplicate") }, onClick = { menu = false; onDuplicate() })
                DropdownMenuItem(text = { Text(if (profile.favorite) "Remove from Favourites" else "Add to Favourites") }, onClick = { menu = false; onFavorite() })
                if (workspace != null) DropdownMenuItem(text = { Text("Disconnect") }, onClick = { menu = false; onDisconnect() })
                DropdownMenuItem(text = { Text("Delete", color = t.danger) }, onClick = { menu = false; onDelete() })
            }
        }
    }
}

/** Picks connections and a password, and saves them as a Table Relay `.dtab` export the desktop app can import. */
@Composable
private fun ExportConnectionsDialog(profiles: List<ConnectionProfile>, onDone: (String?) -> Unit) {
    val t = bd
    val context = LocalContext.current
    val chosen = remember { mutableStateListOf<String>().apply { addAll(profiles.map { it.id }) } }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val json = ConnectionTransfer.toJson(profiles.filter { it.id in chosen })
                    context.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(ConnectionTransfer.encrypt(json.toByteArray(), password)) }
                }
            }
            onDone(result.fold({ "Exported ${chosen.size} connection${if (chosen.size == 1) "" else "s"}." }, { "The export couldn't be saved: ${it.message}" }))
        }
    }
    BdDialog(
        "Export Connections", { onDone(null) }, confirmLabel = "Export…",
        confirmEnabled = chosen.isNotEmpty() && password.length >= 4 && password == confirm,
        onConfirm = { saver.launch("connections.dtab") },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("The export holds passwords and SSH keys, so it is encrypted with a password (the same .dtab format Table Relay uses).", color = t.textDim, fontSize = 13.sp)
            LazyColumn(Modifier.heightIn(max = 220.dp)) {
                items(profiles, key = { it.id }) { p ->
                    Row(Modifier.fillMaxWidth().clickable { if (p.id in chosen) chosen.remove(p.id) else chosen.add(p.id) }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(p.id in chosen, { if (it) chosen.add(p.id) else chosen.remove(p.id) }, colors = CheckboxDefaults.colors(checkedColor = t.accent, checkmarkColor = t.onAccent))
                        Text(p.name.ifBlank { p.summary }, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            BdTextField(password, { password = it }, label = "Password", password = true)
            BdTextField(confirm, { confirm = it }, label = "Repeat password", password = true, imeAction = androidx.compose.ui.text.input.ImeAction.Done)
            if (password.isNotEmpty() && password.length < 4) Text("Use at least 4 characters.", color = t.warning, fontSize = 12.sp)
            else if (confirm.isNotEmpty() && confirm != password) Text("The passwords differ.", color = t.warning, fontSize = 12.sp)
        }
    }
}

/** Reads a Table Relay / Brain DB export (encrypted `.dtab` or plain JSON) and imports the connections picked. */
@Composable
private fun ImportConnectionsDialog(bytes: ByteArray, onDone: (String?) -> Unit) {
    val t = bd
    val context = LocalContext.current
    val store = remember { ProfileStore.get(context) }
    val encrypted = remember(bytes) { ConnectionTransfer.isEncrypted(bytes) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var parsed by remember { mutableStateOf<List<ConnectionProfile>?>(if (encrypted) null else runCatching { ConnectionTransfer.fromJson(String(bytes)) }.getOrNull()) }
    val chosen = remember { mutableStateListOf<String>() }
    if (!encrypted && parsed == null) {
        BdDialog("Import Connections", { onDone(null) }, confirmLabel = null, dismissLabel = "Close") {
            Text("This file isn't a Table Relay or Brain DB connections export.", color = t.textDim)
        }
        return
    }
    val list = parsed
    if (list == null) {
        BdDialog("Encrypted export", { onDone(null) }, confirmLabel = "Unlock", confirmEnabled = password.isNotEmpty(), onConfirm = {
            runCatching { ConnectionTransfer.fromJson(String(ConnectionTransfer.decrypt(bytes, password))) }
                .onSuccess { parsed = it; chosen.clear(); chosen.addAll(it.map { p -> p.id }) }
                .onFailure { error = it.message }
        }) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Enter the password used when this file was exported.", color = t.textDim, fontSize = 13.sp)
                BdTextField(password, { password = it; error = null }, label = "Password", password = true, imeAction = androidx.compose.ui.text.input.ImeAction.Done)
                error?.let { Text(it, color = t.danger, fontSize = 13.sp) }
            }
        }
        return
    }
    if (chosen.isEmpty() && list.isNotEmpty() && error == null) {
        chosen.addAll(list.map { it.id })
        error = ""
    }
    BdDialog("Import ${list.size} connection${if (list.size == 1) "" else "s"}", { onDone(null) }, confirmLabel = "Import", confirmEnabled = chosen.isNotEmpty(), onConfirm = {
        store.saveAll(list.filter { it.id in chosen })
        onDone("Imported ${chosen.size} connection${if (chosen.size == 1) "" else "s"}." + if (list.any { p -> p.ssh?.let { it.auth == com.brainfactory.db.engine.SshAuth.KEY && it.privateKey.isBlank() } == true }) " Connections that used an SSH key file need the key pasted in: edit them once." else "")
    }) {
        LazyColumn(Modifier.heightIn(max = 300.dp)) {
            items(list, key = { it.id }) { p ->
                Row(Modifier.fillMaxWidth().clickable { if (p.id in chosen) chosen.remove(p.id) else chosen.add(p.id) }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(p.id in chosen, { if (it) chosen.add(p.id) else chosen.remove(p.id) }, colors = CheckboxDefaults.colors(checkedColor = t.accent, checkmarkColor = t.onAccent))
                    DriverLogo(p.driver, 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Column {
                        Text(p.name.ifBlank { p.summary }, color = t.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(p.summary + if (store.get(p.id) != null) " · replaces the saved one" else "", color = t.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** A coloured dot, for the connection colour picker. */
@Composable
fun ColorDot(color: Color?, selected: Boolean, onClick: () -> Unit) {
    val t = bd
    Box(
        Modifier
            .size(30.dp)
            .clip(CircleShape)
            .background(if (selected) t.text else t.border)
            .clickable(onClick = onClick)
            .padding(3.dp)
            .clip(CircleShape)
            .background(color ?: t.field),
        contentAlignment = Alignment.Center,
    ) {
        if (color == null) Text("—", color = t.textDim, fontSize = 12.sp)
    }
}
