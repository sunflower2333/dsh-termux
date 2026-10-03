package io.github.sunflower2333.dsh

import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeManifestTest {
    @Test fun acceptsOnlyLoopbackHttpUrls() {
        assertTrue(LocalUrl.isAllowed("http://127.0.0.1:4312/"))
        assertTrue(LocalUrl.isAllowed("http://127.0.0.1:4312/ui/index.html", "/ui"))
        assertFalse(LocalUrl.isAllowed("https://127.0.0.1:4312/"))
        assertFalse(LocalUrl.isAllowed("http://localhost:4312/"))
        assertFalse(LocalUrl.isAllowed("http://127.0.0.1:4312@evil.test/"))
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
