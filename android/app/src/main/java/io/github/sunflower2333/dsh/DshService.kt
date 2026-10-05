package io.github.sunflower2333.dsh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DshService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val launchScheduled = AtomicBoolean(false)
    private val terminationScheduled = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())
    private var latestStartId = 0
    private var restartRequested = false
    @Volatile private var destroyed = false
    @Volatile private var launchFinishing = false
    @Volatile private var launchThread: Thread? = null
    @Volatile private var stopping = false
    @Volatile private var process: Process? = null
    @Volatile private var currentUrl: String? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification(getString(R.string.starting_status)))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        if (intent?.action == ACTION_STOP) {
            restartRequested = false
            stopping = true
            currentUrl = null
            process?.let(::terminateProcess)
            // Interrupt cold extraction, but keep this Service until the
            // launch worker and any old Node have really finished. A START
            // arriving meanwhile requests the next launch on this instance.
            if (process == null) launchThread?.interrupt()
            if (!launchScheduled.get()) stopSelfResult(latestStartId)
            return START_NOT_STICKY
        }
        if (stopping || launchFinishing || process?.isAlive == false) {
            if (launchScheduled.get()) restartRequested = true else scheduleLaunch()
            return START_STICKY
        }
        currentUrl?.takeIf { process?.isAlive == true }?.let {
            broadcast(ACTION_READY, it)
            return START_STICKY
        }
        scheduleLaunch()
        return START_STICKY
    }

    /** All launch/restart decisions happen on Android's main thread. */
    private fun scheduleLaunch() {
        if (destroyed || !launchScheduled.compareAndSet(false, true)) return
        stopping = false
        restartRequested = false
        launchFinishing = false
        terminationScheduled.set(false)
        executor.execute {
            launchThread = Thread.currentThread()
            try {
                if (!stopping && !destroyed) launchDsh()
            } finally {
                launchFinishing = true
                launchThread = null
                main.post {
                    launchScheduled.set(false)
                    launchFinishing = false
                    if (!destroyed) {
                        if (restartRequested) scheduleLaunch()
                        // Do not consume a newer START already queued by AMS
                        // but not yet delivered to onStartCommand().
                        else stopSelfResult(latestStartId)
                    }
                }
            }
        }
    }

    private fun launchDsh() {
        val diagnostics = StartupDiagnostics(File(cacheDir, "dsh-startup.log"))
        var launchedChild: Process? = null
        try {
            val manifest = RuntimeInstaller.loadManifest(this)
            val runtime = RuntimeInstaller.ensureInstalled(this, manifest)
            val commands = RuntimeInstaller.ensureCommandDirectory(this, manifest)
            check(!stopping) { "DSH start cancelled" }
            val executable = File(applicationInfo.nativeLibraryDir, manifest.executable)
            check(executable.isFile && executable.canExecute()) { "missing executable ${manifest.executable}" }
            val entrypoint = File(runtime, manifest.entrypoint).canonicalFile
            val runtimeRoot = runtime.canonicalFile
            check(entrypoint.isFile && (entrypoint.path == runtimeRoot.path || entrypoint.path.startsWith(runtimeRoot.path + File.separator))) {
                "missing runtime entrypoint ${manifest.entrypoint}"
            }
            val args = buildList {
                add(executable.absolutePath)
                // The Android runtime bridge uses Node's real internal APIs.
                add("--expose-internals")
                // Keep the path relative to the extracted runtime root. This
                // allows DSH to resolve its package-relative imports.
                add(entrypoint.relativeTo(runtimeRoot).path)
                addAll(manifest.arguments)
            }
            val builder = ProcessBuilder(args)
                .directory(runtime)
                .redirectErrorStream(true)
            builder.environment()["DSH_ANDROID"] = "1"
            builder.environment()["DSH_WEB_HOST"] = manifest.host
            builder.environment()["SHELL"] = File(commands, "bash").absolutePath
            val home = File(filesDir, "dsh-home").apply { mkdirs() }
            val documents = File(filesDir, "Documents").apply { mkdirs() }
            builder.environment()["DSH_ANDROID_DOCUMENTS_DIR"] = documents.absolutePath
            val temp = cacheDir.resolve("dsh-tmp").apply { mkdirs() }
            builder.environment()["HOME"] = home.absolutePath
            builder.environment()["TMPDIR"] = temp.absolutePath
            builder.environment()["XDG_CONFIG_HOME"] = File(home, ".config").apply { mkdirs() }.absolutePath
            builder.environment()["XDG_CACHE_HOME"] = File(cacheDir, "dsh-cache").apply { mkdirs() }.absolutePath
            val nativeDir = applicationInfo.nativeLibraryDir
            builder.environment()["ESBUILD_BINARY_PATH"] = File(nativeDir, "libdsh_esbuild.so").absolutePath
            builder.environment()["LD_LIBRARY_PATH"] = listOf(nativeDir, builder.environment()["LD_LIBRARY_PATH"]).filterNotNull().joinToString(File.pathSeparator)
            builder.environment()["PATH"] = listOf(commands.absolutePath, nativeDir, "/system/bin", "/system/xbin").joinToString(File.pathSeparator)
            val child = builder.start().also { launchedChild = it }
            process = child
            if (stopping) {
                terminateProcess(child)
                return
            }
            InputStreamReader(child.inputStream).use { reader ->
                StartupDiagnostics.readLines(reader) { line ->
                    broadcast(ACTION_LOG, diagnostics.append(line))
                    // DSH emits the local URL on startup. Validate it before exposing it to WebView.
                    val candidate = if (currentUrl == null) extractReadyUrl(line) else null
                    if (candidate != null && LocalUrl.isAllowed(candidate, manifest.webPath)) {
                        currentUrl = candidate
                        broadcast(ACTION_READY, candidate)
                        updateNotification(getString(R.string.running_status))
                    }
                }
            }
            val exitCode = child.waitFor()
            if (!stopping) {
                reportError(getString(R.string.process_exit_error, exitCode), diagnostics)
                broadcast(ACTION_EXITED, exitCode.toString())
            }
        } catch (error: Throwable) {
            if (!stopping) reportError(error.message ?: error::class.java.simpleName, diagnostics)
        } finally {
            launchFinishing = true
            // Cleanup also covers exceptions while consuming output or
            // publishing readiness, before the normal waitFor() path.
            launchedChild?.let(::awaitProcessExit)
            process = null
            currentUrl = null
        }
    }

    private fun reportError(message: String, diagnostics: StartupDiagnostics) {
        val safeMessage = StartupDiagnostics.sanitize(message)
        val tail = diagnostics.tail().ifBlank { getString(R.string.no_process_output) }
        val detail = getString(R.string.startup_failure_details, safeMessage, tail)
        runCatching { File(cacheDir, "dsh-startup-error.txt").writeText(detail) }
        broadcast(ACTION_ERROR, detail)
    }

    override fun onDestroy() {
        destroyed = true
        restartRequested = false
        stopping = true
        process?.let(::terminateProcess)
        executor.shutdownNow()
        main.removeCallbacksAndMessages(null)
        broadcast(ACTION_EXITED, "stopped")
        super.onDestroy()
    }

    private fun terminateProcess(child: Process) {
        if (!terminationScheduled.compareAndSet(false, true)) return
        // DSH handles SIGTERM by disposing managed Bash processes and PTYs.
        // Give that cleanup time to run without blocking Android's main thread.
        runCatching { child.destroy() }
        Thread({
            val exited = runCatching { child.waitFor(5, TimeUnit.SECONDS) }.getOrDefault(false)
            if (!exited) runCatching { child.destroyForcibly() }
        }, "dsh-process-stop").start()
    }

    /** A queued restart cannot overlap a Node which is still disposing its tools. */
    private fun awaitProcessExit(child: Process) {
        terminateProcess(child)
        var interrupted = Thread.interrupted()
        try {
            while (child.isAlive) {
                try {
                    child.waitFor()
                } catch (_: InterruptedException) {
                    interrupted = true
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun broadcast(action: String, value: String) {
        sendBroadcast(Intent(action).setPackage(packageName).putExtra(EXTRA_VALUE, value), INTERNAL_PERMISSION)
    }

    private fun updateNotification(text: String) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, DshService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_service), getString(R.string.stop), stop).build())
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.channel_description)
        })
    }

    companion object {
        const val INTERNAL_PERMISSION = "io.github.sunflower2333.dsh.permission.INTERNAL"
        const val ACTION_START = "io.github.sunflower2333.dsh.START"
        const val ACTION_STOP = "io.github.sunflower2333.dsh.STOP"
        const val ACTION_READY = "io.github.sunflower2333.dsh.READY"
        const val ACTION_LOG = "io.github.sunflower2333.dsh.LOG"
        const val ACTION_ERROR = "io.github.sunflower2333.dsh.ERROR"
        const val ACTION_EXITED = "io.github.sunflower2333.dsh.EXITED"
        const val EXTRA_VALUE = "value"
        private const val CHANNEL_ID = "dsh-service"
        private const val NOTIFICATION_ID = 1001
        // dsh web prints the browser launch URL with its one-time auth token
        // in the query string (for example: http://127.0.0.1:43127/?token=…).
        // Keep that query intact: loading the clean URL makes the web server
        // return 401 and leaves the WebView looking blank.
        private val URL_PATTERN = Regex("^\\s*dsh web:\\s+(http://127\\.0\\.0\\.1:[0-9]{1,5}(?:(?:/|\\?)[^\\s\\u001b]*)?)")

        internal fun extractReadyUrl(line: String): String? = URL_PATTERN.find(line)?.groupValues?.get(1)
    }
}
