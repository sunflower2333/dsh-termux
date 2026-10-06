package io.github.sunflower2333.dsh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPortPolicyTest {
    private val automatic = listOf("web", "--port", "0", "--config", "owned-config.json")

    @Test fun rememberedPortReplacesOnlyAutomaticOptionWithoutMutatingManifest() {
        val original = automatic.toMutableList()
        val plan = HostPortPolicy.plan(original, 43127)
        assertEquals(listOf("web", "--port", "43127", "--config", "owned-config.json"), plan.arguments)
        assertEquals(43127, plan.rememberedPort)
        assertEquals(automatic, original)
    }

    @Test fun firstRunAndInvalidRememberedPortsKeepAutomaticBinding() {
        for (port in listOf(null, -1, 0, 65536)) {
            val plan = HostPortPolicy.plan(automatic, port)
            assertEquals(automatic, plan.arguments)
            assertNull(plan.rememberedPort)
        }
    }

    @Test fun explicitlyConfiguredPortIsNeverReplacedOrEligibleForFallback() {
        val explicit = listOf("web", "--port", "12345")
        val plan = HostPortPolicy.plan(explicit, 43127)
        assertEquals(explicit, plan.arguments)
        assertNull(plan.rememberedPort)
    }

    @Test fun absentMalformedAndDuplicatePortOptionsRetainManifestSemantics() {
        for (args in listOf(listOf("web"), listOf("web", "--port"),
            listOf("web", "--port=0"), listOf("web", "--port", "0", "--port", "7000"))) {
            val plan = HostPortPolicy.plan(args, 43127)
            assertEquals(args, plan.arguments)
            assertNull(plan.rememberedPort)
        }
    }

    @Test fun readyExtractionRetainsExistingLoopbackAndPathPolicy() {
        assertEquals(43127, HostPortPolicy.readyPort("http://127.0.0.1:43127/?token=unit-test", "/"))
        assertEquals(65535, HostPortPolicy.readyPort("http://127.0.0.1:65535/web/?token=unit-test", "/web"))
        for (url in listOf("https://127.0.0.1:43127/web/", "http://localhost:43127/web/",
            "http://192.0.2.1:43127/web/", "http://user@127.0.0.1:43127/web/",
            "http://127.0.0.1:0/web/", "http://127.0.0.1:65536/web/",
            "http://127.0.0.1:43127/other/", "http://127.0.0.1:43127/web-bait/")) {
            assertNull(HostPortPolicy.readyPort(url, "/web"))
        }
    }

    @Test fun realNodeListenFailureMatchesOnlyExactOwnedEndpoint() {
        assertTrue(HostPortPolicy.isBindConflict(
            "Error: listen EADDRINUSE: address already in use 127.0.0.1:43127", 43127))
        assertTrue(HostPortPolicy.isBindConflict(
            "listen EADDRINUSE: address already in use 127.0.0.1:43127", 43127))
        // The pinned CLI's real required-webserver failure indents the
        // unmodified Node Error by four spaces (HOST Bionic probe).
        assertTrue(HostPortPolicy.isBindConflict(
            "    Error: listen EADDRINUSE: address already in use 127.0.0.1:50021", 50021))
        for (line in listOf("Error: listen EADDRINUSE: address already in use 127.0.0.1:43128",
            "Error: listen EADDRINUSE: address already in use 127.0.0.1:431270",
            "Error: listen EADDRINUSE: address already in use 0.0.0.0:43127",
            "Error: connect EADDRINUSE: address already in use 127.0.0.1:43127",
            "plugin mentioned listen EADDRINUSE: address already in use 127.0.0.1:43127",
            "Error: listen EADDRINUSE: address already in use 127.0.0.1:43127 extra text")) {
            assertFalse(HostPortPolicy.isBindConflict(line, 43127))
        }
    }

    @Test fun genuinePreferredConflictAllowsOneAutomaticRetry() {
        assertTrue(retry())
        assertFalse(retry(fallbackUsed = true))
        assertFalse(retry(rememberedPort = null))
    }

    @Test fun authenticatedOrSuccessfulAttemptCannotBeRetried() {
        assertFalse(retry(readySeen = true))
        assertFalse(retry(exitCode = 0))
    }

    @Test fun processFailureWithoutOwnedBindConflictIsReportedNormally() {
        assertFalse(retry(exitCode = 139, bindConflict = false))
        assertFalse(retry(exitCode = 1, bindConflict = false))
    }

    @Test fun stopOrDestructionPreventsAutomaticRetry() {
        assertFalse(retry(cancelled = true))
    }

    private fun retry(
        rememberedPort: Int? = 43127,
        fallbackUsed: Boolean = false,
        readySeen: Boolean = false,
        exitCode: Int = 1,
        bindConflict: Boolean = true,
        cancelled: Boolean = false,
    ) = HostPortPolicy.retryAutomaticPort(rememberedPort, fallbackUsed, readySeen,
        exitCode, bindConflict, cancelled)
}
