package com.brainfactory.db.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.host.LocalHost
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** A local server's log (what it writes, and Brain DB's start and setup lines), following it as it grows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerLogScreen(nav: Navigator, serverId: String) {
    val t = bd
    val context = LocalContext.current
    val server = remember(serverId) { ServerStore.get(context).get(serverId) }
    val file = remember(serverId) { LocalHost.get(context).log(serverId) }
    var text by remember { mutableStateOf("") }
    val vertical = rememberScrollState()
    LaunchedEffect(file) {
        while (true) {
            val fresh = withContext(Dispatchers.IO) { tail(file) }
            if (fresh != text) {
                val atEnd = vertical.value >= vertical.maxValue - 8
                text = fresh
                if (atEnd) {
                    delay(50)
                    vertical.scrollTo(vertical.maxValue)
                }
            }
            delay(1500)
        }
    }
    Scaffold(
        containerColor = t.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = t.chrome, titleContentColor = t.text),
                navigationIcon = { IconButton(onClick = { nav.pop() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = t.text) } },
                title = { Text("Log · ${server?.name.orEmpty()}") },
                actions = { IconButton(onClick = { copyToClipboard(context, text, "Server log") }) { Icon(Icons.Outlined.ContentCopy, "Copy", tint = t.text) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            SelectionContainer {
                Text(
                    text.ifEmpty { "Nothing logged yet." },
                    style = monoStyle(12), color = if (text.isEmpty()) t.textFaint else t.text,
                    modifier = Modifier.fillMaxSize().verticalScroll(vertical).horizontalScroll(rememberScrollState()).padding(12.dp),
                )
            }
        }
    }
}

/** The last [bytes] of [file], from a line start. */
private fun tail(file: File, bytes: Long = 96_000): String {
    if (!file.exists()) return ""
    RandomAccessFile(file, "r").use { f ->
        val start = maxOf(0L, f.length() - bytes)
        f.seek(start)
        val data = ByteArray((f.length() - start).toInt())
        f.readFully(data)
        val text = String(data, Charsets.UTF_8)
        return if (start > 0) text.substringAfter('\n') else text
    }
}
