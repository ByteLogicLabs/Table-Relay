package com.brainfactory.db

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import com.brainfactory.db.data.Settings
import com.brainfactory.db.server.LocalServers
import com.brainfactory.db.ui.AppRoot
import com.brainfactory.db.ui.BrainDbTheme
import com.brainfactory.db.ui.ThemeMode
import com.brainfactory.db.ui.bd
import com.brainfactory.db.update.LicenceGate
import com.brainfactory.db.update.checkForUpdates

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        val settings = Settings.get(this)
        setContent {
            val dark = when (settings.theme) {
                ThemeMode.SYSTEM -> isSystemInDarkTheme()
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
            }
            // The status and navigation bar icons follow the app's theme, which may differ from the system's.
            DisposableEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
                onDispose {}
            }
            BrainDbTheme(settings.theme) {
                Box(Modifier.fillMaxSize().background(bd.background)) {
                    LicenceGate {
                        LaunchedEffect(Unit) { checkForUpdates(this@MainActivity) }
                        AppRoot()
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** The local servers notification opens the server list. */
    private fun handle(intent: Intent?) {
        if (intent?.getStringExtra(EXTRA_OPEN) == OPEN_SERVERS) LocalServers.pendingScreen.value = OPEN_SERVERS
    }

    companion object {
        const val EXTRA_OPEN = "open"
        const val OPEN_SERVERS = "servers"
    }
}
