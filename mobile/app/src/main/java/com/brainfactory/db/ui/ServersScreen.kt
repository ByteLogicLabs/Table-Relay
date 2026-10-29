package com.brainfactory.db.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.brainfactory.db.data.ProfileStore
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.host.Engine
import com.brainfactory.db.host.Installation
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.LocalServer
import com.brainfactory.db.host.ServerState
import com.brainfactory.db.server.LocalServers
import com.brainfactory.db.workspace.Workspaces
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The database servers running on this phone: each one's state with Start/Stop, its connection details, log and
 * settings. New Server downloads an engine and sets one up.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServersScreen(nav: Navigator) {
    val t = bd
    val context = LocalContext.current
    val store = remember { ServerStore.get(context) }
    val host = remember { LocalHost.get(context) }
    val states by host.states.collectAsState()
    var menu by remember { mutableStateOf(false) }
    var versions by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf<LocalServer?>(null) }
    var deleting by remember { mutableStateOf<LocalServer?>(null) }
    var failure by remember { mutableStateOf<Pair<LocalServer, String>?>(null) }
    val scope = rememberCoroutineScope()
    val askNotifications = rememberNotificationRequest()

    fun start(server: LocalServer) {
        askNotifications()
        LocalServers.start(context, server)
    }

    fun open(server: LocalServer) {
        val profile = server.profileId?.let { ProfileStore.get(context).get(it) } ?: LocalServers.addConnection(context, server)
        askNotifications()
        Workspaces.open(context, profile)
        nav.push(Screen.Workspace(profile.id))
    }

    Scaffold(
        containerColor = t.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = t.text) } },
                title = { Text("Local Servers") },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Menu", tint = t.text) }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem(text = { Text("New Server") }, onClick = { menu = false; nav.push(Screen.EditServer(null)) })
                            DropdownMenuItem(text = { Text("Installed Versions…") }, onClick = { menu = false; versions = true })
                            if (states.values.any { it.active }) DropdownMenuItem(text = { Text("Stop All") }, onClick = { menu = false; scope.launch { host.stopAll() } })
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            if (store.servers.isNotEmpty()) {
                ExtendedFloatingActionButton(
                    onClick = { nav.push(Screen.EditServer(null)) },
                    containerColor = t.accent,
                    contentColor = t.onAccent,
                    icon = { Icon(Icons.Filled.Add, null) },
                    text = { Text("New Server") },
                )
            }
        },
    ) { padding ->
        if (store.servers.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                BdEmpty(
                    "No local servers yet",
                    message = "Run PostgreSQL, MariaDB, Redis or Valkey on this phone. Nothing is bundled with the app: the server you pick is downloaded when you add it.",
                    icon = Icons.Outlined.Dns,
                ) {
                    BdButton("New Server", { nav.push(Screen.EditServer(null)) }, primary = true, icon = Icons.Filled.Add)
                }
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                items(store.servers, key = { it.id }) { server ->
                    ServerCard(
                        server,
                        states[server.id] ?: ServerState.Stopped,
                        installed = host.installation(server.install) != null,
                        onOpen = { open(server) },
                        onStart = { start(server) },
                        onStop = { LocalServers.stop(context, server) },
                        onRestart = {
                            scope.launch {
                                host.stop(server.id)
                                start(server)
                            }
                        },
                        onDetails = { details = server },
                        onLog = { nav.push(Screen.ServerLog(server.id)) },
                        onSettings = { nav.push(Screen.EditServer(server.id)) },
                        onDelete = { deleting = server },
                        onFailure = { failure = server to it },
                    )
                }
                item {
                    Text(
                        "The servers are the Android builds from Termux's package repository, checked against its signature before they run. " +
                            "They run while Brain DB's notification shows, also with the app closed; Stop All in it stops them.",
                        color = t.textFaint, fontSize = 12.sp, modifier = Modifier.widthIn(max = 720.dp).padding(horizontal = 8.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }

    if (versions) InstalledVersionsDialog(store.servers.toList()) { versions = false }
    details?.let { server -> ConnectionDetailsDialog(server) { details = null } }
    failure?.let { (server, message) ->
        BdDialog("${server.name} failed", { failure = null }, confirmLabel = "Log", onConfirm = { failure = null; nav.push(Screen.ServerLog(server.id)) }, dismissLabel = "Close") {
            Text(message, style = monoStyle(12), color = t.text, modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()))
        }
    }
    deleting?.let { server ->
        var size by remember(server.id) { mutableLongStateOf(-1L) }
        LaunchedEffect(server.id) { size = withContext(Dispatchers.IO) { host.diskUsage(server.id) } }
        BdDialog("Delete ${server.name}?", { deleting = null }, confirmLabel = "Delete", danger = true, onConfirm = {
            deleting = null
            scope.launch { LocalServers.delete(context, server) }
        }) {
            Text(
                "The server stops, and its data (every database in it" + (if (size >= 0) ", ${formatBytes(size)}" else "") +
                    ") is deleted from this phone for good. Its saved connection is removed too.",
                color = t.textDim,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ServerCard(
    server: LocalServer,
    state: ServerState,
    installed: Boolean,
    onOpen: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRestart: () -> Unit,
    onDetails: () -> Unit,
    onLog: () -> Unit,
    onSettings: () -> Unit,
    onDelete: () -> Unit,
    onFailure: (String) -> Unit,
) {
    val t = bd
    var menu by remember { mutableStateOf(false) }
    val busy = state is ServerState.Installing || state is ServerState.Starting || state is ServerState.Stopping
    Column(
        Modifier
            .widthIn(max = 720.dp)
            .fillMaxWidth()
            .clip(CardRadius)
            .background(t.panel)
            .combinedClickable(onClick = onOpen, onLongClick = { menu = true })
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(t.field), contentAlignment = Alignment.Center) {
                DriverLogo(LocalServers.driverOf(server.engine), 26.dp)
                if (state is ServerState.Running) {
                    Box(Modifier.align(Alignment.BottomEnd).padding(2.dp).size(9.dp).clip(CircleShape).background(t.success))
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(server.name, color = t.text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${server.engine.label} ${LocalHost.versionOf(server.install)} · port ${server.port} · " + if (server.lan) "this phone and its networks" else "this phone only",
                    color = t.textDim, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                    when (state) {
                        is ServerState.Running -> BdBadge("RUNNING", t.success)
                        is ServerState.Starting -> {
                            BdBadge("STARTING", t.accent)
                            Text(state.step, color = t.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        is ServerState.Installing -> {
                            BdBadge("DOWNLOADING", t.accent)
                            Text("${formatBytes(state.done)} of ${formatBytes(state.total)}", color = t.textDim, fontSize = 12.sp)
                        }
                        ServerState.Stopping -> BdBadge("STOPPING", t.textDim)
                        is ServerState.Failed -> BdBadge("FAILED", t.danger)
                        ServerState.Stopped -> if (installed) BdBadge("STOPPED", t.textFaint) else BdBadge("NOT INSTALLED", t.warning)
                    }
                }
            }
            when {
                busy -> Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = t.accent, strokeWidth = 2.dp) }
                state is ServerState.Running -> IconButton(onClick = onStop) { Icon(Icons.Filled.Stop, "Stop", tint = t.text) }
                else -> IconButton(onClick = onStart) { Icon(Icons.Filled.PlayArrow, "Start", tint = t.accent) }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Server menu", tint = t.textDim) }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Connect") }, onClick = { menu = false; onOpen() })
                    if (state is ServerState.Running) {
                        DropdownMenuItem(text = { Text("Stop") }, onClick = { menu = false; onStop() })
                        DropdownMenuItem(text = { Text("Restart") }, onClick = { menu = false; onRestart() })
                    } else if (busy) {
                        DropdownMenuItem(text = { Text(if (state is ServerState.Installing) "Cancel Download" else "Stop") }, onClick = { menu = false; onStop() })
                    } else {
                        DropdownMenuItem(text = { Text("Start") }, onClick = { menu = false; onStart() })
                    }
                    DropdownMenuItem(text = { Text("Connection Details") }, onClick = { menu = false; onDetails() })
                    DropdownMenuItem(text = { Text("Log") }, onClick = { menu = false; onLog() })
                    DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; onSettings() })
                    DropdownMenuItem(text = { Text("Delete", color = t.danger) }, onClick = { menu = false; onDelete() })
                }
            }
        }
        if (state is ServerState.Installing && state.total > 0) {
            LinearProgressIndicator(
                progress = { (state.done.toFloat() / state.total).coerceIn(0f, 1f) },
                color = t.accent, trackColor = t.field,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp, end = 12.dp),
            )
        }
        if (state is ServerState.Failed) {
            Text(
                state.message.lineSequence().firstOrNull().orEmpty(),
                color = t.danger, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp, end = 12.dp).clickable { onFailure(state.message) },
            )
        }
    }
}

/** Where and how to connect to [server], from this phone and (when it listens there) from other devices. */
@Composable
private fun ConnectionDetailsDialog(server: LocalServer, onDismiss: () -> Unit) {
    val t = bd
    var reveal by remember { mutableStateOf(false) }
    val addresses = remember(server.lan) { if (server.lan) LocalServers.lanAddresses() else emptyList() }
    BdDialog(server.name, onDismiss, confirmLabel = "Done", onConfirm = onDismiss, dismissLabel = null) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            DetailRow("Host on this phone", "127.0.0.1")
            if (server.lan) {
                DetailRow(
                    "From other devices",
                    addresses.joinToString("\n").ifEmpty { "No Wi-Fi or Ethernet network right now" },
                    copy = addresses.firstOrNull(),
                )
            }
            DetailRow("Port", server.port.toString())
            DetailRow("User", server.engine.user ?: "—")
            DetailRow("Password", if (reveal) server.password else "•".repeat(10), copy = server.password, onClick = { reveal = !reveal })
            val url = connectionUrl(server, "127.0.0.1")
            DetailRow("URL", url.replace(urlPassword(server.password), "•••"), copy = url)
            Text(
                if (server.engine.user != null) {
                    "The password is the one the server was set up with. If you change it with SQL (ALTER USER), edit the connection to match."
                } else {
                    "${server.engine.label} has no user name: clients send only the password. One set with CONFIG SET lasts until the server restarts."
                },
                color = t.textFaint, fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String, copy: String? = null, onClick: (() -> Unit)? = null) {
    val t = bd
    val context = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)) {
            Text(label, color = t.textDim, fontSize = 12.sp)
            Text(value, color = t.text, style = monoStyle(13))
        }
        if (copy != null) {
            IconButton(onClick = { copyToClipboard(context, copy, label) }) { Icon(Icons.Outlined.ContentCopy, "Copy $label", tint = t.textDim, modifier = Modifier.size(18.dp)) }
        }
    }
}

private fun urlPassword(password: String) = URLEncoder.encode(password, "UTF-8").replace("+", "%20")

/** A connection URL clients take: postgresql://, mysql:// or redis://. */
private fun connectionUrl(server: LocalServer, host: String): String {
    val pw = urlPassword(server.password)
    return when (server.engine) {
        Engine.POSTGRESQL -> "postgresql://postgres:$pw@$host:${server.port}/postgres"
        Engine.MARIADB -> "mysql://root:$pw@$host:${server.port}/"
        Engine.REDIS, Engine.VALKEY -> "redis://:$pw@$host:${server.port}/0"
    }
}

/** The engine versions on the phone, their size, and which servers use them; unused ones can be removed. */
@Composable
private fun InstalledVersionsDialog(servers: List<LocalServer>, onDismiss: () -> Unit) {
    val t = bd
    val context = LocalContext.current
    val host = remember { LocalHost.get(context) }
    val installs by host.installs.collectAsState()
    BdDialog("Installed Versions", onDismiss, confirmLabel = "Done", onConfirm = onDismiss, dismissLabel = null) {
        if (installs.isEmpty()) {
            Text("Nothing is installed yet. A version is downloaded when a server needs it.", color = t.textDim)
        } else {
            LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(installs, key = { it.id }) { install -> InstalledRow(install, servers.filter { it.install == install.id }, host) }
            }
        }
    }
}

@Composable
private fun InstalledRow(install: Installation, users: List<LocalServer>, host: LocalHost) {
    val t = bd
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        DriverLogo(LocalServers.driverOf(install.engine), 22.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("${install.engine.label} ${install.version}", color = t.text)
            Text(
                formatBytes(install.bytes) + " · " + if (users.isEmpty()) "not used" else "used by " + users.joinToString { it.name },
                color = t.textDim, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        if (users.isEmpty()) IconButton(onClick = { host.uninstall(install) }) { Icon(Icons.Outlined.Delete, "Remove", tint = t.danger) }
    }
}

/** Asks for the notification permission (Android 13+) the first time a server starts, so its notification shows. */
@Composable
fun rememberNotificationRequest(): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    return remember(context) {
        {
            if (Build.VERSION.SDK_INT >= 33 && !notificationsAllowed(context)) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

private fun notificationsAllowed(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

/** "21.7 MB", "512 kB". */
fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1e9)
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1e6)
    bytes >= 1_000 -> "${bytes / 1000} kB"
    else -> "$bytes B"
}
