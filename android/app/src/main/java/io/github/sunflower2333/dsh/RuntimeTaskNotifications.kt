package io.github.sunflower2333.dsh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.PowerManager
import android.os.SystemClock
import java.security.MessageDigest
import org.json.JSONObject

internal data class RuntimeTaskStatus(val hostRunning: Boolean = false, val connected: Boolean = false,
    val running: Int = 0, val waiting: Int = 0, val awake: Boolean = false)

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
            context.getString(R.string.attention_channel), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.attention_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(COMPLETION_CHANNEL,
            context.getString(R.string.completion_channel), NotificationManager.IMPORTANCE_LOW).apply {
            description = context.getString(R.string.completion_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL,
            context.getString(R.string.user_notice_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = context.getString(R.string.user_notice_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        })
    }

    fun accept(event: HostEvent): Boolean {
        if (closed || !childAlive()) return false
        if (!state.apply(event)) return false
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
        // full 128 attention + 64 completion + 64 notice set stays in bounds.
        while (id !in notices && notices.size >= 64) {
            val oldest = notices.first()
            cancelNotification(oldest)
            notices.remove(oldest)
        }
        val public = Notification.Builder(context, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.attention_private)).build()
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
        val status = RuntimeTaskStatus(childAlive(), connected, state.running, state.waiting, wakeLock.isHeld)
        DshService.runtimeTaskStatus = status
        updateForeground(status)
    }

    private fun reconcileNotifications() {
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
            if (id in notified) continue
            try {
                manager.notify(notificationTag(id), TASK_NOTIFICATION_ID, buildNotification(event))
                notified.add(id)
            } catch (_: SecurityException) { revokeTicket(id) /* User can enable notifications in native settings. */ }
        }
    }

    private fun buildNotification(event: HostEvent): Notification {
        val pending = sessionPendingIntent(requireNotNull(event.sessionId), requireNotNull(event.eventId))
        val text = context.getString(when (event.kind) {
            "approval" -> R.string.attention_approval
            "question" -> R.string.attention_question
            else -> R.string.attention_completed
        })
        val channel = if (event.kind == "completed") COMPLETION_CHANNEL else ATTENTION_CHANNEL
        val public = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.attention_private))
            .build()
        return Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_service)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(pending)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setCategory(if (event.kind == "completed") Notification.CATEGORY_STATUS else Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
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

    private fun revokeTicket(id: String) { NotificationSessionTargets.tickets.revoke(notificationTickets.remove(id)) }
    private fun cancelNotification(id: String) { manager.cancel(notificationTag(id), TASK_NOTIFICATION_ID); revokeTicket(id) }

    private fun releaseWakeLock() { if (wakeLock.isHeld) runCatching { wakeLock.release() } }

    override fun close() {
        if (closed) return
        closed = true
        handler.removeCallbacks(watchdog)
        releaseWakeLock()
        for (id in notified) cancelNotification(id)
        for (id in notices) cancelNotification(id)
        for (ticket in notificationTickets.values) NotificationSessionTargets.tickets.revoke(ticket)
        notificationTickets.clear()
        notified.clear()
        notices.clear()
        state.completed.clear()
        state.expire()
        DshService.runtimeTaskStatus = RuntimeTaskStatus()
    }

    companion object {
        const val ATTENTION_CHANNEL = "dsh-attention"
        const val COMPLETION_CHANNEL = "dsh-completed"
        const val NOTICE_CHANNEL = "dsh-user-notices"
        const val TASK_NOTIFICATION_ID = TaskNotificationOwnership.ID
        private const val HEARTBEAT_TIMEOUT = 45_000L
        private const val WAKE_LEASE = 60_000L
    }
}
