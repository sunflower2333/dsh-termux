package io.github.sunflower2333.dsh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeLiveUpdatesTest {
    @Test fun android16RequestsLiveUpdatesOnAnyManufacturer() {
        assertTrue(RuntimeLiveUpdates.shouldRequest(36, "Google"))
    }

    @Test fun hyperOsAndOriginOsUseTheStandardOngoingSurface() {
        assertTrue(RuntimeLiveUpdates.shouldRequest(35, "Xiaomi"))
        assertTrue(RuntimeLiveUpdates.shouldRequest(35, "vivo"))
        assertTrue(RuntimeLiveUpdates.shouldRequest(35, "OPPO"))
        assertFalse(RuntimeLiveUpdates.shouldRequest(35, "Google"))
    }
}
