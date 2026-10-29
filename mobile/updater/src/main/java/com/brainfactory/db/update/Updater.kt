package com.brainfactory.db.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Updates the app from the version manifest (version.rc) at [BuildConfig.UPDATE_URL]: when it offers a newer version, the
 * APK it names is downloaded to the cache, checked against the manifest's SHA-256 and handed to the system
 * package installer, which asks the user to confirm. Android only accepts it when it's signed with the same
 * key as the installed app. Downloading sends the buyer's licence, which [LicenceGate] has the user sign in for.
 */
class Updater(private val context: Context) {

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data object UpToDate : State
        data class Available(val update: AppUpdate) : State
        data class Downloading(val update: AppUpdate, val progress: Float) : State
        data object Installing : State
        /** [update] is set when there is a newer version the user can still download by hand. */
        data class Failed(val message: String, val update: AppUpdate? = null) : State
    }

    var state by mutableStateOf<State>(State.Idle)
        private set

    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val installed = context.packageManager.getPackageInfo(context.packageName, 0)
    private val installedCode = PackageInfoCompat.getLongVersionCode(installed)
    private val main = Handler(Looper.getMainLooper())

    /** Downloads outlive the screen that started them (the Updates dialog may be closed meanwhile). */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val currentVersion: String = installed.versionName.orEmpty()

    private val client = UpdateClient(BuildConfig.UPDATE_URL, "BrainDB/$currentVersion")
    private val licences = LicenceClient(BuildConfig.LICENCE_API, "BrainDB/$currentVersion")
    private val licenceStore = LicenceStore(context)

    /** The signed-in buyer's licence, or null. */
    var licence by mutableStateOf(licenceStore.load())
        private set

    /** The email last signed in with, for the sign-in screen; "" when there is none. */
    val lastEmail: String get() = licenceStore.lastEmail()

    /** The newest update found, kept so a failed update can still point to its download. */
    private var latest: AppUpdate? = null

    /** Checks the version manifest (version.rc) at most every [AUTO_CHECK_INTERVAL_MS]; [force] checks now (Help › Updates & Account). */
    suspend fun check(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong(KEY_LAST_CHECK, 0) < AUTO_CHECK_INTERVAL_MS) {
            prefs.getString(KEY_MANIFEST, null)?.let { cached ->
                runCatching { parseUpdateManifest(cached, BuildConfig.UPDATE_URL) }.getOrNull()
                    ?.takeIf { it.isNewerThan(installedCode, currentVersion) }
                    ?.let { latest = it; state = State.Available(it) }
            }
            return
        }
        state = State.Checking
        state = try {
            val (update, json) = withContext(Dispatchers.IO) { client.fetchManifest() }
            prefs.edit().putLong(KEY_LAST_CHECK, now).putString(KEY_MANIFEST, json).apply()
            if (update != null && update.isNewerThan(installedCode, currentVersion)) State.Available(update).also { latest = update } else State.UpToDate
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Update check failed", e)
            when {
                !force -> State.Idle
                // The server is reachable but has no version manifest: nothing has been released yet.
                e.message.orEmpty().endsWith("answered 404") -> State.Failed("No Brain DB release has been published yet.")
                else -> State.Failed("Couldn't check for updates. Check the internet connection and try again.")
            }
        }
    }

    fun dismiss() {
        state = State.Idle
    }

    /** The user cancelled Android's install prompt: offer the update again. */
    fun dismissInstall() {
        state = latest?.let { State.Available(it) } ?: State.Idle
    }

    /** Downloads [update]'s APK and starts the system installer, in the background. */
    fun install(update: AppUpdate) {
        if (state is State.Downloading || state is State.Installing || licence == null) return
        scope.launch { download(update) }
    }

    /** Emails a sign-in code to [email]; the server's message, or the reason it refused. */
    suspend fun requestCode(email: String): Result<String> = withContext(Dispatchers.IO) { runCatching { licences.requestCode(email.trim()) } }

    /** Signs in with the emailed [code]. */
    suspend fun verifyCode(email: String, code: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching { licences.verifyCode(email.trim(), code.trim()) }
    }.map { signedIn ->
        licenceStore.save(signedIn)
        licence = signedIn
    }

    /** Signs out, which brings back the sign-in screen. */
    fun signOut() {
        licenceStore.clear()
        licence = null
    }

    private suspend fun download(update: AppUpdate) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            // Android asks once per app for permission to install updates.
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            state = State.Available(update)
            return
        }
        state = State.Downloading(update, 0f)
        try {
            val apk = File(context.cacheDir, "updates/BrainDB-${update.version}.apk").apply { parentFile?.mkdirs() }
            withContext(Dispatchers.IO) {
                client.download(update, apk, licence?.token) { progress -> main.post { state = State.Downloading(update, progress) } }
            }
            state = State.Installing
            withContext(Dispatchers.IO) { startInstall(apk) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: LicenceException) {
            Log.w(TAG, "Licence refused", e)
            if (needsSignIn(e.status, e.code)) {
                // No longer licensed (expired, revoked): back to the sign-in screen, with the update still on offer.
                state = State.Available(update)
                signOut()
            } else {
                // Signed in, but the account hasn't bought Brain DB: signing in again wouldn't help.
                state = State.Failed(e.message.orEmpty(), update)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Update failed", e)
            failed(update)
        }
    }

    /** The installer rejected the update (e.g. it's signed differently from this copy). */
    fun installFailed(reason: String?) {
        Log.w(TAG, "Install failed: $reason")
        failed(latest)
    }

    private fun failed(update: AppUpdate?) {
        state = State.Failed(
            if (update != null) "The update couldn't be installed automatically. Download Brain DB ${update.version} and install it by hand."
            else "The update couldn't be installed automatically. Download the new version from www.brainfactory.id.",
            update,
        )
    }

    /**
     * Opens the update's download page in the browser, for updating by hand. When that's the APK itself, the browser
     * needs the licence too, which the server also takes in the address.
     */
    fun openDownload(update: AppUpdate?) {
        var url = update?.pageUrl?.takeIf { it.isNotBlank() } ?: "https://www.brainfactory.id"
        val token = licence?.token
        if (update != null && url == update.apkUrl && token != null) url += (if ('?' in url) "&" else "?") + "token=" + Uri.encode(token)
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun startInstall(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input -> session.openWrite("base.apk", 0, apk.length()).use { out -> input.copyTo(out); session.fsync(out) } }
            val intent = Intent(context, UpdateInstallReceiver::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
        }
    }

    companion object {
        private const val TAG = "Updater"
        private const val KEY_LAST_CHECK = "lastCheck"
        private const val KEY_MANIFEST = "manifest"
        private const val AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

        @Volatile private var instance: Updater? = null
        fun get(context: Context): Updater = instance ?: synchronized(this) { instance ?: Updater(context.applicationContext).also { instance = it } }
    }
}

/** Receives the installer's result; asks the user to confirm when Android requires it. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // the app restarts into the new version
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.get(context).dismissInstall()
            else -> Updater.get(context).installFailed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }
}
