package io.github.sunflower2333.dsh

import android.content.Context
import android.content.res.Configuration
import android.webkit.JavascriptInterface

internal data class AppearanceMessage(val preference: String, val resolvedScheme: String)

internal object AppearancePolicy {
    private val preferences = setOf("system", "light", "dark")
    fun dark(preference: String, systemDark: Boolean): Boolean = when (preference) {
        "dark" -> true
        "light" -> false
        else -> systemDark
    }
    fun parse(fields: Map<String, Any?>, systemDark: Boolean): AppearanceMessage {
        require(fields.keys == setOf("version", "preference", "resolvedScheme")) { "Invalid appearance message" }
        require(fields["version"] == 1 || fields["version"] == 1L) { "Unsupported appearance message" }
        val preference = fields["preference"] as? String ?: throw IllegalArgumentException("Invalid appearance preference")
        require(preference in preferences) { "Invalid appearance preference" }
        val resolved = fields["resolvedScheme"] as? String ?: throw IllegalArgumentException("Invalid appearance scheme")
        require(resolved == if (dark(preference, systemDark)) "dark" else "light") { "Appearance scheme does not match its preference" }
        return AppearanceMessage(preference, resolved)
    }
}

/** DSH remains authoritative; this mirror supplies native surfaces before WebView boot. */
internal object AndroidAppearance {
    private const val FILE = "dsh-appearance"
    fun systemDark(context: Context): Boolean = context.applicationContext.resources.configuration.uiMode and
        Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    fun preference(context: Context): String = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        .getString("preference", "system") ?: "system"
    fun dark(context: Context): Boolean = AppearancePolicy.dark(preference(context), systemDark(context))
    fun adoptFromDsh(context: Context, preference: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString("preference", preference).apply()
    }
    fun theme(context: Context): Int = if (dark(context)) R.style.AppThemeDark else R.style.AppTheme
}

/** Read-only metadata. Theme writes use a main-frame-only authenticated-origin message port. */
internal class AndroidUiMode(private val context: Context, private val allowed: () -> Boolean) {
    @JavascriptInterface fun isDark(): Boolean = allowed() && AndroidAppearance.systemDark(context)
}
