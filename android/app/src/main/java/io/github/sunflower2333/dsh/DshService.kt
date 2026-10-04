package io.github.sunflower2333.dsh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.Executors

class DshService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val launchScheduled = AtomicBoolean(false)
    @Volatile private var stopping = false
    @Volatile private var process: Process? = null
    @Volatile private var currentUrl: String? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification(getString(R.string.starting_status)))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopping = true
            currentUrl = null
            stopSelf()
            return START_NOT_STICKY
        }
        if (process == null && !launchScheduled.get()) stopping = false
        currentUrl?.let {
            broadcast(ACTION_READY, it)
            return START_NOT_STICKY
        }
        if (process == null && launchScheduled.compareAndSet(false, true)) executor.execute {
            try {
                launchDsh()
            } finally {
                launchScheduled.set(false)
            }
        }
        return START_NOT_STICKY
    }

    private fun launchDsh() {
        try {
            val manifest = RuntimeInstaller.loadManifest(this)
            val runtime = RuntimeInstaller.ensureInstalled(this, manifest)
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
            builder.environment()["SHELL"] = "/system/bin/sh"
            val home = File(filesDir, "dsh-home").apply { mkdirs() }
            val temp = cacheDir.resolve("dsh-tmp").apply { mkdirs() }
            builder.environment()["HOME"] = home.absolutePath
            builder.environment()["TMPDIR"] = temp.absolutePath
            builder.environment()["XDG_CONFIG_HOME"] = File(home, ".config").apply { mkdirs() }.absolutePath
            builder.environment()["XDG_CACHE_HOME"] = File(cacheDir, "dsh-cache").apply { mkdirs() }.absolutePath
            val nativeDir = applicationInfo.nativeLibraryDir
            builder.environment()["LD_LIBRARY_PATH"] = listOf(nativeDir, builder.environment()["LD_LIBRARY_PATH"]).filterNotNull().joinToString(File.pathSeparator)
            builder.environment()["PATH"] = listOf(nativeDir, "/system/bin", "/system/xbin").joinToString(File.pathSeparator)
            val child = builder.start()
            process = child
            val reader = BufferedReader(InputStreamReader(child.inputStream))
            while (true) {
                val line = reader.readLine() ?: break
                broadcast(ACTION_LOG, line)
                // DSH emits the local URL on startup. Validate it before exposing it to WebView.
                val candidate = URL_PATTERN.find(line)?.value
                if (candidate != null && LocalUrl.isAllowed(candidate, manifest.webPath)) {
                    currentUrl = candidate
                    broadcast(ACTION_READY, candidate)
                    updateNotification(getString(R.string.running_status))
                }
            }
            val exitCode = child.waitFor()
            broadcast(ACTION_EXITED, exitCode.toString())
        } catch (error: Throwable) {
            broadcast(ACTION_ERROR, error.message ?: error::class.java.simpleName)
        } finally {
            process = null
            currentUrl = null
            stopSelf()
        }
    }

    override fun onDestroy() {
        stopping = true
        process?.destroy()
        process?.destroyForcibly()
        executor.shutdownNow()
        broadcast(ACTION_EXITED, "stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun broadcast(action: String, value: String) {
        sendBroadcast(Intent(action).setPackage(packageName).putExtra(EXTRA_VALUE, value))
    }

    private fun updateNotification(text: String) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.channel_description)
        })
    }

    companion object {
        const val ACTION_START = "io.github.sunflower2333.dsh.START"
        const val ACTION_STOP = "io.github.sunflower2333.dsh.STOP"
        const val ACTION_READY = "io.github.sunflower2333.dsh.READY"
        const val ACTION_LOG = "io.github.sunflower2333.dsh.LOG"
        const val ACTION_ERROR = "io.github.sunflower2333.dsh.ERROR"
        const val ACTION_EXITED = "io.github.sunflower2333.dsh.EXITED"
        const val EXTRA_VALUE = "value"
        private const val CHANNEL_ID = "dsh-service"
        private const val NOTIFICATION_ID = 1001
        private val URL_PATTERN = Regex("http://127\\.0\\.0\\.1:[0-9]{1,5}(?:/[^\\s]*)?")
    }
}
