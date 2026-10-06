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
        while (targets.size >= 256) targets.remove(targets.keys.first())
        return newToken().also { targets[it] = Target(sessionId, now() + 24 * 60 * 60 * 1000L) }
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
}

internal object NotificationSessionTargets {
    const val EXTRA_TICKET = "dsh.notification.ticket"
    val tickets = NotificationSessionTickets(android.os.SystemClock::elapsedRealtime)
}
