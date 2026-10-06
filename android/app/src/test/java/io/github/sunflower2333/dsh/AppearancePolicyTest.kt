package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class AppearancePolicyTest {
    @Test fun explicitModesOverrideAndroidSystemAndSystemFollowsBothTransitions() {
        assertTrue(AppearancePolicy.dark("dark", false))
        assertTrue(AppearancePolicy.dark("dark", true))
        assertFalse(AppearancePolicy.dark("light", false))
        assertFalse(AppearancePolicy.dark("light", true))
        assertFalse(AppearancePolicy.dark("system", false))
        assertTrue(AppearancePolicy.dark("system", true))
    }

    @Test fun nativeMirrorAcceptsOnlyActualDshPreferenceAndMatchingResolvedPalette() {
        fun fields(preference: String, scheme: String) = mapOf<String, Any?>("version" to 1L,
            "preference" to preference, "resolvedScheme" to scheme)
        assertEquals(AppearanceMessage("dark", "dark"), AppearancePolicy.parse(fields("dark", "dark"), false))
        assertEquals(AppearanceMessage("light", "light"), AppearancePolicy.parse(fields("light", "light"), true))
        assertEquals(AppearanceMessage("system", "dark"), AppearancePolicy.parse(fields("system", "dark"), true))
        for (invalid in listOf(fields("auto", "dark"), fields("dark", "light"), fields("system", "light"),
            fields("light", "light") + ("grant" to true), fields("light", "light") + ("version" to 1.0))) {
            try { AppearancePolicy.parse(invalid, true); fail("Invalid appearance message accepted") }
            catch (_: IllegalArgumentException) { }
        }
    }
}
