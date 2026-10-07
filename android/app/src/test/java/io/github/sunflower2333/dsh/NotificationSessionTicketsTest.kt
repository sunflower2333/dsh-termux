package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class NotificationSessionTicketsTest {
    @Test fun ongoingNotificationCanRenewAnAlreadyConsumedNavigationTicket() {
        var count = 0
        val tickets = NotificationSessionTickets({ 100L }, { "ticket-${++count}" })
        val first = tickets.issue("same-session")
        assertTrue(tickets.contains(first))
        assertEquals("same-session", tickets.take(first))
        assertFalse(tickets.contains(first))
        val renewed = tickets.issue("same-session")
        assertTrue(tickets.contains(renewed))
        assertEquals("same-session", tickets.take(renewed))
    }

    @Test fun revokedCompletedNoticeTicketsCannotEvictStillVisibleQuestion() {
        var count = 0
        val tickets = NotificationSessionTickets({ 100L }, { "ticket-${++count}" })
        val question = tickets.issue("session-question")
        repeat(1024) { tickets.revoke(tickets.issue("session-notice-$it")) }
        assertEquals("session-question", tickets.take(question))
        assertNull(tickets.take("ticket-1025"))
    }
    @Test fun recreatedProcessCannotRouteAFormerTicketOrMissingTicket() {
        val oldProcess = NotificationSessionTickets({ 100L }, { "old-process-ticket" })
        val token = oldProcess.issue("session-owned")
        val newProcess = NotificationSessionTickets({ 100L }, { "new-process-ticket" })
        assertNull(newProcess.take(token))
        assertNull(newProcess.take(null))
        assertEquals("session-owned", oldProcess.take(token))
    }
    @Test fun onlyNativeIssuedOneUseTicketCanSelectExactSession() {
        val tickets = NotificationSessionTickets({ 100L }, { "ticket-a" })
        assertNull(tickets.take("session-other"))
        val token = tickets.issue("session-owned")
        assertEquals("session-owned", tickets.take(token))
        assertNull(tickets.take(token))
    }

    @Test fun staleTicketsAndOversizedExternalIntentsAreRejected() {
        var time = 0L
        val tickets = NotificationSessionTickets({ time }, { "ticket-a" })
        val token = tickets.issue("session-owned")
        assertNull(tickets.take("a".repeat(1000)))
        time = 24 * 60 * 60 * 1000L
        assertNull(tickets.take(token))
    }

    @Test fun boundedNativeRegistryEvictsOldestWithoutChangingNewestTarget() {
        var count = 0
        val tickets = NotificationSessionTickets({ 0L }, { "ticket-${++count}" })
        val oldest = tickets.issue("session-old")
        repeat(NotificationSessionTickets.MAX_TARGETS) { tickets.issue("session-$it") }
        assertNull(tickets.take(oldest))
        assertEquals("session-${NotificationSessionTickets.MAX_TARGETS - 1}", tickets.take("ticket-${NotificationSessionTickets.MAX_TARGETS + 1}"))
    }
}
