package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class MobileObservationPolicyTest {
    @Test fun slowModelCanUseRevalidatedNodesCoordinatesAndBackForFiveMinutes() {
        assertTrue(MobileObservationPolicy.fresh(1_000, 91_000))
        assertTrue(MobileObservationPolicy.fresh(1_000, 301_000))
        assertFalse(MobileObservationPolicy.fresh(1_000, 301_001))
    }

    @Test fun ClockRollbackCannotRenewAnOldObservation() {
        assertFalse(MobileObservationPolicy.fresh(1_000, 999))
        assertFalse(MobileObservationPolicy.fresh(-1, 0))
    }

    @Test fun extendedWaitNeverAllowsGesturesAcrossScreenOrWindowChanges() {
        assertNull(MobileObservationPolicy.invalidReason(true, true, true, true, true, true))
        assertEquals("observation_screen_changed", MobileObservationPolicy.invalidReason(true, true, true, true, false, true))
        assertEquals("observation_window_changed", MobileObservationPolicy.invalidReason(true, true, true, false, true, true))
        assertEquals("observation_window_changed", MobileObservationPolicy.invalidReason(true, true, true, false, false, false))
        // Node actions separately revalidate the actual node; unrelated live text
        // updates need not invalidate a still-identical target.
        assertNull(MobileObservationPolicy.invalidReason(true, true, true, true, false, false))
    }

    @Test fun expiryReplacementAndSessionMismatchHaveDistinctReasons() {
        assertEquals("observation_expired", MobileObservationPolicy.invalidReason(true, true, false, true, true, true))
        assertEquals("observation_replaced", MobileObservationPolicy.invalidReason(false, true, true, true, true, true))
        assertEquals("observation_session", MobileObservationPolicy.invalidReason(true, false, true, true, true, true))
    }

    @Test fun readOnlyCaptureRetriesOnlyTransientWindowsWithinOriginalDeadline() {
        assertEquals(150L, MobileObservationPolicy.observationRetryDelay("no_window", false, 0))
        assertEquals(150L, MobileObservationPolicy.observationRetryDelay("observation_window_changed", false, 1))
        assertEquals(1_100L, MobileObservationPolicy.observationRetryDelay("observation_window_changed", true, 0))
        assertNull(MobileObservationPolicy.observationRetryDelay("observation_window_changed", false, 2))
        assertNull(MobileObservationPolicy.observationRetryDelay("no_window", false, -1))
        for (code in listOf("paused", "locked", "disconnected", "timeout", "rate_limited", "internal", "action_failed",
            "observation_screen_changed", "observation_target_changed", "observation_expired")) {
            assertNull(MobileObservationPolicy.observationRetryDelay(code, false, 0))
        }
    }

    @Test fun unrelatedNotificationsDoNotInvalidateActiveScreenButWindowChangesDo() {
        assertFalse(MobileObservationPolicy.changesActiveScreen(-1, 7, false))
        assertFalse(MobileObservationPolicy.changesActiveScreen(8, 7, false))
        assertTrue(MobileObservationPolicy.changesActiveScreen(7, 7, false))
        assertTrue(MobileObservationPolicy.changesActiveScreen(8, 7, true))
        assertTrue(MobileObservationPolicy.changesActiveScreen(-1, null, true))
        assertFalse(MobileObservationPolicy.changesActiveScreen(-1, null, false))
    }
}
