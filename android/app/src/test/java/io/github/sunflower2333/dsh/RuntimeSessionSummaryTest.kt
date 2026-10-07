package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class RuntimeSessionSummaryTest {
    private fun fields(): Map<String, Any?> = mapOf("sessionId" to "session-1", "name" to null, "state" to "running", "turns" to 1L, "steps" to 2L,
        "inputTokens" to 100L, "outputTokens" to 400L, "totalTokens" to 2800L, "cachedInputTokens" to 2000L, "cacheWriteTokens" to 300L,
        "sessionTokens" to 5600L, "tokensPerSecond" to 25.0, "contextUsed" to 2400L, "contextCapacity" to 8000L)
    @Test fun exactSdkDisjointCacheAndNullableUnknownMetricsArePreserved() {
        val known = RuntimeSessionSummary.parse(fields())
        assertEquals(100L, known.inputTokens); assertEquals(2000L, known.cachedInputTokens)
        assertEquals(300L, known.cacheWriteTokens); assertEquals(5600L, known.sessionTokens)
        assertEquals(2400L, known.contextUsed); assertEquals(8000L, known.contextCapacity)
        assertNull(RuntimeSessionSummary.parse(fields() + ("cachedInputTokens" to null)).cachedInputTokens)
    }
    @Test fun malformedCountersUntrustedExtraDataAndDuplicateSessionsAreRejected() {
        for (bad in listOf(fields() + ("inputTokens" to -1L), fields() + ("contextCapacity" to 0L), fields() + ("tokensPerSecond" to Double.NaN),
            fields() + ("sessionId" to "../private"), fields() + ("name" to "secret\ntext"), fields() + ("prompt" to "secret"), fields() - "sessionTokens")) {
            try { RuntimeSessionSummary.parse(bad); fail("Invalid metrics accepted") } catch (_: IllegalArgumentException) { }
        }
        val base = mapOf("version" to 1, "epoch" to "host", "sequence" to 1L, "running" to 1, "waiting" to 0,
            "sessions" to listOf(fields(), fields()), "sessionsComplete" to true)
        try { HostEventProtocol.parse(base); fail("Duplicate sessions accepted") } catch (_: IllegalArgumentException) { }
    }
    @Test fun newerIdleSnapshotRemovesFinishedSessionsAndExpireClearsProgress() {
        val summary = RuntimeSessionSummary.parse(fields())
        val state = HostEventState()
        assertTrue(state.apply(HostEvent("host", 1, 1, 0, sessions = listOf(summary), sessionsComplete = true)))
        assertEquals(listOf(summary), state.sessions)
        assertTrue(state.apply(HostEvent("host", 2, 0, 0, sessions = emptyList(), sessionsComplete = true)))
        assertTrue(state.sessions.isEmpty()); assertTrue(state.sessionsComplete)
        state.apply(HostEvent("host", 3, 1, 0, sessions = listOf(summary), sessionsComplete = false))
        state.expire(); assertTrue(state.sessions.isEmpty()); assertFalse(state.sessionsComplete)
    }
    @Test fun replyActionCannotBeAttachedToApprovalAndAckMustBeOpaque() {
        val base = mapOf("version" to 1, "epoch" to "host", "sequence" to 1L, "running" to 0, "waiting" to 1,
            "sessionId" to "session", "eventId" to "event", "replyTicket" to "ticket")
        try { HostEventProtocol.parse(base + ("kind" to "approval")); fail("Approval reply action accepted") } catch (_: IllegalArgumentException) { }
        assertEquals("ticket", HostEventProtocol.parse(base + ("kind" to "question")).replyTicket)
        try { HostEventProtocol.parse(mapOf("version" to 1, "epoch" to "host", "sequence" to 1L, "running" to 0, "waiting" to 1, "replyAck" to "secret\ntext")); fail("Invalid ACK accepted") } catch (_: IllegalArgumentException) { }
    }
}
