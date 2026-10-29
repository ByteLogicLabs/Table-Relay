package com.brainfactory.db.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.host.Engine
import com.brainfactory.db.host.EngineRelease
import com.brainfactory.db.host.Installation
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.LocalServer
import com.brainfactory.db.host.compareDebVersions
import com.brainfactory.db.server.LocalServers

/** A version a new server can run: installed already, offered by the repository, or both. */
private data class VersionChoice(val installId: String, val debVersion: String, val installed: Installation?, val release: EngineRelease?) {
    val version: String get() = LocalHost.versionOf(installId)
    val label: String get() = version + if (installed != null) " · installed" else release?.let { " · ${formatBytes(it.downloadSize)} download" }.orEmpty()
}

/**
 * Sets up a new local server (engine, version, port, password, network) or edits one's name, port and network. The
 * engine and version of an existing server stay: its data directory belongs to that version.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerEditor(nav: Navigator, serverId: String?) {
    val t = bd
    val context = LocalContext.current
    val store = remember { ServerStore.get(context) }
    val host = remember { LocalHost.get(context) }
    val original = remember(serverId) { serverId?.let { store.get(it) } }
    val installs by host.installs.collectAsState()
    val askNotifications = rememberNotificationRequest()

    var engine by remember { mutableStateOf(original?.engine ?: Engine.POSTGRESQL) }
    var releases by remember { mutableStateOf<List<EngineRelease>?>(null) }
    var releaseError by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var chosen by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf(original?.name.orEmpty()) }
    var portText by remember { mutableStateOf((original?.port ?: LocalServers.freePort(context, Engine.POSTGRESQL)).toString()) }
    var portEdited by remember { mutableStateOf(original != null) }
    var password by remember { mutableStateOf(original?.password ?: LocalServers.newPassword()) }
    var lan by remember { mutableStateOf(original?.lan ?: false) }
    var withConnection by remember { mutableStateOf(true) }
    var problem by remember { mutableStateOf<String?>(null) }

    if (original == null && serverId != null) {
        LaunchedEffect(Unit) { nav.pop() }
        return
    }
    if (original == null) {
        LaunchedEffect(attempt) {
            releaseError = null
            runCatching { host.releases(refresh = attempt > 0) }
                .onSuccess { releases = it }
                .onFailure { releaseError = LocalHost.describe(it) }
        }
    }

    val choices = remember(engine, installs, releases) {
        val byId = LinkedHashMap<String, VersionChoice>()
        releases.orEmpty().filter { it.engine == engine }.forEach { byId[it.installId] = VersionChoice(it.installId, it.debVersion, null, it) }
        installs.filter { it.engine == engine }.forEach { i -> byId[i.id] = VersionChoice(i.id, i.debVersion, i, byId[i.id]?.release) }
        byId.values.sortedWith { a, b -> compareDebVersions(b.debVersion, a.debVersion) }
    }
    val choice = choices.firstOrNull { it.installId == chosen } ?: choices.firstOrNull()

    fun pickEngine(e: Engine) {
        engine = e
        chosen = null
        if (!portEdited) portText = LocalServers.freePort(context, e).toString()
    }

    fun save() {
        val port = portText.toIntOrNull()
        val clash = store.servers.firstOrNull { it.port == port && it.id != original?.id }
        problem = when {
            port == null || port !in 1024..65535 -> "Use a port from 1024 to 65535."
            clash != null -> "Port $port is ${clash.name}'s."
            original == null && choice == null -> releaseError ?: "Pick a version."
            original == null -> LocalServer.passwordProblem(password)
            else -> null
        }
        if (problem != null || port == null) return
        if (original != null) {
            LocalServers.update(context, original.copy(name = name.ifBlank { original.name }, port = port, lan = lan))
        } else {
            val v = choice ?: return
            askNotifications()
            val server = LocalServer(name = name.ifBlank { engine.label }, engine = engine, install = v.installId, port = port, password = password, lan = lan)
            LocalServers.create(context, server, v.release, withConnection)
        }
        nav.pop()
    }

    Scaffold(
        containerColor = t.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = t.text) } },
                title = { Text(if (original == null) "New Server" else "Server Settings") },
                actions = { TextButton(onClick = ::save) { Text(if (original == null) "Create" else "Save", color = t.accent, fontWeight = FontWeight.SemiBold) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (original == null) {
                    BdLabel("Engine")
                    Engine.entries.forEach { e ->
                        val newest = releases?.filter { it.engine == e }?.maxWithOrNull { a, b -> compareDebVersions(a.debVersion, b.debVersion) }
                        val installed = installs.filter { it.engine == e }
                        EngineOption(
                            e, selected = e == engine,
                            detail = when {
                                newest != null -> "${newest.version} · ${formatBytes(newest.downloadSize)} download" + if (installed.any { it.id == newest.installId }) " · installed" else ""
                                installed.isNotEmpty() -> installed.joinToString { it.version } + " · installed"
                                releases == null && releaseError == null -> "Checking the package repository…"
                                else -> "Not available"
                            },
                            onClick = { pickEngine(e) },
                        )
                    }
                    releaseError?.let { error ->
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(error, color = t.danger, fontSize = 13.sp)
                            BdButton("Try Again", { attempt++ })
                        }
                    }
                    if (choices.size > 1) {
                        BdSelect(choices, choice ?: choices.first(), { chosen = it.installId }, { it.label }, title = "Version")
                    } else if (releases == null && releaseError == null && choices.isEmpty()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(16.dp), color = t.accent, strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("Checking the package repository…", color = t.textDim, fontSize = 13.sp)
                        }
                    }
                } else {
                    BdLabel("Engine")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        DriverLogo(LocalServers.driverOf(original.engine), 22.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("${original.engine.label} ${LocalHost.versionOf(original.install)}", color = t.text)
                    }
                    Text("A server keeps its version: its data directory belongs to it.", color = t.textFaint, fontSize = 12.sp)
                }

                BdTextField(name, { name = it }, label = "Name", placeholder = original?.name ?: engine.label)

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    BdTextField(
                        portText, { portText = it.filter(Char::isDigit).take(5); portEdited = true }, Modifier.width(110.dp),
                        label = "Port", keyboardType = KeyboardType.Number,
                    )
                    BdTextField(
                        (original?.engine ?: engine).user ?: "(password only)", {}, Modifier.weight(1f),
                        label = "User", enabled = false,
                    )
                }
                if (original == null) {
                    BdTextField(
                        password, { password = it }, label = "Password", password = true,
                        help = "Generated for you; it is saved with the server and its connection.",
                    )
                }

                BdSwitchRow(
                    "Reachable from other devices", lan, { lan = it }, inset = 0.dp,
                    description = "Listens on the phone's Wi-Fi and Ethernet too, so a laptop on the same network can connect (with the password). " +
                        "Keeps the phone awake while it runs. Off: only apps on this phone can.",
                )
                if (original == null) {
                    BdSwitchRow("Add to Connections", withConnection, { withConnection = it }, inset = 0.dp, description = "Opening the connection starts the server when it isn't running.")
                    val download = choice?.takeIf { it.installed == null && it.release != null }
                    Text(
                        if (download != null) {
                            "${engine.label} ${download.version} is downloaded (${formatBytes(download.release!!.downloadSize)}) from Termux's package repository and checked against " +
                                "the repository's signature, then set up on its first start."
                        } else {
                            "It is set up on its first start."
                        },
                        color = t.textFaint, fontSize = 12.sp,
                    )
                }
                problem?.let { Text(it, color = t.danger, fontSize = 13.sp) }
            }
        }
    }
}

@Composable
private fun EngineOption(engine: Engine, selected: Boolean, detail: String, onClick: () -> Unit) {
    val t = bd
    Row(
        Modifier
            .fillMaxWidth()
            .clip(CardRadius)
            .background(if (selected) t.selection else t.panel)
            .border(1.dp, if (selected) t.accent else t.border, CardRadius)
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(t.field), contentAlignment = Alignment.Center) {
            DriverLogo(LocalServers.driverOf(engine), 24.dp)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(engine.label, color = t.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(engine.about, color = t.textDim, fontSize = 12.sp)
            Text(detail, color = t.textFaint, fontSize = 12.sp)
        }
    }
}
