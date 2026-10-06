package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class NativeNoticeProtocolTest {
    private fun fields() = mapOf<String, Any?>("version" to 1L, "sessionId" to "session-owned", "eventId" to "notice-1",
        "title" to "任务提醒", "message" to "完成后请查看结果。")

    @Test fun explicitNoticeKeepsExactOpaqueOwnerAndValidBoundedText() {
        val notice = NativeNoticeProtocol.parse(fields())
        assertEquals("session-owned", notice.sessionId)
        assertEquals("任务提醒", notice.title)
        assertEquals("完成后请查看结果。", notice.message)
        assertEquals(1024, NativeNoticeProtocol.parse(fields() + ("message" to "a".repeat(1024))).message.length)
    }

    @Test fun noticeCannotAddArbitraryRouteOrMalformedSensitivePayload() {
        val invalid = listOf(fields() + ("url" to "https://example.test"), fields() - "sessionId",
            fields() + ("sessionId" to "../../other"), fields() + ("version" to 1.0),
            fields() + ("title" to "a".repeat(65)), fields() + ("message" to "a".repeat(1025)),
            fields() + ("message" to "  "), fields() + ("message" to "a\u0000b"),
            fields() + ("message" to "\uD83D"), fields() + ("title" to "\uDC00"))
        for (candidate in invalid) {
            try { NativeNoticeProtocol.parse(candidate); fail("Malformed native notice accepted") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun noticesHavePerSessionAndGlobalBoundsWithoutRecordingRejectedAttempts() {
        val rate = NativeNoticeRateLimit()
        assertTrue(rate.allowed("owned", 1000))
        rate.posted("owned", 1000)
        assertFalse(rate.allowed("owned", 10_999))
        assertFalse(rate.allowed("other", 1999))
        assertTrue(rate.allowed("other", 2000))
        assertTrue(rate.allowed("owned", 11_000))
    }
}
