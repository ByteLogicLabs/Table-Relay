package com.brainfactory.db.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.brainfactory.db.MainActivity
import com.brainfactory.db.data.ProfileStore
import com.brainfactory.db.server.LocalServers
import com.brainfactory.db.workspace.Workspaces

/** Where the app is: the connection list, a connection's settings, a connected workspace, Settings, or the local servers. */
sealed interface Screen {
    data object Home : Screen
    /** [profileId] null makes a new connection; [duplicateOf] starts it as a copy. */
    data class EditConnection(val profileId: String?, val duplicateOf: String? = null) : Screen
    data class Workspace(val profileId: String) : Screen
    data object Settings : Screen
    data object Servers : Screen
    /** [serverId] null sets up a new server. */
    data class EditServer(val serverId: String?) : Screen
    data class ServerLog(val serverId: String) : Screen
}

/** A small back stack; Android's back gesture pops it. */
class Navigator {
    val stack = mutableStateListOf<Screen>(Screen.Home)
    val current: Screen get() = stack.last()
    fun push(screen: Screen) { stack += screen }
    fun pop() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    /** Replaces the top screen, e.g. a saved new connection opening its workspace. */
    fun replace(screen: Screen) { stack[stack.lastIndex] = screen }
}

@Composable
fun AppRoot() {
    val nav = remember { Navigator() }
    val context = LocalContext.current
    val store = remember { ProfileStore.get(context) }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val pending = LocalServers.pendingScreen.value
    LaunchedEffect(pending) {
        if (pending == MainActivity.OPEN_SERVERS) {
            LocalServers.pendingScreen.value = null
            if (nav.current != Screen.Servers) nav.push(Screen.Servers)
        }
    }
    when (val screen = nav.current) {
        Screen.Home -> HomeScreen(nav)
        is Screen.EditConnection -> ConnectionEditor(nav, screen.profileId, screen.duplicateOf)
        is Screen.Workspace -> {
            val ws = Workspaces.get(screen.profileId) ?: store.get(screen.profileId)?.let { Workspaces.open(context, it) }
            if (ws == null) nav.pop() else WorkspaceScreen(nav, ws)
        }
        Screen.Settings -> SettingsScreen(nav)
        Screen.Servers -> ServersScreen(nav)
        is Screen.EditServer -> ServerEditor(nav, screen.serverId)
        is Screen.ServerLog -> ServerLogScreen(nav, screen.serverId)
    }
}
