package io.github.sunflower2333.dsh

import java.util.UUID

/** Exported launcher intents cannot select an arbitrary session: only native-issued tickets can. */
internal class NotificationSessionTickets(
    private val now: () -> Long,
    private val newToken: () -> String = { UUID.randomUUID().toString() },
) {
    private data class Target(val sessionId: String, val expires: Long)
    private val targets = LinkedHashMap<String, Target>()

    @Synchronized fun issue(sessionId: String): String {
        prune()
        while (targets.size >= MAX_TARGETS) targets.remove(targets.keys.first())
        return newToken().also { targets[it] = Target(sessionId, now() + 24 * 60 * 60 * 1000L) }
    }

    @Synchronized fun contains(token: String?): Boolean {
        prune()
        return token != null && token.length <= 64 && token in targets
    }

    @Synchronized fun take(token: String?): String? {
        prune()
        if (token == null || token.length > 64) return null
        return targets.remove(token)?.sessionId
    }

    @Synchronized fun revoke(token: String?) { if (token != null) targets.remove(token) }

    private fun prune() {
        val time = now()
        targets.entries.removeAll { it.value.expires <= time }
    }

    companion object { const val MAX_TARGETS = 320 }
}

internal object NotificationSessionTargets {
    const val EXTRA_TICKET = "dsh.notification.ticket"
    val tickets = NotificationSessionTickets(android.os.SystemClock::elapsedRealtime)
}

internal data class NotificationReplyTarget(val epoch: String, val sessionId: String,
    val eventId: String, val hostTicket: String)

/** Separate from tap routing: reply grants are one-use and current-question bound. */
internal class NotificationReplyTickets(private val now: () -> Long,
    private val newToken: () -> String = { UUID.randomUUID().toString() }) {
    private data class Entry(val target: NotificationReplyTarget, val expires: Long)
    private val entries = LinkedHashMap<String, Entry>()
    @Synchronized fun issue(target: NotificationReplyTarget): String {
        prune()
        while (entries.size >= 256) entries.remove(entries.keys.first())
        return newToken().also { entries[it] = Entry(target, now() + 30 * 60 * 1000L) }
    }
    @Synchronized fun take(token: String?): NotificationReplyTarget? {
        prune()
        if (token == null || token.length > 64) return null
        return entries.remove(token)?.target
    }
    @Synchronized fun revoke(token: String?) { if (token != null) entries.remove(token) }
    private fun prune() { val time = now(); entries.entries.removeAll { it.value.expires <= time } }
}

internal object NotificationReplyTargets {
    val tickets = NotificationReplyTickets(android.os.SystemClock::elapsedRealtime)
}
