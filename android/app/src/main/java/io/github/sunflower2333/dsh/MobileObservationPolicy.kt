package io.github.sunflower2333.dsh

/** Slow text-model calls may retain a node, whose actual attributes are rechecked before use. */
internal object MobileObservationPolicy {
    const val NODE_TTL_MS = 300_000L
    const val SCREEN_TTL_MS = 30_000L

    fun fresh(issuedAt: Long, now: Long, nodeTarget: Boolean): Boolean =
        issuedAt >= 0 && now >= issuedAt && now - issuedAt <= if (nodeTarget) NODE_TTL_MS else SCREEN_TTL_MS

    /** Notification and background app events do not change an active app's node geometry. */
    fun changesActiveScreen(eventWindow: Int, activeWindow: Int?, windowChange: Boolean): Boolean =
        windowChange || (activeWindow != null && activeWindow >= 0 && eventWindow == activeWindow)
}
