package io.github.sunflower2333.dsh

import java.net.URI

/** Android host launch policy. Stores and exposes only a port, never credentials. */
internal object HostPortPolicy {
    const val PREFERENCE_FILE = "dsh-host"
    const val PREFERENCE_PORT = "http-port"

    data class LaunchPlan(val arguments: List<String>, val rememberedPort: Int?)

    /** Only replace the manifest's single explicit automatic port option. */
    fun plan(arguments: List<String>, rememberedPort: Int?): LaunchPlan {
        val original = arguments.toList()
        val positions = original.indices.filter { original[it] == "--port" }
        val index = positions.singleOrNull()
        if (index == null || original.getOrNull(index + 1) != "0" ||
            rememberedPort == null || rememberedPort !in 1..65535) return LaunchPlan(original, null)
        val preferred = original.toMutableList()
        preferred[index + 1] = rememberedPort.toString()
        return LaunchPlan(preferred, rememberedPort)
    }

    /** A successful READY still has to satisfy the existing host and path rules. */
    fun readyPort(url: String, expectedPath: String): Int? {
        if (!LocalUrl.isAllowed(url, expectedPath)) return null
        return URI(url).port
    }

    /** Match Node's actual listen error, not arbitrary plugin output mentioning its name. */
    fun isBindConflict(line: String, requestedPort: Int?): Boolean {
        if (requestedPort == null || requestedPort !in 1..65535) return false
        val match = BIND_CONFLICT.matchEntire(line.trim()) ?: return false
        return match.groupValues[1].toIntOrNull() == requestedPort
    }

    fun retryAutomaticPort(
        rememberedPort: Int?,
        fallbackUsed: Boolean,
        readySeen: Boolean,
        exitCode: Int,
        bindConflict: Boolean,
        cancelled: Boolean,
    ): Boolean = rememberedPort != null && rememberedPort in 1..65535 && !fallbackUsed &&
        !readySeen && exitCode != 0 && bindConflict && !cancelled

    private val BIND_CONFLICT = Regex(
        "(?:Error: )?listen EADDRINUSE: address already in use 127\\.0\\.0\\.1:([0-9]{1,5})",
    )
}
