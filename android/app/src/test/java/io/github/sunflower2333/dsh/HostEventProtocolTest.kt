package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class HostEventProtocolTest {
    private fun fields() = mapOf<String, Any?>("version" to 1, "epoch" to "host-a", "sequence" to 1L,
        "running" to 1, "waiting" to 0)

    private fun event(sequence: Long, kind: String? = null, id: String = "request-1", session: String = "session-1",
        epoch: String = "host-a", running: Int = 0, waiting: Int = 1) =
        HostEvent(epoch, sequence, running, waiting, if (kind == null) null else session,
            kind, if (kind == null) null else id)

    @Test fun snapshotContainsOnlyOpaqueState() {
        assertEquals(HostEvent("host-a", 1, 1, 0), HostEventProtocol.parse(fields()))
        val request = HostEventProtocol.parse(fields() + mapOf("kind" to "question", "sessionId" to "session-1", "eventId" to "question-1"))
        assertEquals("session-1", request.sessionId)
    }

    @Test fun malformedOrSensitivePayloadsAreRejected() {
        val invalid = listOf(fields() + ("prompt" to "private question"), fields() + ("token" to "secret"),
            fields() + ("version" to 2), fields() + ("sequence" to 0), fields() + ("sequence" to 1.0),
            fields() + ("running" to -1), fields() + ("waiting" to 1001), fields() + ("epoch" to "a b"),
            fields() + ("sessionId" to "session-1"), fields() + ("kind" to "question"),
            fields() + mapOf("kind" to "question", "sessionId" to "../session", "eventId" to "request-1"),
            fields() + mapOf("kind" to "grant", "sessionId" to "session-1", "eventId" to "request-1"))
        for (candidate in invalid) {
            try { HostEventProtocol.parse(candidate); fail("Invalid event accepted: ${candidate.keys}") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun lateOrDuplicateRequestCannotReviveResolvedQuestion() {
        val state = HostEventState()
        assertTrue(state.apply(event(1, "question")))
        assertTrue(state.apply(event(2, "resolved", waiting = 0)))
        assertFalse(state.apply(event(1, "question")))
        assertFalse(state.apply(event(2, "question")))
        assertTrue(state.pending.isEmpty())
    }

    @Test fun previousHostEpochCannotRestoreOldWorkOrNotification() {
        val state = HostEventState()
        assertTrue(state.apply(event(1, "question", running = 1)))
        assertTrue(state.apply(event(1, epoch = "host-b", waiting = 0)))
        assertFalse(state.apply(event(999, "question", running = 1)))
        assertEquals(0, state.running)
        assertTrue(state.pending.isEmpty())
    }

    @Test fun resolutionBelongsToExactSessionAndCannotClearAnotherQuestion() {
        val state = HostEventState()
        state.apply(event(1, "approval"))
        state.apply(event(2, "resolved", session = "session-2"))
        assertEquals("session-1", state.pending["request-1"]?.sessionId)
        assertFalse(state.apply(event(3, "approval", session = "session-2")))
        assertTrue(state.apply(event(3, "resolved")))
        assertTrue(state.pending.isEmpty())
    }

    @Test fun blockingWaitAndStaleHeartbeatDropRunningCount() {
        val state = HostEventState()
        state.apply(event(1, running = 2, waiting = 0))
        assertEquals(2, state.running)
        state.apply(event(2, "question", running = 0, waiting = 1))
        assertEquals(0, state.running)
        state.expire()
        assertEquals(0, state.waiting)
        assertTrue(state.pending.isEmpty())
        assertFalse(state.apply(event(1, running = 2)))
    }

    @Test fun foregroundCompletionNeverReappearsAfterBackgrounding() {
        val state = HostEventState()
        state.setForeground(true)
        state.apply(event(1, "completed", waiting = 0))
        state.setForeground(false)
        state.apply(event(2, "completed", waiting = 0))
        assertTrue(state.completed.isEmpty())
    }

    @Test fun viewedBackgroundCompletionCannotBeReplayedOnAnotherBackgroundHeartbeat() {
        val state = HostEventState()
        state.apply(event(1, "completed", waiting = 0))
        assertEquals(1, state.completed.size)
        state.setForeground(true)
        state.setForeground(false)
        state.apply(event(2, "completed", waiting = 0))
        assertTrue(state.completed.isEmpty())
    }

    @Test fun consumedCompletionLifecycleCanBeResolvedAndNewEpochStartsFresh() {
        val state = HostEventState()
        state.setForeground(true)
        state.apply(event(1, "completed", waiting = 0))
        state.setForeground(false)
        state.apply(event(2, "resolved", session = "another-session", waiting = 0))
        state.apply(event(3, "completed", waiting = 0))
        assertTrue(state.completed.isEmpty())
        state.apply(event(4, "resolved", waiting = 0))
        state.apply(event(5, "completed", id = "next-turn", waiting = 0))
        assertEquals(1, state.completed.size)
        state.apply(event(1, "completed", epoch = "next-host", waiting = 0))
        assertEquals(setOf("request-1"), state.completed.keys)
    }

    @Test fun completionEvictionDoesNotCauseHeartbeatNotificationChurn() {
        val state = HostEventState()
        for (i in 1L..65) state.apply(event(i, "completed", id = "done-$i", session = "session-$i", waiting = 0))
        state.apply(event(66, "completed", id = "done-1", session = "session-1", waiting = 0))
        assertFalse(state.completed.containsKey("done-1"))
        assertEquals(64, state.completed.size)
    }

    @Test fun nextTurnResolutionCancelsOnlyItsCompletion() {
        val state = HostEventState()
        state.apply(event(1, "completed", waiting = 0))
        state.apply(event(2, "resolved", session = "session-2", waiting = 0))
        assertEquals(1, state.completed.size)
        state.apply(event(3, "resolved", waiting = 0))
        assertTrue(state.completed.isEmpty())
    }

    @Test fun repeatedCompletionAtLimitDoesNotEvictAnotherSession() {
        val state = HostEventState()
        for (i in 1L..64) state.apply(event(i, "completed", id = "done-$i", session = "session-$i", waiting = 0))
        state.apply(event(65, "completed", id = "done-64", session = "session-64", waiting = 0))
        assertEquals(64, state.completed.size)
        assertTrue(state.completed.containsKey("done-1"))
    }

    @Test fun foregroundViewingOneSessionDoesNotSuppressOtherSessionRequests() {
        val state = HostEventState()
        state.setForeground(true)
        state.apply(event(1, "question", session = "session-other"))
        assertEquals("session-other", state.pending["request-1"]?.sessionId)
        state.setForeground(false)
        assertEquals(1, state.pending.size)
    }
}
