package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class MobileFeedbackTimingTest {
    @Test fun observationWaitsForWholeFeedbackAndCompositorQuietTime() {
        var time = 1000L
        val timing = MobileFeedbackTiming { time }
        assertEquals(0, timing.captureDelayMs())
        timing.shown(800)
        assertEquals(960, timing.captureDelayMs())
        time = 1800
        timing.hidden()
        assertEquals(160, timing.captureDelayMs())
        time = 1959
        assertEquals(1, timing.captureDelayMs())
        time = 1960
        assertEquals(0, timing.captureDelayMs())
    }

    @Test fun pauseOrDisableClearsFeedbackButStillWaitsForCompositor() {
        var time = 1000L
        val timing = MobileFeedbackTiming { time }
        timing.shown(10_000)
        assertEquals(1760, timing.captureDelayMs())
        time = 1200
        timing.hidden()
        assertEquals(160, timing.captureDelayMs())
    }
}
