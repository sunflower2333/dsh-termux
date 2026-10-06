package io.github.sunflower2333.dsh

import org.junit.Assert.assertEquals
import org.junit.Test

class SystemBarAppearanceTest {
    @Test fun actualStaleLightStatusFlagIsClearedForDarkMode() {
        // The failing API 30 window dump retained this exact legacy bit.
        assertEquals(0, SystemBarAppearance.legacyFlags(0x2000, true))
    }

    @Test fun lightDarkRoundTripKeepsBothBarChoicesInSync() {
        val layout = 0x0500
        val light = SystemBarAppearance.legacyFlags(layout, false)
        assertEquals(layout or 0x2010, light)
        assertEquals(light, SystemBarAppearance.legacyFlags(light, false))
        val dark = SystemBarAppearance.legacyFlags(light, true)
        assertEquals(layout, dark)
        assertEquals(light, SystemBarAppearance.legacyFlags(dark, false))
    }

    @Test fun layoutHiddenNavigationImmersiveAndUnknownBitsArePreserved() {
        val other = 0x0100 or 0x0200 or 0x0400 or 0x1000 or 0x0002 or 0x04000000
        assertEquals(other or 0x2010, SystemBarAppearance.legacyFlags(other, false))
        assertEquals(other, SystemBarAppearance.legacyFlags(other or 0x2010, true))
    }
}
