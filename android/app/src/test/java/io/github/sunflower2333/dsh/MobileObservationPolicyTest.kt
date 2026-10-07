package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class MobileObservationPolicyTest {
    @Test fun slowTextModelCanUseARevalidatedNodeWhileCoordinateSampleExpires() {
        assertTrue(MobileObservationPolicy.fresh(1_000, 91_000, true))
        assertFalse(MobileObservationPolicy.fresh(1_000, 91_000, false))
        assertTrue(MobileObservationPolicy.fresh(1_000, 301_000, true))
        assertFalse(MobileObservationPolicy.fresh(1_000, 301_001, true))
        assertTrue(MobileObservationPolicy.fresh(1_000, 31_000, false))
        assertFalse(MobileObservationPolicy.fresh(1_000, 31_001, false))
    }

    @Test fun ClockRollbackCannotRenewAnOldObservation() {
        assertFalse(MobileObservationPolicy.fresh(1_000, 999, false))
        assertFalse(MobileObservationPolicy.fresh(-1, 0, false))
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
