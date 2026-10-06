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
    const val CONFIGURATION_PATH = "/__dsh_android__/open-configuration"

    /** One native action, accepted only from the current authenticated DSH page. */
    fun isConfigurationRequest(url: String, pageUrl: String?, readyUrl: String?): Boolean {
        if (!isCurrentOrigin(url, readyUrl) || !isCurrentOrigin(pageUrl, readyUrl)) return false
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        return uri.rawPath == CONFIGURATION_PATH && uri.rawQuery == null && uri.rawFragment == null
    }

    /** Loopback cookies do not isolate ports; keep this WebView on its DSH host. */
    fun isCurrentOrigin(url: String?, readyUrl: String?): Boolean {
        if (url == null || readyUrl == null || !LocalUrl.isAllowed(url) || !LocalUrl.isAllowed(readyUrl)) return false
        val target = URI(url)
        val ready = URI(readyUrl)
        return target.scheme == ready.scheme && target.host == ready.host && target.port == ready.port
    }

    /** Image/subresource requests and POST navigations bypass navigation callbacks. */
    fun blocksForeignLoopbackRequest(url: String, readyUrl: String?): Boolean {
        val target = runCatching { URI(url) }.getOrNull() ?: return false
        val loopbackHttp = target.host == "127.0.0.1" &&
            target.scheme?.lowercase(Locale.ROOT) in setOf("http", "https")
        return loopbackHttp && !isCurrentOrigin(url, readyUrl)
    }

    fun classify(url: String, readyUrl: String?): WebNavigationDecision {
        if (isCurrentOrigin(url, readyUrl)) return WebNavigationDecision.INTERNAL

        val scheme = runCatching { URI(url).scheme?.lowercase(Locale.ROOT) }.getOrNull()
        return when (scheme) {
            "http", "https" -> WebNavigationDecision.EXTERNAL_HTTP
            else -> WebNavigationDecision.BLOCKED
        }
    }
}
