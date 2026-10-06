package io.github.sunflower2333.dsh

/** Only aggregate task state and opaque IDs cross the native notification bridge. */
internal data class HostEvent(
    val epoch: String,
    val sequence: Long,
    val running: Int,
    val waiting: Int,
    val sessionId: String? = null,
    val kind: String? = null,
    val eventId: String? = null,
)

internal object HostEventProtocol {
    const val PATH = "/android/events"
    private val fields = setOf("version", "epoch", "sequence", "running", "waiting", "sessionId", "kind", "eventId")
    private val epochPattern = Regex("[A-Za-z0-9_-]{1,64}")
    private val idPattern = Regex("[A-Za-z0-9._:-]{1,160}")

    fun parse(values: Map<String, Any?>): HostEvent {
        require(values.keys.all { it in fields }) { "Unknown host event field" }
        require(integer(values["version"]) == 1L) { "Unsupported host event version" }
        val epoch = values["epoch"] as? String ?: throw IllegalArgumentException("Missing host epoch")
        require(epochPattern.matches(epoch)) { "Invalid host epoch" }
        val sequence = integer(values["sequence"])
        require(sequence in 1..9_007_199_254_740_991L) { "Invalid host sequence" }
        val running = integer(values["running"])
        val waiting = integer(values["waiting"])
        require(running in 0..1000 && waiting in 0..1000) { "Invalid host task count" }
        val kind = values["kind"] as? String
        val sessionId = values["sessionId"] as? String
        val eventId = values["eventId"] as? String
        if (kind == null) {
            require(!values.containsKey("kind") && !values.containsKey("sessionId") && !values.containsKey("eventId")) { "Incomplete host event" }
        } else {
            require(kind in setOf("approval", "question", "resolved", "completed")) { "Invalid host event kind" }
            require(sessionId != null && idPattern.matches(sessionId)) { "Invalid host session" }
            require(eventId != null && idPattern.matches(eventId)) { "Invalid host event ID" }
        }
        return HostEvent(epoch, sequence, running.toInt(), waiting.toInt(), sessionId, kind, eventId)
    }

    private fun integer(value: Any?): Long = when (value) {
        is Byte -> value.toLong()
        is Short -> value.toLong()
        is Int -> value.toLong()
        is Long -> value
        else -> throw IllegalArgumentException("Host event integer required")
    }
}

/** Sequence checks make a delayed event incapable of reviving a resolved notification. */
internal class HostEventState {
    private val seenEpochs = LinkedHashSet<String>()
    var epoch: String? = null
        private set
    var sequence: Long = 0
        private set
    var running: Int = 0
        private set
    var waiting: Int = 0
        private set
    val pending = LinkedHashMap<String, HostEvent>()
    val completed = LinkedHashMap<String, HostEvent>()
    private val suppressedCompletions = LinkedHashMap<String, String>()
    private var completionSuppressionOverflow = false
    private var foreground = false

    fun apply(event: HostEvent): Boolean {
        if (event.epoch != epoch) {
            if (event.epoch in seenEpochs || seenEpochs.size >= 64) return false
            seenEpochs.add(event.epoch)
            epoch = event.epoch
            sequence = 0
            pending.clear()
            completed.clear()
            suppressedCompletions.clear()
            completionSuppressionOverflow = false
        }
        if (event.sequence <= sequence) return false
        if (event.kind in setOf("approval", "question") && pending[event.eventId]?.let {
                it.sessionId != event.sessionId || it.kind != event.kind
            } == true) return false
        if (event.kind in setOf("approval", "question") && event.eventId !in pending && pending.size >= 128) return false
        sequence = event.sequence
        running = event.running
        waiting = event.waiting
        when (event.kind) {
            "approval", "question" -> pending[event.eventId!!] = event
            "resolved" -> {
                if (pending[event.eventId]?.sessionId == event.sessionId) pending.remove(event.eventId)
                if (completed[event.eventId]?.sessionId == event.sessionId) completed.remove(event.eventId)
                if (suppressedCompletions[event.eventId] == event.sessionId) suppressedCompletions.remove(event.eventId)
            }
            "completed" -> {
                val id = event.eventId!!
                val session = event.sessionId!!
                if (foreground || completionSuppressionOverflow || id in suppressedCompletions) suppressCompletion(id, session)
                else {
                    while (id !in completed && completed.size >= 64) {
                        val oldest = completed.remove(completed.keys.first())!!
                        suppressCompletion(oldest.eventId!!, oldest.sessionId!!)
                    }
                    if (!completionSuppressionOverflow) completed[id] = event
                }
            }
        }
        return true
    }

    fun expire() {
        running = 0
        waiting = 0
        pending.clear()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        if (value) {
            for (event in completed.values) suppressCompletion(event.eventId!!, event.sessionId!!)
            completed.clear()
        }
    }

    private fun suppressCompletion(id: String, session: String) {
        if (id in suppressedCompletions) return
        if (suppressedCompletions.size < 1024) suppressedCompletions[id] = session
        else {
            // An abnormal producer retaining thousands of consumed events
            // cannot grow native memory or revive old completion alerts.
            // Current questions/approvals and work tracking remain active.
            completionSuppressionOverflow = true
        }
    }
}
