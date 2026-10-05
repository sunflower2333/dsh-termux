package io.github.sunflower2333.dsh

import java.net.URI
import java.util.Locale

/** The action the native shell should take for a WebView navigation. */
internal enum class WebNavigationDecision {
    /** Keep the request inside the DSH loopback WebView. */
    INTERNAL,

    /** Hand an http(s) URL to the user's browser without replacing this UI. */
    EXTERNAL_HTTP,

    /** Block schemes that the app cannot safely hand to another application. */
    BLOCKED,
}

/** URL classification kept free of Android framework types so it can be unit tested. */
internal object WebNavigation {
    fun classify(url: String): WebNavigationDecision {
        if (LocalUrl.isAllowed(url)) return WebNavigationDecision.INTERNAL

        val scheme = runCatching { URI(url).scheme?.lowercase(Locale.ROOT) }.getOrNull()
        return when (scheme) {
            "http", "https" -> WebNavigationDecision.EXTERNAL_HTTP
            else -> WebNavigationDecision.BLOCKED
        }
    }
}
