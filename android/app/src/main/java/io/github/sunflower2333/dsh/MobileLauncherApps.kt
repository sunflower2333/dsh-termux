package io.github.sunflower2333.dsh

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import org.json.JSONArray
import org.json.JSONObject

internal object MobileLauncherPolicy {
    private val packages = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")
    fun requirePackage(raw: Any?): String {
        val value = raw as? String ?: throw MobileProtocolException("invalid_request", "packageName must be an Android package name")
        if (value.length > 256 || !packages.matches(value)) throw MobileProtocolException("invalid_request", "Invalid Android package name")
        return value
    }
    fun validPackage(value: String): Boolean = runCatching { requirePackage(value) }.isSuccess
    fun label(raw: String, fallback: String): String {
        val result = StringBuilder()
        var index = 0
        while (index < raw.length && result.length < 128) {
            val character = raw[index++]
            if (character == '\u0000' || character.isLowSurrogate()) continue
            if (character.isHighSurrogate()) {
                if (index < raw.length && raw[index].isLowSurrogate()) {
                    if (result.length + 2 > 128) break
                    result.append(character).append(raw[index++])
                }
            } else result.append(character)
        }
        return result.toString().ifBlank { fallback.take(128) }
    }
}

/** Android's visible launcher activities, not an inventory of background windows. */
internal class MobileLauncherApps(private val context: Context) {
    private val manager = context.packageManager
    private fun launcherIntent(packageName: String? = null) = Intent(Intent.ACTION_MAIN)
        .addCategory(Intent.CATEGORY_LAUNCHER).also { if (packageName != null) it.setPackage(packageName) }

    @Suppress("DEPRECATION")
    private fun eligible(packageName: String? = null): List<ResolveInfo> = manager
        .queryIntentActivities(launcherIntent(packageName), 0)
        .filter { resolve -> resolve.activityInfo?.let { info ->
            val permission = info.permission
            info.exported && info.enabled && info.applicationInfo.enabled && MobileLauncherPolicy.validPackage(info.packageName) &&
                (permission.isNullOrEmpty() || context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED)
        } == true }

    fun list(sessionId: String): JSONObject {
        val apps = eligible().groupBy { it.activityInfo.packageName }.map { (name, activities) ->
            val label = MobileLauncherPolicy.label(activities.first().loadLabel(manager)?.toString().orEmpty(), name)
            Pair(name, label)
        }.sortedWith(compareBy<Pair<String, String>> { it.second.lowercase(java.util.Locale.ROOT) }.thenBy { it.first })
        val array = JSONArray()
        for ((name, label) in apps.take(128)) array.put(JSONObject().put("packageName", name).put("label", label))
        return JSONObject().put("sessionId", sessionId).put("apps", array).put("truncated", apps.size > 128).put("foregroundOnly", true)
    }

    fun intent(packageName: String): Intent? {
        val info = eligible(packageName).sortedBy { it.activityInfo.name }.firstOrNull()?.activityInfo ?: return null
        return launcherIntent(packageName).setComponent(ComponentName(info.packageName, info.name))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    }
}
