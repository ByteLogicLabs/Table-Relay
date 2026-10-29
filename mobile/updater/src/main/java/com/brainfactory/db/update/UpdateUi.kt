package com.brainfactory.db.update

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.ui.BdButton
import com.brainfactory.db.ui.BdDialog
import com.brainfactory.db.ui.BdDivider
import com.brainfactory.db.ui.bd
import kotlinx.coroutines.launch

/** Checks the version manifest (version.rc) for a newer version in the background, at most every few hours. */
suspend fun checkForUpdates(context: Context) = Updater.get(context).check(force = false)

/** Help › Check for Updates: a manual check, the update itself, and who is signed in. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UpdatesDialog(onDismiss: () -> Unit) {
    val updater = Updater.get(LocalContext.current)
    val t = bd
    val scope = rememberCoroutineScope()
    val state = updater.state
    val busy = state is Updater.State.Checking || state is Updater.State.Downloading || state is Updater.State.Installing
    BdDialog("Updates & Account", onDismiss, confirmLabel = null, dismissLabel = "Close") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("UPDATES", color = t.textFaint, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            Text("Installed version: ${updater.currentVersion}", color = t.text, fontSize = 14.sp)
            val status = when (state) {
                Updater.State.Checking -> "Checking for updates…"
                Updater.State.UpToDate -> "Brain DB is up to date."
                is Updater.State.Available -> "Brain DB ${state.update.version} is available."
                is Updater.State.Downloading -> "Downloading ${state.update.version}… ${(state.progress * 100).toInt()}%"
                Updater.State.Installing -> "Installing… confirm the installation when Android asks."
                is Updater.State.Failed -> state.message
                Updater.State.Idle -> ""
            }
            if (status.isNotEmpty()) Text(status, color = t.textDim, fontSize = 13.sp)
            (state as? Updater.State.Available)?.update?.notes?.takeIf { it.isNotBlank() }?.let {
                Text(it, color = t.textFaint, fontSize = 12.sp, maxLines = 12)
            }
            if (state is Updater.State.Downloading) {
                LinearProgressIndicator(
                    progress = { state.progress },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).height(3.dp),
                    color = t.accent,
                    trackColor = t.field,
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                BdButton("Check for Updates", { scope.launch { updater.check(force = true) } }, enabled = !busy)
                if (state is Updater.State.Failed || state is Updater.State.Available) {
                    BdButton("Download", { updater.openDownload((state as? Updater.State.Available)?.update ?: (state as? Updater.State.Failed)?.update) })
                }
                if (state is Updater.State.Available) BdButton("Update Now", { updater.install(state.update) }, primary = true)
            }
            updater.licence?.let { licence ->
                Spacer(Modifier.height(6.dp))
                Text("ACCOUNT", color = t.textFaint, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Signed in as ${licence.email}", color = t.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    BdButton("Sign Out", { onDismiss(); updater.signOut() })
                }
            }
        }
    }
}

/**
 * A bar at the top while a newer version is ready, downloading or installing, or when an update didn't install;
 * nothing otherwise. Nothing is downloaded until the user taps Update Now, and Later hides it until the next start.
 */
@Composable
fun UpdateBanner() {
    val updater = Updater.get(LocalContext.current)
    val state = updater.state
    val (title, message) = when (state) {
        is Updater.State.Available -> "Update available: Brain DB ${state.update.version}" to "A newer version is ready to install."
        is Updater.State.Downloading -> "Update available: Brain DB ${state.update.version}" to "Downloading… ${(state.progress * 100).toInt()}%"
        Updater.State.Installing -> "Installing the update" to "Confirm the installation when Android asks."
        is Updater.State.Failed -> if (state.update != null) "Update not installed" to state.message else return
        else -> return
    }
    val t = bd
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().background(t.chrome).padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Info, null, tint = t.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, color = t.text, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Text(message, color = t.textDim, fontSize = 12.sp, maxLines = 2)
                if (state is Updater.State.Downloading) {
                    LinearProgressIndicator(
                        progress = { state.progress },
                        modifier = Modifier.padding(top = 3.dp).fillMaxWidth().height(3.dp),
                        color = t.accent,
                        trackColor = t.field,
                    )
                }
            }
            val update = (state as? Updater.State.Available)?.update ?: (state as? Updater.State.Failed)?.update
            if (update != null) {
                Spacer(Modifier.width(8.dp))
                BdButton("Later", updater::dismiss)
                Spacer(Modifier.width(6.dp))
                BdButton(if (state is Updater.State.Failed) "Try Again" else "Update Now", { updater.install(update) }, primary = true)
            }
        }
        BdDivider()
    }
}
