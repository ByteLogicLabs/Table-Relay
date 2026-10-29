package com.brainfactory.db.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.NoteAdd
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
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.ProfileStore
import com.brainfactory.db.engine.ConnectionProfile
import com.brainfactory.db.engine.Driver
import com.brainfactory.db.engine.EngineEnv
import com.brainfactory.db.engine.SshAuth
import com.brainfactory.db.engine.SshConfig
import com.brainfactory.db.engine.SslMode
import com.brainfactory.db.engine.openSession
import com.brainfactory.db.engine.parseConnectionUrl
import com.brainfactory.db.workspace.Workspaces
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Table Relay's tag colours, for the connection's colour. */
private val TAG_COLORS = listOf(null, 0xFFEF4444, 0xFFF59E0B, 0xFF22C55E, 0xFF3B82F6, 0xFF8B5CF6, 0xFFEC4899, 0xFF14B8A6)

/** A connection's settings: driver, server, SSH tunnel, and a test before saving. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ConnectionEditor(nav: Navigator, profileId: String?, duplicateOf: String?) {
    val t = bd
    val context = LocalContext.current
    val store = remember { ProfileStore.get(context) }
    val original = remember { profileId?.let { store.get(it) } }
    val start = remember {
        original ?: duplicateOf?.let { id -> store.get(id)?.let { it.copy(id = ConnectionProfile().id, name = it.name + " copy", favorite = false) } } ?: ConnectionProfile()
    }
    var p by remember { mutableStateOf(start) }
    var portText by remember { mutableStateOf(if (start.driver.networked) start.port.toString() else "") }
    var sshPortText by remember { mutableStateOf((start.ssh?.port ?: 22).toString()) }
    var useSsh by remember { mutableStateOf(start.ssh != null) }
    var ssh by remember { mutableStateOf(start.ssh ?: SshConfig()) }
    var url by remember { mutableStateOf("") }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    var newDbName by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun built(): ConnectionProfile = p.copy(
        port = portText.toIntOrNull() ?: p.driver.defaultPort,
        ssh = if (useSsh && p.driver.networked) ssh.copy(port = sshPortText.toIntOrNull() ?: 22) else null,
        name = p.name.trim(),
        host = p.host.trim(),
    )

    fun setDriver(d: Driver) {
        if (d == p.driver) return
        if (portText.isBlank() || portText.toIntOrNull() == p.driver.defaultPort) portText = if (d.networked) d.defaultPort.toString() else ""
        val ssl = if (d == Driver.MONGO || d == Driver.REDIS) (if (p.sslMode == SslMode.PREFERRED) SslMode.DISABLE else p.sslMode) else p.sslMode
        p = p.copy(driver = d, database = if (d == Driver.SQLITE || p.driver == Driver.SQLITE) "" else p.database, sslMode = ssl, user = if (p.user.isBlank()) defaultUser(d) else p.user)
        testResult = null
    }

    val sqliteOpener = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { importSqliteFile(context, uri) } }
                .onSuccess { path -> p = p.copy(database = path, name = p.name.ifBlank { File(path).nameWithoutExtension }) }
                .onFailure { problem = "The file couldn't be copied: ${it.message}" }
        }
    }
    val keyOpener = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { it.readBytes().decodeToString() } } }
                .onSuccess { ssh = ssh.copy(privateKey = it.trim(), auth = SshAuth.KEY) }
                .onFailure { problem = "The key file couldn't be read: ${it.message}" }
        }
    }

    fun save() {
        val profile = built()
        val missing = when {
            profile.driver == Driver.SQLITE && profile.database.isBlank() -> "Open or create a SQLite database file."
            profile.driver.networked && profile.host.isBlank() -> "Enter the host."
            profile.ssh?.host?.isBlank() == true -> "Enter the SSH host, or turn the SSH tunnel off."
            else -> null
        }
        if (missing != null) { problem = missing; return }
        store.save(profile.copy(name = profile.name.ifBlank { profile.summary }))
        // An open workspace on the old settings starts over next time it's opened.
        if (original != null && original != profile) Workspaces.close(profile.id)
        nav.pop()
    }

    Scaffold(
        containerColor = t.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = t.text) } },
                title = { Text(if (original == null) "New Connection" else "Edit Connection") },
                actions = { TextButton(onClick = ::save) { Text("Save", color = t.accent, fontWeight = FontWeight.SemiBold) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Driver
                BdLabel("Database")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Driver.entries.forEach { d ->
                        val on = d == p.driver
                        Row(Modifier.background(if (on) t.selection else t.field, SmallRadius).padding(1.dp)) {
                            TextButton(onClick = { setDriver(d) }) {
                                DriverLogo(d, 18.dp)
                                Spacer(Modifier.width(6.dp))
                                Text(d.label, color = if (on) t.text else t.textDim, fontSize = 13.sp)
                            }
                        }
                    }
                }

                if (p.driver.networked) {
                    BdTextField(
                        url, { url = it }, label = "Connection URL (optional)", placeholder = urlPlaceholder(p.driver), keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Done, mono = true,
                        onAction = {
                            parseConnectionUrl(url)?.let { parsed ->
                                setDriver(parsed.driver)
                                p = parsed.copy(id = p.id, name = p.name, color = p.color, favorite = p.favorite, readOnly = p.readOnly, ssh = p.ssh)
                                portText = if (parsed.driver.networked) parsed.port.toString() else ""
                                url = ""
                            } ?: run { problem = "That isn't a mysql://, postgres://, mongodb://, mongodb+srv:// or redis:// URL." }
                        },
                        help = "Paste a URL and press Done to fill in the fields below.",
                    )
                }

                BdTextField(p.name, { p = p.copy(name = it) }, label = "Name", placeholder = "e.g. Production orders")

                BdLabel("Colour")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TAG_COLORS.forEach { c -> ColorDot(c?.let { Color(it) }, p.color == c, onClick = { p = p.copy(color = c) }) }
                }

                if (p.driver == Driver.SQLITE) {
                    BdLabel("Database file")
                    Text(
                        if (p.database.isBlank()) "No file chosen" else p.database,
                        color = if (p.database.isBlank()) t.textFaint else t.text, style = monoStyle(13),
                        modifier = Modifier.fillMaxWidth().background(t.field, SmallRadius).padding(10.dp),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BdButton("Open File…", { sqliteOpener.launch(arrayOf("*/*")) }, icon = Icons.Outlined.FolderOpen)
                        BdButton("New Database…", { newDbName = "" }, icon = Icons.Outlined.NoteAdd)
                    }
                    Text(
                        "An opened file is copied into Brain DB's storage, so it can be read and written; use Export Database File in the workspace menu to save it back.",
                        color = t.textFaint, fontSize = 12.sp,
                    )
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        BdTextField(
                            p.host, { p = p.copy(host = it) }, Modifier.weight(1f), label = if (p.driver == Driver.MONGO) "Host or connection string" else "Host",
                            placeholder = if (p.driver == Driver.MONGO) "localhost or mongodb+srv://…" else "localhost", keyboardType = KeyboardType.Uri,
                        )
                        if (!p.usesUri) BdTextField(portText, { portText = it.filter(Char::isDigit).take(5) }, Modifier.width(96.dp), label = "Port", keyboardType = KeyboardType.Number)
                    }
                    if (!p.usesUri) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            BdTextField(p.user, { p = p.copy(user = it) }, Modifier.weight(1f), label = "User", placeholder = defaultUser(p.driver))
                            BdTextField(p.password, { p = p.copy(password = it) }, Modifier.weight(1f), label = "Password", password = true)
                        }
                    }
                    BdTextField(
                        p.database, { p = p.copy(database = it) },
                        label = when (p.driver) {
                            Driver.REDIS -> "Database number"
                            Driver.POSTGRES -> "Database"
                            else -> "Database (optional)"
                        },
                        placeholder = when (p.driver) {
                            Driver.REDIS -> "0"
                            Driver.POSTGRES -> "postgres"
                            Driver.MONGO -> "from the connection string, or the first one"
                            else -> "Default schema"
                        },
                        keyboardType = if (p.driver == Driver.REDIS) KeyboardType.Number else KeyboardType.Text,
                    )
                    if (!p.usesUri) {
                        val modes = if (p.driver == Driver.MONGO || p.driver == Driver.REDIS) listOf(SslMode.DISABLE, SslMode.REQUIRED, SslMode.VERIFY_CA) else SslMode.entries
                        BdSelect(modes, p.sslMode.takeIf { it in modes } ?: modes.first(), { p = p.copy(sslMode = it) }, { sslLabel(it, p.driver) }, title = "SSL / TLS")
                    }

                    // SSH tunnel
                    BdSwitchRow("Connect through SSH", useSsh, { useSsh = it }, inset = 0.dp, description = "Reach a database behind a jump host.")
                    if (useSsh) {
                        Column(Modifier.background(t.panel, CardRadius).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                BdTextField(ssh.host, { ssh = ssh.copy(host = it) }, Modifier.weight(1f), label = "SSH host", keyboardType = KeyboardType.Uri)
                                BdTextField(sshPortText, { sshPortText = it.filter(Char::isDigit).take(5) }, Modifier.width(96.dp), label = "Port", keyboardType = KeyboardType.Number)
                            }
                            BdTextField(ssh.user, { ssh = ssh.copy(user = it) }, label = "SSH user", placeholder = "root")
                            BdSegmented(listOf(SshAuth.PASSWORD, SshAuth.KEY), ssh.auth, { ssh = ssh.copy(auth = it) }, { if (it == SshAuth.KEY) "Private key" else "Password" })
                            if (ssh.auth == SshAuth.PASSWORD) {
                                BdTextField(ssh.password, { ssh = ssh.copy(password = it) }, label = "SSH password", password = true)
                            } else {
                                BdTextField(ssh.privateKey, { ssh = ssh.copy(privateKey = it) }, label = "Private key", placeholder = "-----BEGIN OPENSSH PRIVATE KEY-----", singleLine = false, minLines = 4, mono = true)
                                BdButton("Load Key File…", { keyOpener.launch(arrayOf("*/*")) }, icon = Icons.Outlined.FolderOpen)
                                BdTextField(ssh.passphrase, { ssh = ssh.copy(passphrase = it) }, label = "Key passphrase (optional)", password = true)
                            }
                            if (original?.ssh != null) {
                                TextButton(onClick = {
                                    EngineEnv(context.filesDir).knownHosts.forget("${ssh.host.trim()}:${sshPortText.toIntOrNull() ?: 22}")
                                    testResult = true to "The pinned host key of ${ssh.host} was forgotten; the next connection trusts the key it sees."
                                }) { Text("Forget host key", color = t.accent) }
                            }
                        }
                    }
                }

                BdSwitchRow("Read-only", p.readOnly, { p = p.copy(readOnly = it) }, inset = 0.dp, description = "Only reading statements run; the grid can't edit.")
                BdSwitchRow("Favourite", p.favorite, { p = p.copy(favorite = it) }, inset = 0.dp)

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    BdButton(if (testing) "Testing…" else "Test Connection", {
                        testing = true
                        testResult = null
                        val profile = built()
                        scope.launch {
                            testResult = withContext(Dispatchers.IO) {
                                runCatching {
                                    openSession(profile, EngineEnv(context.filesDir)).use { s ->
                                        val dbs = runCatching { s.databases().size }.getOrNull()
                                        "Connected to ${profile.driver.label}" + (s.currentDatabase?.let { " · $it" } ?: "") + (dbs?.let { " · $it database${if (it == 1) "" else "s"}" } ?: "")
                                    }
                                }.fold({ true to it }, { false to (it.message ?: it.javaClass.simpleName) })
                            }
                            testing = false
                        }
                    }, enabled = !testing)
                    if (testing) CircularProgressIndicator(Modifier.size(18.dp), color = t.accent, strokeWidth = 2.dp)
                    BdButton("Save", ::save, primary = true)
                }
                testResult?.let { (ok, text) ->
                    Row(Modifier.fillMaxWidth().background((if (ok) t.success else t.danger).copy(alpha = 0.12f), SmallRadius).padding(10.dp)) {
                        Icon(if (ok) Icons.Filled.CheckCircle else Icons.Filled.Error, null, tint = if (ok) t.success else t.danger, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(text, color = t.text, fontSize = 13.sp)
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }

    newDbName?.let { name ->
        BdDialog("New SQLite Database", { newDbName = null }, confirmLabel = "Create", confirmEnabled = name.isNotBlank(), onConfirm = {
            val file = File(sqliteDir(context), name.trim().let { if (it.contains('.')) it else "$it.db" })
            if (file.exists()) { problem = "A database named ${file.name} already exists."; return@BdDialog }
            runCatching { android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(file, null).close() }
                .onSuccess { p = p.copy(database = file.path, name = p.name.ifBlank { file.nameWithoutExtension }); newDbName = null }
                .onFailure { problem = it.message }
        }) {
            BdTextField(name, { newDbName = it }, label = "File name", placeholder = "notes.db", imeAction = ImeAction.Done)
        }
    }
    problem?.let { m -> BdDialog("Connection", { problem = null }, confirmLabel = "OK", onConfirm = { problem = null }, dismissLabel = null) { Text(m) } }
}

private fun defaultUser(d: Driver) = when (d) {
    Driver.MYSQL -> "root"
    Driver.POSTGRES -> "postgres"
    else -> ""
}

private fun urlPlaceholder(d: Driver) = when (d) {
    Driver.MYSQL -> "mysql://user:pass@host:3306/db"
    Driver.POSTGRES -> "postgres://user:pass@host:5432/db"
    Driver.MONGO -> "mongodb+srv://user:pass@cluster/db"
    Driver.REDIS -> "redis://:pass@host:6379/0"
    Driver.SQLITE -> ""
}

private fun sslLabel(mode: SslMode, driver: Driver) = when (mode) {
    SslMode.DISABLE -> "Off"
    SslMode.PREFERRED -> "Preferred (TLS when the server offers it)"
    SslMode.REQUIRED -> if (driver == Driver.MONGO || driver == Driver.REDIS) "TLS" else "Required (encrypted, certificate not checked)"
    SslMode.VERIFY_CA -> "Verify certificate"
}

/** Where SQLite files opened or created in the app live. */
fun sqliteDir(context: android.content.Context) = File(context.filesDir, "sqlite").apply { mkdirs() }

/** Copies a picked SQLite file into the app's storage (a content URI can't be opened by SQLite); returns its path. */
private fun importSqliteFile(context: android.content.Context, uri: Uri): String {
    val name = context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: "database.db"
    var target = File(sqliteDir(context), name)
    var n = 2
    while (target.exists()) target = File(sqliteDir(context), name.substringBeforeLast('.') + " ($n)." + name.substringAfterLast('.', "db")).also { n++ }
    context.contentResolver.openInputStream(uri)!!.use { input -> target.outputStream().use { input.copyTo(it) } }
    val header = target.inputStream().use { s -> ByteArray(16).also { s.read(it) } }
    if (!String(header, Charsets.ISO_8859_1).startsWith("SQLite format 3")) {
        target.delete()
        throw IllegalArgumentException("It isn't a SQLite database file.")
    }
    return target.path
}
