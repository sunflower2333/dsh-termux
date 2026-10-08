package io.github.sunflower2333.dsh

/** SDK metrics and an optional bounded preview of current assistant output. */
internal data class RuntimeSessionSummary(val sessionId: String, val name: String?, val state: String,
    val turns: Long?, val steps: Long?, val inputTokens: Long?, val outputTokens: Long?,
    val totalTokens: Long?, val cachedInputTokens: Long?, val cacheWriteTokens: Long?,
    val sessionTokens: Long?, val tokensPerSecond: Double?, val contextUsed: Long?, val contextCapacity: Long?,
    val activity: RuntimeSessionActivity? = null) {
    companion object {
        private val fields = setOf("sessionId", "name", "state", "turns", "steps", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "sessionTokens", "tokensPerSecond", "contextUsed", "contextCapacity")
        fun parse(value: Map<*, *>): RuntimeSessionSummary {
            require(value.keys.all { it in fields || it == "activity" } && value.keys.containsAll(fields)) { "Invalid metric fields" }
            val id = value["sessionId"] as? String ?: throw IllegalArgumentException("Invalid metric session")
            require(Regex("[A-Za-z0-9._:-]{1,160}").matches(id)) { "Invalid metric session" }
            val name = value["name"] as? String
            require(value["name"] == null || (name != null && name.length in 1..160 && name.isNotBlank() && name.none { it.code < 32 || it.code == 127 })) { "Invalid metric name" }
            val state = value["state"] as? String
            require(state == "running" || state == "waiting") { "Invalid metric state" }
            fun number(key: String): Long? {
                val raw = value[key] ?: return null
                val number = when (raw) { is Long -> raw; is Int -> raw.toLong(); else -> throw IllegalArgumentException("Invalid metric counter") }
                require(number in 0..9_007_199_254_740_991L) { "Invalid metric counter" }
                return number
            }
            val rate = value["tokensPerSecond"]?.let { (it as? Number)?.toDouble() ?: throw IllegalArgumentException("Invalid token rate") }
            require(rate == null || (rate.isFinite() && rate in 0.0..1.0e12)) { "Invalid token rate" }
            val capacity = number("contextCapacity")
            require(capacity == null || capacity > 0) { "Invalid context capacity" }
            val activity = if (value.containsKey("activity")) RuntimeSessionActivity.parse(value["activity"] as? Map<*, *> ?: throw IllegalArgumentException("Invalid live activity")) else null
            return RuntimeSessionSummary(id, name, state!!, number("turns"), number("steps"), number("inputTokens"), number("outputTokens"), number("totalTokens"), number("cachedInputTokens"), number("cacheWriteTokens"), number("sessionTokens"), rate, number("contextUsed"), capacity, activity)
        }
    }
}

internal data class RuntimeSessionActivity(val phase: String, val text: String) {
    companion object {
        fun parse(value: Map<*, *>): RuntimeSessionActivity {
            require(value.keys == setOf("phase", "text")) { "Invalid live activity fields" }
            val phase = value["phase"] as? String
            val text = value["text"] as? String
            require(phase in setOf("thinking", "responding", "tool") && text != null &&
                text.codePointCount(0, text.length) <= 240 && text.none { it.code < 32 || it.code == 127 }) { "Invalid live activity" }
            return RuntimeSessionActivity(phase!!, text!!)
        }
    }
}
