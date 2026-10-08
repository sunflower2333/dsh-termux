package io.github.sunflower2333.dsh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.os.Build
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Handler
import android.os.PowerManager
import android.os.SystemClock
import java.security.MessageDigest
import org.json.JSONObject
import org.json.JSONArray
import java.util.Locale

internal data class RuntimeTaskStatus(val hostRunning: Boolean = false, val connected: Boolean = false,
    val running: Int = 0, val waiting: Int = 0, val awake: Boolean = false,
    val sessions: List<RuntimeSessionSummary> = emptyList(), val sessionsComplete: Boolean = false)

/** A foreground Service, rather than a throttled WebView, owns background task state. */
internal class RuntimeTaskNotifications(
    private val context: Context,
    private val handler: Handler,
    private val childAlive: () -> Boolean,
    private val updateForeground: (RuntimeTaskStatus) -> Unit,
) : AutoCloseable {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val wakeLock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:active-task").apply { setReferenceCounted(false) }
    private val state = HostEventState()
    private val notified = LinkedHashSet<String>()
    private val notices = LinkedHashSet<String>()
    private val notificationTickets = LinkedHashMap<String, String>()
    private val replyNotificationTickets = LinkedHashMap<String, String>()
    private val replyQueue = NotificationReplyQueue()
    private val progressNotifications = LinkedHashSet<String>()
    private val displayedReplyTickets = LinkedHashMap<String, String?>()
    private val noticeRateLimit = NativeNoticeRateLimit()
    private var lastHeartbeat = 0L
    private var connected = false
    private var foreground = false
    private var closed = false
    private val watchdog = Runnable {
        if (!closed && SystemClock.elapsedRealtime() - lastHeartbeat >= HEARTBEAT_TIMEOUT) {
            connected = false
            state.expire()
            releaseWakeLock()
            reconcileNotifications()
            publishStatus()
        }
    }

    init {
        // Android can retain these notifications after abrupt process death,
        // while their one-use in-memory session tickets are already gone.
        // A new native host must not expose a stale, unroutable request.
        for (notification in manager.activeNotifications) {
            if (TaskNotificationOwnership.isOwned(notification.id, notification.tag)) {
                manager.cancel(notification.tag, notification.id)
            }
        }
        manager.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL,
            DshUiLanguage.text(context, R.string.attention_channel), NotificationManager.IMPORTANCE_HIGH).apply {
            description = DshUiLanguage.text(context, R.string.attention_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(COMPLETION_CHANNEL,
            DshUiLanguage.text(context, R.string.completion_channel), NotificationManager.IMPORTANCE_LOW).apply {
            description = DshUiLanguage.text(context, R.string.completion_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL,
            DshUiLanguage.text(context, R.string.user_notice_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = DshUiLanguage.text(context, R.string.user_notice_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
    }

    fun accept(event: HostEvent): Boolean {
        if (closed || !childAlive()) return false
        if (!state.apply(event)) return false
        replyQueue.reconcile(state, event.replyAck)
        if (event.kind == "question" && event.noticeTitle != null) {
            val noticeId = "notice:${event.eventId}"
            if (notices.remove(noticeId)) cancelNotification(noticeId)
        }
        lastHeartbeat = SystemClock.elapsedRealtime()
        connected = true
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, HEARTBEAT_TIMEOUT)
        if (event.running > 0) {
            // Every real server heartbeat renews one bounded lease. Idle,
            // approval waits, disconnect and Service destruction release it.
            runCatching { wakeLock.acquire(WAKE_LEASE) }
        } else releaseWakeLock()
        reconcileNotifications()
        publishStatus()
        return true
    }

    fun acceptResponse(event: HostEvent): JSONObject {
        val accepted = accept(event)
        val result = JSONObject().put("accepted", accepted)
        if (accepted) {
            val queued = replyQueue.firstOrNull()
            if (queued != null) result.put("replies", JSONArray().put(JSONObject().put("ticket", queued.target.hostTicket).put("text", queued.text)))
        }
        return result
    }

    fun enqueueReply(ticket: String, text: String): Boolean {
        if (closed || !connected || !childAlive() || !NotificationReplyText.valid(text)) return false
        val target = NotificationReplyTargets.tickets.take(ticket) ?: return false
        val event = state.pending[target.eventId] ?: return false
        if (!replyQueue.offer(target, text, state)) return false
        runCatching { manager.notify(notificationTag(target.eventId), TASK_NOTIFICATION_ID, buildNotification(event)) }
        // The acknowledged same-UID event response carries this command until
        // the authoritative question resolves; duplicate host delivery is safe.
        return true
    }

    fun refreshLanguage() {
        if (closed) return
        manager.createNotificationChannel(NotificationChannel(ATTENTION_CHANNEL, DshUiLanguage.text(context, R.string.attention_channel), NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(COMPLETION_CHANNEL, DshUiLanguage.text(context, R.string.completion_channel), NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL, DshUiLanguage.text(context, R.string.user_notice_channel), NotificationManager.IMPORTANCE_DEFAULT))
        manager.createNotificationChannel(NotificationChannel(RUNNING_CHANNEL, DshUiLanguage.text(context, R.string.running_session_channel), NotificationManager.IMPORTANCE_LOW))
        for (id in notified) {
            val event = state.pending[id] ?: state.completed[id] ?: continue
            runCatching { manager.notify(notificationTag(id), TASK_NOTIFICATION_ID, buildNotification(event)) }
        }
        reconcileProgressNotifications()
        publishStatus()
    }

    fun setForeground(value: Boolean) {
        if (foreground == value || closed) return
        foreground = value
        state.setForeground(value)
        reconcileNotifications()
    }

    fun refreshHostState() = publishStatus()

    fun postNotice(notice: NativeNotice): JSONObject {
        fun rejected(reason: String) = JSONObject().put("posted", false).put("reason", reason)
        if (closed || !childAlive()) return rejected("host_unavailable")
        if (!manager.areNotificationsEnabled()) return rejected("notifications_disabled")
        if (manager.getNotificationChannel(NOTICE_CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) return rejected("channel_disabled")
        val now = SystemClock.elapsedRealtime()
        if (!noticeRateLimit.allowed(notice.sessionId, now)) return rejected("rate_limited")
        val id = "notice:${notice.eventId}"
        // Revoke the displaced notice before issuing its replacement, so a
        // full 128 attention + 64 completion + 64 notice + 64 progress set stays in bounds.
        while (id !in notices && notices.size >= 64) {
            val oldest = notices.first()
            cancelNotification(oldest)
            notices.remove(oldest)
        }
        val public = Notification.Builder(context, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(DshUiLanguage.text(context, R.string.app_name))
            .setContentText(DshUiLanguage.text(context, R.string.attention_private)).build()
        val notification = Notification.Builder(context, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(notice.title)
            .setContentText(notice.message)
            .setStyle(Notification.BigTextStyle().bigText(notice.message))
            .setContentIntent(sessionPendingIntent(notice.sessionId, id))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setTimeoutAfter(24 * 60 * 60 * 1000L)
            .build()
        try { manager.notify(notificationTag(id), TASK_NOTIFICATION_ID, notification) }
        catch (_: SecurityException) { revokeTicket(id); return rejected("notifications_disabled") }
        catch (_: RuntimeException) { revokeTicket(id); return rejected("host_unavailable") }
        notices.add(id)
        noticeRateLimit.posted(notice.sessionId, now)
        return JSONObject().put("posted", true)
    }

    private fun publishStatus() {
        val status = RuntimeTaskStatus(childAlive(), connected, state.running, state.waiting, wakeLock.isHeld, state.sessions, state.sessionsComplete)
        DshService.runtimeTaskStatus = status
        updateForeground(status)
    }

    private fun reconcileNotifications() {
        replyQueue.reconcile(state)
        reconcileProgressNotifications()
        val desired = LinkedHashMap<String, HostEvent>()
        // A question in another session still needs attention while the user
        // is viewing DSH. The payload contains no prompt or answer action.
        if (connected) desired.putAll(state.pending)
        if (!foreground) desired.putAll(state.completed)
        for (id in notified.toList()) if (id !in desired) {
            cancelNotification(id)
            notified.remove(id)
        }
        for ((id, event) in desired) {
            val channel = if (event.kind == "completed") COMPLETION_CHANNEL else ATTENTION_CHANNEL
            if (!manager.areNotificationsEnabled() || manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) {
                cancelNotification(id)
                notified.remove(id)
                continue
            }
            // Retain the original immutable PendingIntent and avoid a new
            // ticket/heads-up on every heartbeat of an unchanged request.
            if (id in notified && displayedReplyTickets[id] == event.replyTicket) continue
            try {
                manager.notify(notificationTag(id), TASK_NOTIFICATION_ID, buildNotification(event))
                notified.add(id)
                displayedReplyTickets[id] = event.replyTicket
            } catch (_: SecurityException) { revokeTicket(id) /* User can enable notifications in native settings. */ }
        }
    }

    private fun buildNotification(event: HostEvent): Notification {
        val pending = sessionPendingIntent(requireNotNull(event.sessionId), requireNotNull(event.eventId))
        val text = DshUiLanguage.text(context, when (event.kind) {
            "approval" -> R.string.attention_approval
            "question" -> R.string.attention_question
            else -> R.string.attention_completed
        })
        val channel = if (event.kind == "completed") COMPLETION_CHANNEL else ATTENTION_CHANNEL
        val public = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(DshUiLanguage.text(context, R.string.app_name))
            .setContentText(DshUiLanguage.text(context, R.string.attention_private))
            .build()
        val builder = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(event.noticeTitle ?: DshUiLanguage.text(context, R.string.app_name))
            .setContentText(event.noticeMessage ?: text)
            .setContentIntent(pending)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setCategory(if (event.kind == "completed") Notification.CATEGORY_STATUS else Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
        if (event.noticeMessage != null) builder.setStyle(Notification.BigTextStyle().bigText(event.noticeMessage))
        if (event.kind == "question" && event.replyTicket != null && !replyQueue.isSpent(event.replyTicket)) {
            val target = NotificationReplyTarget(event.epoch, event.sessionId!!, event.eventId!!, event.replyTicket)
            NotificationReplyTargets.tickets.revoke(replyNotificationTickets.remove(event.eventId))
            val ticket = NotificationReplyTargets.tickets.issue(target)
            replyNotificationTickets[event.eventId] = ticket
            val intent = Intent(context, NotificationReplyReceiver::class.java)
                .setAction(NotificationReplyReceiver.ACTION_REPLY)
                .setData(Uri.parse("dsh-native://reply/$ticket"))
                .putExtra(NotificationReplyReceiver.EXTRA_TICKET, ticket)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val reply = PendingIntent.getBroadcast(context, 0, intent, flags)
            val input = RemoteInput.Builder(NotificationReplyReceiver.RESULT_KEY)
                .setLabel(DshUiLanguage.text(context, R.string.notification_reply_label)).setAllowFreeFormInput(true).build()
            builder.addAction(Notification.Action.Builder(null as Icon?, DshUiLanguage.text(context, R.string.notification_reply_action), reply)
                .addRemoteInput(input).setAllowGeneratedReplies(false).setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY)
                .build())
        }
        return builder.build()
    }

    private fun sessionPendingIntent(sessionId: String, notificationId: String): PendingIntent {
        revokeTicket(notificationId)
        val ticket = NotificationSessionTargets.tickets.issue(sessionId)
        notificationTickets[notificationId] = ticket
        val open = Intent(context, MainActivity::class.java)
            .setAction(DshService.ACTION_OPEN_SESSION)
            .setData(Uri.parse("dsh-native://notification/$ticket"))
            .putExtra(NotificationSessionTargets.EXTRA_TICKET, ticket)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun notificationTag(id: String): String = TaskNotificationOwnership.TAG_PREFIX + MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8)).take(12).joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun revokeTicket(id: String) {
        NotificationSessionTargets.tickets.revoke(notificationTickets.remove(id))
        NotificationReplyTargets.tickets.revoke(replyNotificationTickets.remove(id))
        displayedReplyTickets.remove(id)
    }
    private fun cancelNotification(id: String) { manager.cancel(notificationTag(id), TASK_NOTIFICATION_ID); revokeTicket(id) }

    private fun reconcileProgressNotifications() {
        manager.createNotificationChannel(NotificationChannel(RUNNING_CHANNEL, DshUiLanguage.text(context, R.string.running_session_channel), NotificationManager.IMPORTANCE_LOW))
        val desired = if (connected && manager.areNotificationsEnabled() && manager.getNotificationChannel(RUNNING_CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE) state.sessions.associateBy { "running:${it.sessionId}" } else emptyMap()
        for (id in progressNotifications.toList()) if (id !in desired) { cancelNotification(id); progressNotifications.remove(id) }
        for ((id, summary) in desired) {
            fun number(value: Long?) = value?.toString() ?: "-"
            val rate = summary.tokensPerSecond?.let { String.format(Locale.ROOT, "%.1f", it) } ?: "-"
            val denominator = if (summary.inputTokens != null && summary.cachedInputTokens != null && summary.cacheWriteTokens != null) summary.inputTokens + summary.cachedInputTokens + summary.cacheWriteTokens else null
            val hit = if (denominator != null && denominator > 0) String.format(Locale.ROOT, "%.1f%%", summary.cachedInputTokens!!.toDouble() * 100 / denominator) else "-"
            val detail = DshUiLanguage.text(context, R.string.running_session_metrics, number(summary.turns), number(summary.steps), number(summary.sessionTokens),
                number(summary.inputTokens), number(summary.outputTokens), number(summary.totalTokens), number(summary.cachedInputTokens), number(summary.cacheWriteTokens),
                rate, number(summary.contextUsed), number(summary.contextCapacity), hit)
            val title = summary.name ?: DshUiLanguage.text(context, R.string.running_session_title, notificationTag(id).takeLast(5))
            val stateText = DshUiLanguage.text(context, when {
                summary.state == "waiting" -> R.string.running_session_waiting
                summary.activity?.phase == "thinking" -> R.string.live_thinking
                summary.activity?.phase == "responding" -> R.string.live_responding
                summary.activity?.phase == "tool" -> R.string.live_tool
                else -> R.string.running_session_running
            })
            val preview = summary.activity?.text?.takeIf { summary.state != "waiting" && it.isNotBlank() }
            val content = if (preview == null) stateText else "$stateText · $preview"
            val public = Notification.Builder(context, RUNNING_CHANNEL).setSmallIcon(R.drawable.ic_service)
                .setContentTitle(DshUiLanguage.text(context, R.string.app_name)).setContentText(DshUiLanguage.text(context, R.string.attention_private)).build()
            val open = if (id in progressNotifications) notificationTickets[id]?.takeIf { NotificationSessionTargets.tickets.contains(it) }?.let { existingSessionPendingIntent(it) } else null
            val builder = Notification.Builder(context, RUNNING_CHANNEL).setSmallIcon(R.drawable.ic_service)
                .setContentTitle(title).setContentText(content).setStyle(Notification.BigTextStyle().bigText("$content\n$detail"))
                .setContentIntent(open ?: sessionPendingIntent(summary.sessionId, id)).setGroup(RUNNING_GROUP)
                .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public).setOnlyAlertOnce(true).setOngoing(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
            RuntimeLiveUpdates.request(builder, DshUiLanguage.text(context, when {
                summary.state == "waiting" -> R.string.live_waiting_short
                summary.activity?.phase == "thinking" -> R.string.live_thinking_short
                summary.activity?.phase == "responding" -> R.string.live_responding_short
                else -> R.string.live_tool_short
            }))
            val value = builder.build()
            runCatching { manager.notify(notificationTag(id), TASK_NOTIFICATION_ID, value) }.onSuccess { progressNotifications.add(id) }.onFailure { revokeTicket(id) }
        }
    }

    private fun existingSessionPendingIntent(ticket: String): PendingIntent = PendingIntent.getActivity(context, 0,
        Intent(context, MainActivity::class.java).setAction(DshService.ACTION_OPEN_SESSION).setData(Uri.parse("dsh-native://notification/$ticket"))
            .putExtra(NotificationSessionTargets.EXTRA_TICKET, ticket).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun releaseWakeLock() { if (wakeLock.isHeld) runCatching { wakeLock.release() } }

    override fun close() {
        if (closed) return
        closed = true
        handler.removeCallbacks(watchdog)
        releaseWakeLock()
        for (id in notified) cancelNotification(id)
        for (id in notices) cancelNotification(id)
        for (id in progressNotifications) cancelNotification(id)
        for (ticket in replyNotificationTickets.values) NotificationReplyTargets.tickets.revoke(ticket)
        replyNotificationTickets.clear()
        progressNotifications.clear()
        replyQueue.clear()
        displayedReplyTickets.clear()
        for (ticket in notificationTickets.values) NotificationSessionTargets.tickets.revoke(ticket)
        notificationTickets.clear()
        notified.clear()
        notices.clear()
        state.completed.clear()
        state.expire()
        DshService.runtimeTaskStatus = RuntimeTaskStatus()
    }

    companion object {
        const val RUNNING_CHANNEL = "dsh-running-sessions"
        const val RUNNING_GROUP = "dsh-running-sessions-group"
        const val ATTENTION_CHANNEL = "dsh-attention"
        const val COMPLETION_CHANNEL = "dsh-completed"
        const val NOTICE_CHANNEL = "dsh-user-notices"
        const val TASK_NOTIFICATION_ID = TaskNotificationOwnership.ID
        private const val HEARTBEAT_TIMEOUT = 45_000L
        private const val WAKE_LEASE = 60_000L
    }
}
