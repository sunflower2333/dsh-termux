package io.github.sunflower2333.dsh

import android.content.Context
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/** Credentials are deliberately absent from this request's printable metadata. */
internal class AndroidDownloadRequest(
    val url: String,
    val filename: String,
    val mimeType: String,
    val userAgent: String?,
)

/** A download must belong to the currently authenticated, local DSH origin. */
internal object AndroidDownloadPolicy {
    fun isAllowed(url: String, pageUrl: String?, readyUrl: String?): Boolean {
        if (!LocalUrl.isAllowed(url) || pageUrl == null || readyUrl == null) return false
        if (!LocalUrl.isAllowed(pageUrl) || !LocalUrl.isAllowed(readyUrl)) return false
        val origin = URI(url)
        return listOf(pageUrl, readyUrl).all { source ->
            val other = URI(source)
            origin.scheme == other.scheme && origin.host == other.host && origin.port == other.port
        }
    }

    fun filename(value: String): String = value
        .replace(Regex("[\\\\/\\p{Cntrl}]"), "_")
        .trim().take(180).takeUnless { it.isEmpty() || it == "." || it == ".." }
        ?: "dsh-download"
}

/** HTTP operations kept separate so redirects and authenticated streaming can be verified on JVM. */
internal object AndroidDownloadHttp {
    const val CONNECT_TIMEOUT_MILLIS = 15_000
    const val READ_TIMEOUT_MILLIS = 30_000

    fun open(url: String, cookie: String?, userAgent: String?): HttpURLConnection {
        require(LocalUrl.isAllowed(url)) { "download is not a local DSH URL" }
        return (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            // Never forward DSH credentials through a redirect, even if the
            // initial response originated from the trusted loopback server.
            instanceFollowRedirects = false
            connectTimeout = CONNECT_TIMEOUT_MILLIS
            readTimeout = READ_TIMEOUT_MILLIS
            useCaches = false
            if (!cookie.isNullOrBlank()) setRequestProperty("Cookie", cookie)
            if (!userAgent.isNullOrBlank()) setRequestProperty("User-Agent", userAgent)
        }
    }

    fun requireSuccess(connection: HttpURLConnection) {
        if (connection.responseCode !in 200..299) throw IOException("DSH download returned an unsuccessful response")
    }

    fun copy(input: InputStream, output: OutputStream, length: Long, cancelled: () -> Boolean): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            if (cancelled() || Thread.currentThread().isInterrupted) throw InterruptedException("download cancelled")
            val count = input.read(buffer)
            if (count < 0) break
            if (cancelled() || Thread.currentThread().isInterrupted) throw InterruptedException("download cancelled")
            output.write(buffer, 0, count)
            total += count
        }
        if (length >= 0 && total != length) throw IOException("DSH download ended before its declared length")
        return total
    }
}

/** Save only to a content URI explicitly returned by Android's CreateDocument picker. */
internal class AndroidDownloads(context: Context) : Closeable {
    enum class Result { SAVED, FAILED, CANCELLED }

    private val resolver = context.applicationContext.contentResolver
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "dsh-download") }
    private val timer = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "dsh-download-timeout") }
    private val lock = Any()
    @Volatile private var closed = false
    private var active: Transfer? = null

    val isRunning: Boolean get() = synchronized(lock) { active != null }

    fun save(request: AndroidDownloadRequest, destination: Uri, cookie: String?, onComplete: (Result) -> Unit): Boolean {
        require(destination.scheme == "content") { "download destination must be a selected content URI" }
        require(LocalUrl.isAllowed(request.url)) { "download is not a local DSH URL" }
        synchronized(lock) {
            if (closed || active != null) return false
            val transfer = Transfer()
            active = transfer
            transfer.future = worker.submit {
                val result = try {
                    transfer.checkCancelled()
                    val connection = AndroidDownloadHttp.open(request.url, cookie, request.userAgent)
                    transfer.connection = connection
                    transfer.checkCancelled()
                    AndroidDownloadHttp.requireSuccess(connection)
                    connection.inputStream.use { input ->
                        transfer.checkCancelled()
                        val descriptor = resolver.openFileDescriptor(destination, "w", transfer.cancellation)
                            ?: throw IOException("Cannot open selected download destination")
                        ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                            transfer.output = output
                            transfer.checkCancelled()
                            AndroidDownloadHttp.copy(input, output, connection.contentLengthLong) { transfer.cancelled }
                            output.flush()
                            transfer.checkCancelled()
                        }
                    }
                    Result.SAVED
                } catch (_: Exception) {
                    if (transfer.cancelled && !transfer.timedOut) Result.CANCELLED else Result.FAILED
                } finally {
                    transfer.output = null
                    transfer.connection?.disconnect()
                    transfer.connection = null
                }
                synchronized(lock) {
                    transfer.deadline?.cancel(false)
                    if (active === transfer) active = null
                }
                if (!closed) main.post { if (!closed) onComplete(result) }
            }
            // Connect/read timeouts alone do not bound a very slow stream or
            // a document provider. Cancellation also closes active handles.
            transfer.deadline = timer.schedule({
                transfer.timedOut = true
                transfer.requestCancel()
                transfer.abort()
            }, 180, TimeUnit.SECONDS)
            return true
        }
    }

    override fun close() {
        val transfer = synchronized(lock) {
            if (closed) return
            closed = true
            active?.also {
                it.deadline?.cancel(false)
                it.requestCancel()
            }
        }
        // Closing provider/network handles can block; never do that on the
        // Activity thread. A cancelled export leaves the chosen document as-is.
        if (transfer != null) timer.execute { transfer.abort() }
        worker.shutdownNow()
        timer.shutdown()
        main.removeCallbacksAndMessages(null)
    }

    private class Transfer {
        @Volatile var cancelled = false
        @Volatile var timedOut = false
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var output: OutputStream? = null
        var future: Future<*>? = null
        var deadline: Future<*>? = null
        val cancellation = CancellationSignal()

        fun requestCancel() {
            cancelled = true
            future?.cancel(true)
        }

        fun checkCancelled() {
            if (cancelled || Thread.currentThread().isInterrupted) throw InterruptedException("download cancelled")
        }

        fun abort() {
            runCatching { cancellation.cancel() }
            runCatching { connection?.disconnect() }
            runCatching { output?.close() }
        }
    }
}
