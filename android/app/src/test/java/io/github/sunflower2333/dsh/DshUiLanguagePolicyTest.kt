package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class DshUiLanguagePolicyTest {
    @Test fun absentUnsupportedOrMalformedLocaleUsesEnglishRatherThanSystemLocale() {
        for (value in listOf(null, "", "auto", "fr", "en-US", "zh-CN", "ZH", "../zh", "zh\nen")) {
            assertEquals("en", DshUiLanguagePolicy.effective(value))
        }
        assertEquals("zh", DshUiLanguagePolicy.effective("zh"))
        assertEquals("en", DshUiLanguagePolicy.effective("en"))
    }

    @Test fun localeSyncCannotCarryConsentOrUnboundedLocalePayloads() {
        for (locale in listOf("en", "zh")) {
            val command = AndroidSettingsPolicy.parse(listOf("id" to "locale.1", "type" to "sync-language", "locale" to locale))
            assertEquals(locale, command.locale)
            assertNull(command.enabled)
            assertFalse(AndroidSettingsPolicy.needsUserGesture(command.type))
        }
        for (value in listOf(null, true, 1, "auto", "zh-CN", "en\n", "x".repeat(200))) {
            try {
                AndroidSettingsPolicy.parse(listOf("id" to "locale.1", "type" to "sync-language", "locale" to value))
                fail("Malformed locale sync was accepted")
            } catch (_: IllegalArgumentException) { }
        }
        for (type in listOf("allow-control", "set-feedback", "status")) {
            try {
                AndroidSettingsPolicy.parse(listOf("id" to "locale.1", "type" to type, "locale" to "en"))
                fail("A locale field was accepted by an unrelated operation")
            } catch (_: IllegalArgumentException) { }
        }
    }
}
