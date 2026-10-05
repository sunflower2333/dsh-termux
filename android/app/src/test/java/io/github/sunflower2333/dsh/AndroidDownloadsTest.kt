package io.github.sunflower2333.dsh

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidDownloadsTest {
    @Test fun requiresCurrentPageAndReadyServerOrigin() {
        val page = "http://127.0.0.1:4312/"
        val ready = "http://127.0.0.1:4312/?token=fixture-only"
        assertTrue(AndroidDownloadPolicy.isAllowed("$page" + "api/session.export?sessionId=example", page, ready))
        for (url in listOf("http://127.0.0.1:4313/api/session.export", "https://example.test/export",
            "http://localhost:4312/export", "http://user@127.0.0.1:4312/export", "blob:$page")) {
            assertFalse(AndroidDownloadPolicy.isAllowed(url, page, ready))
        }
        assertFalse(AndroidDownloadPolicy.isAllowed(page, null, ready))
        assertFalse(AndroidDownloadPolicy.isAllowed(page, page, null))
        assertFalse(AndroidDownloadPolicy.isAllowed(page, page, "http://127.0.0.1:4313/"))
    }

    @Test fun sanitizesSuggestedNameAndRejectsIncompleteOrCancelledStreams() {
        assertEquals(".._folder_file_.zip", AndroidDownloadPolicy.filename("../folder\\file\u0000.zip"))
        assertEquals("dsh-download", AndroidDownloadPolicy.filename(".."))
        val output = ByteArrayOutputStream()
        assertEquals(3L, AndroidDownloadHttp.copy(ByteArrayInputStream(byteArrayOf(1, 2, 3)), output, 3) { false })
        assertEquals(3, output.size())
        try {
            AndroidDownloadHttp.copy(ByteArrayInputStream(byteArrayOf(1)), ByteArrayOutputStream(), 2) { false }
            throw AssertionError("short stream accepted")
        } catch (_: IOException) { }
        val cancelledOutput = ByteArrayOutputStream()
        try {
            AndroidDownloadHttp.copy(ByteArrayInputStream(byteArrayOf(1)), cancelledOutput, 1) { true }
            throw AssertionError("cancelled stream copied")
        } catch (_: InterruptedException) { }
        assertEquals(0, cancelledOutput.size())
    }

    @Test fun authenticatesStreamsAndRejectsRedirects() {
        val server = ServerSocket().apply { bind(InetSocketAddress("127.0.0.1", 0)) }
        val redirected = AtomicInteger()
        val receivedCookie = AtomicReference<String?>()
        val receivedAgent = AtomicReference<String?>()
        val payload = "actual loopback HTTP fixture".toByteArray()
        val serving = thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: SocketException) { break }
                socket.use {
                    socket.soTimeout = 2_000
                    val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                    val path = reader.readLine().split(' ')[1]
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        val colon = line.indexOf(':')
                        if (colon > 0) headers[line.substring(0, colon).lowercase()] = line.substring(colon + 1).trim()
                    }
                    val response = if (path == "/export" || path == "/download") {
                        receivedCookie.set(headers["cookie"])
                        receivedAgent.set(headers["user-agent"])
                        if (path == "/export") "HTTP/1.1 302 Found\r\nLocation: /must-not-follow\r\n"
                        else "HTTP/1.1 200 OK\r\n"
                    } else {
                        redirected.incrementAndGet()
                        "HTTP/1.1 200 OK\r\n"
                    }
                    val body = if (path == "/download") payload else byteArrayOf()
                    socket.getOutputStream().write((response +
                        "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                    socket.getOutputStream().write(body)
                }
            }
        }
        try {
            val connection = AndroidDownloadHttp.open("http://127.0.0.1:${server.localPort}/export",
                "fixture-only=download-test", "DSH-Test-WebView")
            try {
                assertFalse(connection.instanceFollowRedirects)
                assertEquals(302, connection.responseCode)
                try {
                    AndroidDownloadHttp.requireSuccess(connection)
                    throw AssertionError("redirect accepted as a completed download")
                } catch (_: IOException) { }
                assertEquals("fixture-only=download-test", receivedCookie.get())
                assertEquals("DSH-Test-WebView", receivedAgent.get())
                assertEquals(0, redirected.get())
            } finally {
                connection.disconnect()
            }
            val download = AndroidDownloadHttp.open("http://127.0.0.1:${server.localPort}/download",
                "fixture-only=download-test", "DSH-Test-WebView")
            try {
                AndroidDownloadHttp.requireSuccess(download)
                val output = ByteArrayOutputStream()
                download.inputStream.use { input ->
                    assertEquals(payload.size.toLong(), AndroidDownloadHttp.copy(input, output, download.contentLengthLong) { false })
                }
                assertArrayEquals(payload, output.toByteArray())
            } finally {
                download.disconnect()
            }
        } finally {
            server.close()
            serving.join(2_000)
        }
    }
}
