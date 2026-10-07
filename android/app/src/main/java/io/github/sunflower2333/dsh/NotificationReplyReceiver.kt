package io.github.sunflower2333.dsh

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Only Android's exact pending action can submit a bounded freeform answer. */
class NotificationReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY || intent.component?.className != javaClass.name) return
        val ticket = intent.getStringExtra(EXTRA_TICKET) ?: return
        if (intent.data?.toString() != "dsh-native://reply/$ticket") return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(RESULT_KEY)?.toString() ?: return
        if (!NotificationReplyText.valid(text)) return
        val completion = goAsync()
        DshService.submitNotificationReply(ticket, text) { completion.finish() }
    }
    companion object {
        const val ACTION_REPLY = "io.github.sunflower2333.dsh.NOTIFICATION_REPLY"
        const val EXTRA_TICKET = "dsh.notification.reply.ticket"
        const val RESULT_KEY = "dsh.notification.reply.text"
    }
}

internal object NotificationReplyText {
    fun valid(text: String): Boolean {
        if (text.isBlank() || text.length > 4096 || '\u0000' in text) return false
        var index = 0
        while (index < text.length) {
            val char = text[index++]
            if (Character.isHighSurrogate(char)) {
                if (index >= text.length || !Character.isLowSurrogate(text[index++])) return false
            } else if (Character.isLowSurrogate(char)) return false
        }
        return true
    }
}
