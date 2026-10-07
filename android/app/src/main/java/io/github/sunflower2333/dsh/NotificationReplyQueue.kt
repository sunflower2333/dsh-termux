package io.github.sunflower2333.dsh

internal data class NotificationQueuedReply(val target: NotificationReplyTarget, val text: String)

/** Retry delivery is private and bounded; ACK retires a command, never revives its action. */
internal class NotificationReplyQueue {
    private val queued = LinkedHashMap<String, NotificationQueuedReply>()
    private val spent = LinkedHashSet<String>()
    fun offer(target: NotificationReplyTarget, text: String, state: HostEventState): Boolean {
        val event = state.pending[target.eventId] ?: return false
        if (!NotificationReplyText.valid(text) || target.epoch != state.epoch || target.sessionId != event.sessionId || target.hostTicket != event.replyTicket || target.hostTicket in spent || target.eventId in queued || queued.size >= 128) return false
        queued[target.eventId] = NotificationQueuedReply(target, text)
        spent.add(target.hostTicket)
        return true
    }
    fun firstOrNull(): NotificationQueuedReply? = queued.values.firstOrNull()
    fun isSpent(hostTicket: String): Boolean = hostTicket in spent
    fun reconcile(state: HostEventState, acknowledgement: String? = null) {
        val current = state.pending.values.mapNotNull(HostEvent::replyTicket).toSet()
        spent.retainAll(current)
        queued.entries.removeAll { (_, reply) -> reply.target.epoch != state.epoch || state.pending[reply.target.eventId]?.replyTicket != reply.target.hostTicket || acknowledgement == reply.target.hostTicket }
    }
    fun clear() { queued.clear(); spent.clear() }
}
