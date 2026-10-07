package io.github.sunflower2333.dsh

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import java.util.Locale

/** App-owned Android text follows the effective DSH locale, including in the background. */
internal object DshUiLanguage {
    private const val PREFERENCES = "dsh-ui-language"
    private const val KEY = "locale"

    fun current(context: Context): String = DshUiLanguagePolicy.effective(
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY, null))

    fun sync(context: Context, value: String): Boolean {
        require(DshUiLanguagePolicy.isSupported(value))
        if (current(context) == value) return false
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(KEY, value).apply()
        return true
    }

    fun text(context: Context, resource: Int, vararg arguments: Any): String {
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocales(LocaleList(Locale.forLanguageTag(current(context))))
        val localized = context.createConfigurationContext(configuration)
        return if (arguments.isEmpty()) localized.getString(resource) else localized.getString(resource, *arguments)
    }
}

internal object DshUiLanguagePolicy {
    fun isSupported(value: String): Boolean = value == "zh" || value == "en"
    fun effective(value: String?): String = if (value == "zh") "zh" else "en"
}
