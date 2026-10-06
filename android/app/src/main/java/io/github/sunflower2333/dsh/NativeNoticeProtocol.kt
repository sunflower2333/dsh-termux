package io.github.sunflower2333.dsh

internal data class NativeNotice(val sessionId: String, val eventId: String, val title: String, val message: String)

/** Explicit model-requested notice, separate from automatic host-state replay. */
internal object NativeNoticeProtocol {
    const val PATH = "/android/notify"
    private val fields = setOf("version", "sessionId", "eventId", "title", "message")
    private val idPattern = Regex("[A-Za-z0-9._:-]{1,160}")

    fun parse(values: Map<String, Any?>): NativeNotice {
        require(values.keys == fields) { "Invalid native notice fields" }
        require(values["version"] == 1 || values["version"] == 1L) { "Unsupported native notice version" }
        fun id(name: String): String {
            val value = values[name] as? String ?: throw IllegalArgumentException("Invalid native notice ID")
            require(idPattern.matches(value)) { "Invalid native notice ID" }
            return value
        }
        return NativeNotice(id("sessionId"), id("eventId"), text(values["title"], 64), text(values["message"], 1024))
    }

    private fun text(raw: Any?, limit: Int): String {
        val value = raw as? String ?: throw IllegalArgumentException("Native notice text required")
        require(value.isNotBlank() && value.length <= limit && '\u0000' !in value) { "Invalid native notice text" }
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character.isHighSurrogate()) {
                require(index + 1 < value.length && value[index + 1].isLowSurrogate()) { "Invalid native notice text" }
                index += 2
            } else {
                require(!character.isLowSurrogate()) { "Invalid native notice text" }
                index++
            }
        }
        return value
    }
}

/** Limits explicit notices without storing their title/message. */
internal class NativeNoticeRateLimit {
    private var lastGlobal: Long? = null
    private val lastSession = LinkedHashMap<String, Long>()
    fun allowed(session: String, now: Long): Boolean =
        lastGlobal?.let { now - it < 1_000 } != true && lastSession[session]?.let { now - it < 10_000 } != true

    fun posted(session: String, now: Long) {
        lastGlobal = now
        if (session !in lastSession) while (lastSession.size >= 256) lastSession.remove(lastSession.keys.first())
        lastSession[session] = now
    }
}
