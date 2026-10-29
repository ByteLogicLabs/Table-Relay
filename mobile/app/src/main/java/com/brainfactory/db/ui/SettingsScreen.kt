package com.brainfactory.db.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.data.Settings
import com.brainfactory.db.update.UpdatesDialog
import com.brainfactory.db.update.Updater

/** Settings: appearance, the grid, the query editor, account and updates, about. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: Navigator) {
    val t = bd
    val context = LocalContext.current
    val s = remember { Settings.get(context) }
    var updates by remember { mutableStateOf(false) }
    var about by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = t.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = t.text) } },
                title = { Text("Settings") },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                BdSectionHeader("Appearance")
                SettingRow("Theme") {
                    BdSegmented(ThemeMode.entries.toList(), s.theme, s::updateTheme, { it.name.lowercase().replaceFirstChar(Char::uppercase) })
                }

                BdSectionHeader("Data grid")
                SettingRow("Rows per page") { BdSelect(Settings.PAGE_SIZES, s.pageSize, s::updatePageSize, { it.toString() }, Modifier.width(110.dp)) }
                SettingRow("NULL shows as") { BdSelect(Settings.NULL_TEXTS, s.nullText, s::updateNullText, { if (it.isEmpty()) "(blank)" else it }, Modifier.width(110.dp)) }
                SettingRow("Text size") { BdSelect(listOf(11, 12, 13, 14, 15, 16), s.gridFontSize, s::updateGridFontSize, { "$it" }, Modifier.width(110.dp)) }

                BdSectionHeader("Query editor")
                BdSwitchRow("Confirm destructive queries", s.confirmDestructive, s::updateConfirmDestructive, description = "Ask before DELETE or UPDATE without WHERE, DROP, TRUNCATE, Mongo drops and Redis FLUSH.")
                BdSwitchRow("Symbol keys", s.symbolBar, s::updateSymbolBar, description = "Show ( ) , ; ' * = and other keys above the keyboard.")
                SettingRow("Font size") { BdSelect(listOf(12, 13, 14, 15, 16, 18, 20), s.editorFontSize, s::updateEditorFontSize, { "$it" }, Modifier.width(110.dp)) }
                SettingRow("Result rows", "A query keeps at most this many rows.") { BdSelect(Settings.RESULT_CAPS, s.maxResultRows, s::updateMaxResultRows, { formatCount(it.toLong()) }, Modifier.width(110.dp)) }

                BdSectionHeader("Account & updates")
                val updater = Updater.get(context)
                BdListRow("Check for Updates", subtitle = "Installed version ${updater.currentVersion}" + (updater.licence?.let { " · signed in as ${it.email}" } ?: ""), icon = Icons.Outlined.SystemUpdate, onClick = { updates = true })

                BdSectionHeader("About")
                BdListRow("About Brain DB", subtitle = "Licences and credits", icon = Icons.Outlined.Info, onClick = { about = true })
            }
        }
    }
    if (updates) UpdatesDialog { updates = false }
    if (about) BdDialog("Brain DB", { about = false }, confirmLabel = "OK", onConfirm = { about = false }, dismissLabel = null) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Version ${Updater.get(context).currentVersion} · by Brain Factory", color = t.text)
            Text("A database workbench for MySQL, MariaDB, PostgreSQL, SQLite, MongoDB and Redis, built on Table Relay (Apache-2.0), that can also run PostgreSQL, MariaDB, Redis and Valkey servers on the phone.", color = t.textDim, fontSize = 13.sp)
            Text(
                "Open-source parts: MariaDB Connector/J (LGPL-2.1), PostgreSQL JDBC (BSD-2-Clause), MongoDB Java Driver (Apache-2.0), " +
                    "JSch by mwiede (BSD), Bouncy Castle (MIT), XZ for Java (0BSD), AndroidSVG (Apache-2.0), Jetpack Compose (Apache-2.0). " +
                    "Driver logos are their owners' trademarks.",
                color = t.textFaint, fontSize = 12.sp,
            )
            Text(
                "Local servers aren't part of the app: they are downloaded from Termux's package repository when added, " +
                    "each under its own licence (PostgreSQL Licence; MariaDB, GPL-2.0; Redis, RSALv2/SSPLv1/AGPLv3; Valkey, BSD-3-Clause).",
                color = t.textFaint, fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun SettingRow(title: String, description: String? = null, control: @Composable () -> Unit) {
    val t = bd
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = t.text, fontSize = 15.sp)
            if (description != null) Text(description, color = t.textDim, fontSize = 12.sp)
        }
        control()
    }
}
