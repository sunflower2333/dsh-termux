package io.github.sunflower2333.dsh

/** Slow text-model calls may retain a node, whose actual attributes are rechecked before use. */
internal object MobileObservationPolicy {
    const val TTL_MS = 300_000L

    // Model inference is outside the native RPC deadline. Screen gestures still
    // revalidate the foreground window, display and content revision at execution.
    fun fresh(issuedAt: Long, now: Long): Boolean =
        issuedAt >= 0 && now >= issuedAt && now - issuedAt <= TTL_MS

    fun invalidReason(sameId: Boolean, sameSession: Boolean, fresh: Boolean,
        sameWindow: Boolean, sameRevision: Boolean, strictRevision: Boolean): String? = when {
        !sameId -> "observation_replaced"
        !sameSession -> "observation_session"
        !fresh -> "observation_expired"
        !sameWindow -> "observation_window_changed"
        strictRevision && !sameRevision -> "observation_screen_changed"
        else -> null
    }

    // Read-only observation may encounter an activity/IME transition. Never
    // retry actions, permission failures, or an observation beyond this bound.
    fun observationRetryDelay(code: String?, screenshot: Boolean, retries: Int): Long? =
        if (retries in 0..1 && code in setOf("no_window", "observation_window_changed"))
            if (screenshot) 1_100L else 150L
        else null

    /** Notification and background app events do not change an active app's node geometry. */
    fun changesActiveScreen(eventWindow: Int, activeWindow: Int?, windowChange: Boolean): Boolean =
        windowChange || (activeWindow != null && activeWindow >= 0 && eventWindow == activeWindow)
}
