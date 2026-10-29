package com.brainfactory.db.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.brainfactory.db.MainActivity
import com.brainfactory.db.R
import com.brainfactory.db.data.ServerStore
import com.brainfactory.db.host.LocalHost
import com.brainfactory.db.host.ServerState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps Brain DB's process in the foreground-service state while a local server installs, starts or runs (as Brain
 * Code's EngineService does for its engine). The servers are the app's child processes: without it Android would stop
 * the process, and so the servers, soon after the app leaves the screen, and from Android 15 on it cuts the network of
 * apps in the background. The notification names what runs and has Stop All. A server reachable from other devices
 * also keeps the CPU and Wi-Fi awake, or the phone's sleep would cut its clients off.
 */
class ServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val host = LocalHost.get(this)
        try {
            val notification = notification(host.states.value)
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST)
                else -> startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: IllegalStateException) {
            // The app left the foreground before the service got here: Android 12+ won't make it a foreground
            // service now; the next start from the app will.
            Log.w(TAG, "The server service couldn't enter the foreground", e)
            stopSelf()
            return
        }
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        scope.launch {
            host.states.collect { states ->
                if (states.values.none { it.active }) {
                    stopSelf()
                } else {
                    manager.notify(NOTIFICATION_ID, notification(states))
                    keepAwake(states.any { (id, state) -> state is ServerState.Running && ServerStore.get(this@ServerService).get(id)?.lan == true })
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_ALL) scope.launch { LocalHost.get(this@ServerService).stopAll() }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        keepAwake(false)
        super.onDestroy()
    }

    private fun keepAwake(awake: Boolean) {
        if (awake && wakeLock == null) {
            wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BrainDB:servers").apply {
                setReferenceCounted(false)
                acquire()
            }
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager).createWifiLock(mode, "BrainDB:servers").apply {
                setReferenceCounted(false)
                acquire()
            }
        } else if (!awake) {
            wakeLock?.takeIf { it.isHeld }?.release()
            wifiLock?.takeIf { it.isHeld }?.release()
            wakeLock = null
            wifiLock = null
        }
    }

    private fun notification(states: Map<String, ServerState>): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Local servers", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while a database server runs on this phone"
                setShowBadge(false)
            },
        )
        val store = ServerStore.get(this)
        val active = states.filterValues { it.active }.mapNotNull { (id, state) -> store.get(id)?.let { it to state } }
        val running = active.filter { it.second is ServerState.Running }
        val busy = active.firstOrNull { it.second !is ServerState.Running }
        val title = when {
            running.size == 1 && busy == null -> "${running[0].first.name} is running"
            running.isNotEmpty() -> "${running.size} local server${if (running.size == 1) "" else "s"} running"
            busy != null -> when (busy.second) {
                is ServerState.Installing -> "Downloading ${busy.first.engine.label}…"
                ServerState.Stopping -> "Stopping ${busy.first.name}…"
                else -> "Starting ${busy.first.name}…"
            }
            else -> "Local servers"
        }
        val text = running.joinToString(" · ") { (server, _) -> "${server.engine.label} on port ${server.port}" + if (server.lan) " (network)" else "" }
            .ifEmpty { (busy?.second as? ServerState.Starting)?.step ?: "" }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_SERVERS).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopAll = PendingIntent.getService(this, 1, Intent(this, ServerService::class.java).setAction(ACTION_STOP_ALL), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_server)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Stop All", stopAll)
        (busy?.second as? ServerState.Installing)?.let { if (it.total > 0) builder.setProgress(100, (it.done * 100 / it.total).toInt(), false) }
        return builder.build()
    }

    companion object {
        private const val TAG = "ServerService"
        private const val CHANNEL_ID = "servers"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP_ALL = "com.brainfactory.db.STOP_ALL_SERVERS"

        /**
         * Call while the app is in the foreground. A plain start, which the service promotes itself (after
         * startForegroundService Android kills the app unless startForeground follows within seconds, which a busy
         * main thread can miss).
         */
        fun start(context: Context) {
            val intent = Intent(context, ServerService::class.java)
            try {
                context.startService(intent)
            } catch (e: IllegalStateException) {
                // Not in the foreground after all: only the foreground form may start it now.
                ContextCompat.startForegroundService(context, intent)
            }
        }
    }
}
