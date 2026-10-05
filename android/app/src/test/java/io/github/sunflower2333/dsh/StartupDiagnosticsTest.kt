package io.github.sunflower2333.dsh

import java.io.StringReader
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartupDiagnosticsTest {
    @Test fun stripsTerminalControlsAndRedactsUrlCredentials() {
        val input = "\u001b[31mfailed\u001b[0m\u0000 " +
            "\u001b]0;terminal title\u0007http://127.0.0.1:4312/?token=secret&mode=web"
        assertEquals("failed http://127.0.0.1:4312/?token=[REDACTED]&mode=web", StartupDiagnostics.sanitize(input))
        assertEquals("https://example.test/?ACCESS_TOKEN=[REDACTED]#token=[REDACTED]",
            StartupDiagnostics.sanitize("https://example.test/?ACCESS_TOKEN=secret#token=other"))
    }

    @Test fun retainsOnlyBoundedRecentLinesAndPersistsSanitizedOutput() {
        val log = Files.createTempFile("dsh-startup", ".log").toFile()
        try {
            val diagnostics = StartupDiagnostics(log, maxLines = 2, maxCharacters = 30)
            diagnostics.append("old line")
            diagnostics.append("second")
            diagnostics.append("third")
            assertEquals("second\nthird", diagnostics.tail())
            diagnostics.append("x".repeat(100))
            assertTrue(diagnostics.tail().length <= 30)
            assertEquals(diagnostics.tail(), log.readText())
            diagnostics.append("?token=secret")
            assertFalse(log.readText().contains("secret"))
        } finally {
            log.delete()
        }
    }

    @Test fun boundsUnterminatedProcessOutputAndKeepsFollowingLines() {
        val output = mutableListOf<String>()
        StartupDiagnostics.readLines(StringReader("x".repeat(200_000) + "tail\nexit reason\r\nfinal"), output::add)
        assertEquals(3, output.size)
        assertTrue(output[0].length < 8_300)
        assertTrue(output[0].startsWith("[…truncated…] "))
        assertTrue(output[0].endsWith("tail"))
        assertEquals("exit reason", output[1])
        assertEquals("final", output[2])
    }
}
