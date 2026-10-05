package io.github.sunflower2333.dsh

import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeManifestTest {
    @Test fun hashesTheCompleteRuntimeBundle() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            RuntimeInstaller.sha256(ByteArrayInputStream("abc".toByteArray())),
        )
    }

    @Test fun acceptsOnlyLoopbackHttpUrls() {
        assertTrue(LocalUrl.isAllowed("http://127.0.0.1:4312/"))
        assertTrue(LocalUrl.isAllowed("http://127.0.0.1:4312/?token=one-time-token"))
        assertTrue(LocalUrl.isAllowed("http://127.0.0.1:4312/ui/index.html", "/ui"))
        assertFalse(LocalUrl.isAllowed("https://127.0.0.1:4312/"))
        assertFalse(LocalUrl.isAllowed("http://localhost:4312/"))
        assertFalse(LocalUrl.isAllowed("http://127.0.0.1:4312@evil.test/"))
    }

    @Test fun keepsTheDshBrowserTokenInTheReadyUrl() {
        val line = "dsh web: http://127.0.0.1:4312/?token=one-time-token"
        assertTrue(DshService.extractReadyUrl(line)!!.contains("?token=one-time-token"))
        assertNull(DshService.extractReadyUrl("tool output: http://127.0.0.1:4312/?token=other-token"))
        assertNull(DshService.extractReadyUrl("dsh web: https://example.com/"))
    }

    @Test fun classifiesInternalAndExternalNavigation() {
        val readyUrl = "http://127.0.0.1:4312/?token=one-time-token"
        assertEquals(
            WebNavigationDecision.INTERNAL,
            WebNavigation.classify("http://127.0.0.1:4312/ui/index.html", readyUrl),
        )
        assertEquals(
            WebNavigationDecision.EXTERNAL_HTTP,
            WebNavigation.classify("https://example.com/docs", readyUrl),
        )
        assertEquals(
            WebNavigationDecision.BLOCKED,
            WebNavigation.classify("intent://settings#Intent;scheme=app;end", readyUrl),
        )
    }

    @Test fun isolatesTheAuthenticatedWebViewFromOtherLoopbackPorts() {
        val readyUrl = "http://127.0.0.1:4312/?token=one-time-token"
        assertEquals(
            WebNavigationDecision.EXTERNAL_HTTP,
            WebNavigation.classify("http://127.0.0.1:9999/", readyUrl),
        )
        assertEquals(
            WebNavigationDecision.EXTERNAL_HTTP,
            WebNavigation.classify("http://127.0.0.1:4312/", null),
        )
        assertTrue(WebNavigation.isCurrentOrigin("http://127.0.0.1:4312/session#history", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin("http://127.0.0.1:9999/", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin("https://127.0.0.1:4312/", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin("http://localhost:4312/", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin("http://127.0.0.1:4312@evil.test/", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin("not a URL", readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin(null, readyUrl))
        assertFalse(WebNavigation.isCurrentOrigin(readyUrl, null))
    }

    @Test fun blocksCrossPortResourcesWhichBypassNavigationCallbacks() {
        val readyUrl = "http://127.0.0.1:4312/?token=one-time-token"
        assertFalse(WebNavigation.blocksForeignLoopbackRequest("http://127.0.0.1:4312/assets/image.png", readyUrl))
        assertTrue(WebNavigation.blocksForeignLoopbackRequest("http://127.0.0.1:9999/image.png", readyUrl))
        assertTrue(WebNavigation.blocksForeignLoopbackRequest("http://127.0.0.1/", readyUrl))
        assertTrue(WebNavigation.blocksForeignLoopbackRequest("https://127.0.0.1:4312/", readyUrl))
        assertTrue(WebNavigation.blocksForeignLoopbackRequest("http://127.0.0.1:4312/", null))
        assertFalse(WebNavigation.blocksForeignLoopbackRequest("https://example.com/image.png", readyUrl))
        assertFalse(WebNavigation.blocksForeignLoopbackRequest("data:image/png;base64,example", readyUrl))
    }

    @Test fun rejectsZipTraversal() {
        val root = Files.createTempDirectory("dsh-runtime-test").toFile()
        val bytes = java.io.ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                zip.putNextEntry(ZipEntry("../escaped")); zip.write("bad".toByteArray()); zip.closeEntry()
            }
        }.toByteArray()
        try {
            RuntimeInstaller.unzipSafely(ByteArrayInputStream(bytes), root)
            throw AssertionError("traversal archive should be rejected")
        } catch (_: IllegalArgumentException) {
            // expected
        }
        assertFalse(root.parentFile!!.resolve("escaped").exists())
        root.deleteRecursively()
    }
}
