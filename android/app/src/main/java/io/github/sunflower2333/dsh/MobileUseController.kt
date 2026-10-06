package io.github.sunflower2333.dsh

import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject
import java.util.UUID

/** App-local consent. System accessibility permission alone never starts agent control. */
object MobileUseController {
    private val lock = Any()
    private var service: MobileAccessibilityService? = null
    private var session: String? = null
    private var generation = 0L
    private var reason = "user_paused"
    @Volatile private var currentPackage: String? = null

    fun status(context: Context): JSONObject {
        val enabled = isEnabled(context)
        val locked = isDeviceLocked(context)
        if (locked) pause("device_locked")
        return synchronized(lock) {
            val connected = service != null
            JSONObject().put("enabled", enabled).put("connected", connected)
                .put("active", enabled && connected && !locked && session != null)
                .put("sessionId", session ?: JSONObject.NULL)
                .put("reason", when {
                    !enabled -> "disabled"
                    !connected -> "disconnected"
                    locked -> "device_locked"
                    reason == "device_locked" -> "user_paused"
                    else -> reason
                }).put("currentPackage", currentPackage ?: JSONObject.NULL)
        }
    }

    /** Called by a genuine native UI gesture, never by a WebView or tool RPC. */
    fun resumeFromUser(context: Context): JSONObject {
        synchronized(lock) {
            generation++
            session = if (service != null && isEnabled(context) && !isDeviceLocked(context)) UUID.randomUUID().toString() else null
            reason = if (session == null) "user_paused" else "user_grant"
            service?.invalidateObservations()
        }
        return status(context)
    }

    fun pause(reason: String) {
        synchronized(lock) {
            generation++
            session = null
            this.reason = reason
            service?.invalidateObservations()
        }
    }

    internal fun attach(value: MobileAccessibilityService) {
        synchronized(lock) {
            generation++
            session = null
            service = value
            reason = "user_paused"
        }
    }

    internal fun detach(value: MobileAccessibilityService) {
        synchronized(lock) {
            if (service !== value) return
            generation++
            session = null
            service = null
            currentPackage = null
            reason = "service_disconnected"
        }
    }

    internal fun updatePackage(value: String?) { currentPackage = value }
    internal fun hideFeedback() { synchronized(lock) { service?.hideFeedback() } }

    internal data class Grant(val sessionId: String, val generation: Long, val service: MobileAccessibilityService)

    internal fun valid(grant: Grant): Boolean = synchronized(lock) {
        service === grant.service && session == grant.sessionId && generation == grant.generation
    }

    internal fun execute(context: Context, command: MobileCommand, complete: (JSONObject) -> Unit) {
        if (command === MobileCommand.Status) {
            complete(success(status(context)))
            return
        }
        if (command === MobileCommand.Stop) {
            pause("user_paused")
            complete(success(status(context)))
            return
        }
        val requestedSession = when (command) {
            is MobileCommand.Observe -> command.sessionId
            is MobileCommand.Click -> command.sessionId
            is MobileCommand.Type -> command.sessionId
            is MobileCommand.Swipe -> command.sessionId
            is MobileCommand.Back -> command.sessionId
            is MobileCommand.ListApps -> command.sessionId
            is MobileCommand.OpenApp -> command.sessionId
            else -> null
        }
        val grant = synchronized(lock) {
            val connected = service
            if (session != null && session == requestedSession && connected != null) Grant(session!!, generation, connected) else null
        }
        if (!isEnabled(context)) complete(failure("accessibility_disabled", "Enable DSH accessibility in Android settings"))
        else if (isDeviceLocked(context)) {
            pause("device_locked")
            complete(failure("locked", "Unlock the device before phone control"))
        }
        else if (grant == null) complete(failure("paused", "Phone control requires a current native user grant"))
        else grant.service.execute(command, grant, complete)
    }

    internal fun isDeviceLocked(context: Context): Boolean =
        (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked ||
            !(context.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive

    private fun isEnabled(context: Context): Boolean {
        val expected = ComponentName(context, MobileAccessibilityService::class.java)
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }

    internal fun success(value: JSONObject): JSONObject = JSONObject().put("ok", true).put("value", value)
    internal fun failure(code: String, message: String): JSONObject = JSONObject().put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message))
}
