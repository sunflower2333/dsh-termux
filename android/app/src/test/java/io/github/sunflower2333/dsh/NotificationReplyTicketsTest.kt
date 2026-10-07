package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class NotificationReplyTicketsTest {
    private fun target() = NotificationReplyTarget("epoch-1", "session-1", "question-1", "host-ticket-1")
    @Test fun oneUseGrantRetainsExactCurrentQuestionOwnership() {
        val tickets = NotificationReplyTickets({ 0L }, { "native-token" })
        assertNull(tickets.take("forged"))
        val token = tickets.issue(target())
        assertEquals(target(), tickets.take(token))
        assertNull(tickets.take(token))
    }
    @Test fun expiryRecreationAndRevocationNeverRouteAReply() {
        var now = 0L
        val tickets = NotificationReplyTickets({ now }, { "token" })
        val expired = tickets.issue(target()); now = 30 * 60 * 1000L
        assertNull(tickets.take(expired))
        val fresh = tickets.issue(target()); tickets.revoke(fresh); assertNull(tickets.take(fresh))
        assertNull(NotificationReplyTickets({ now }).take(fresh))
        assertNull(tickets.take("x".repeat(1000)))
    }
    @Test fun separateBoundedReplyRegistryKeepsNewestValidTarget() {
        var count = 0
        val tickets = NotificationReplyTickets({ 0L }, { "token-${++count}" })
        val old = tickets.issue(target())
        repeat(256) { tickets.issue(target().copy(eventId = "question-$it")) }
        assertNull(tickets.take(old))
        assertEquals("question-255", tickets.take("token-257")?.eventId)
    }
    @Test fun boundedWellFormedFreeformTextIncludesMultilineAndRejectsMalformedInput() {
        assertTrue(NotificationReplyText.valid("one\ntwo"))
        assertTrue(NotificationReplyText.valid("回答 😀"))
        assertFalse(NotificationReplyText.valid(" "))
        assertFalse(NotificationReplyText.valid("a\u0000b"))
        assertFalse(NotificationReplyText.valid("x".repeat(4097)))
        assertFalse(NotificationReplyText.valid("\ud800"))
        assertFalse(NotificationReplyText.valid("\udc00"))
    }
}
