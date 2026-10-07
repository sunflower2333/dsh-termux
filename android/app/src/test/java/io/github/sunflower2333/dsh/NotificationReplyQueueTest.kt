package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class NotificationReplyQueueTest {
    private fun pending(state: HostEventState, seq: Long = 1, epoch: String = "host", ticket: String = "ticket") {
        assertTrue(state.apply(HostEvent(epoch, seq, 0, 1, "session", "question", "question", ticket)))
    }
    private fun target() = NotificationReplyTarget("host", "session", "question", "ticket")
    @Test fun exactQuestionIsOneUseAndPrivateCommandIsRetriedUntilAck() {
        val state = HostEventState(); pending(state)
        val queue = NotificationReplyQueue()
        assertFalse(queue.offer(target().copy(sessionId = "other"), "reply", state))
        assertFalse(queue.offer(target().copy(epoch = "old"), "reply", state))
        assertFalse(queue.offer(target().copy(hostTicket = "forged"), "reply", state))
        assertTrue(queue.offer(target(), "actual user text", state))
        assertEquals("actual user text", queue.firstOrNull()?.text)
        queue.reconcile(state); assertNotNull(queue.firstOrNull())
        assertFalse(queue.offer(target(), "duplicate", state))
        queue.reconcile(state, "ticket")
        assertNull(queue.firstOrNull()); assertTrue(queue.isSpent("ticket"))
        assertFalse(queue.offer(target(), "duplicate after ACK", state))
    }
    @Test fun ResolutionAndNewEpochRemoveOldQueuedRepliesWithoutAffectingAnotherQuestion() {
        val state = HostEventState(); pending(state)
        val queue = NotificationReplyQueue(); assertTrue(queue.offer(target(), "reply", state))
        state.apply(HostEvent("host", 2, 0, 0, "session", "resolved", "question")); queue.reconcile(state)
        assertNull(queue.firstOrNull()); assertFalse(queue.isSpent("ticket"))
        pending(state, 3); assertTrue(queue.offer(target(), "another", state))
        pending(state, 1, "new-host", "new-ticket"); queue.reconcile(state)
        assertNull(queue.firstOrNull()); assertFalse(queue.offer(target(), "old action", state))
    }
    @Test fun ExpiryOrDisconnectAndTicketReplacementRevokePendingDelivery() {
        val state = HostEventState(); pending(state)
        val queue = NotificationReplyQueue(); assertTrue(queue.offer(target(), "reply", state))
        pending(state, 2, ticket = "replacement"); queue.reconcile(state)
        assertNull(queue.firstOrNull()); assertFalse(queue.isSpent("ticket"))
        assertTrue(queue.offer(target().copy(hostTicket = "replacement"), "fresh user reply", state))
        state.expire(); queue.reconcile(state); assertNull(queue.firstOrNull())
    }
}
