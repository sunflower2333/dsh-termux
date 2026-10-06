package io.github.sunflower2333.dsh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileControlNavigationTest {
    @Test fun nativeControlRequiresTheCurrentDshOriginAndAnExactPath() {
        val ready = "http://127.0.0.1:4312/?token=test-only"
        val page = "http://127.0.0.1:4312/session#chat"
        val action = "http://127.0.0.1:4312${WebNavigation.MOBILE_CONTROL_PATH}"
        assertTrue(WebNavigation.isMobileControlRequest(action, page, ready))
        for (candidate in listOf("$action?resume=true", "$action#resume", "$action/",
            action.replace("4312", "4313"), action.replace("127.0.0.1", "localhost"),
            action.replace("mobile-control", "%6dobile-control"))) {
            assertFalse(WebNavigation.isMobileControlRequest(candidate, page, ready))
        }
        assertFalse(WebNavigation.isMobileControlRequest(action, "https://example.test/", ready))
        assertFalse(WebNavigation.isMobileControlRequest(action, null, ready))
        assertFalse(WebNavigation.isMobileControlRequest(action, page, null))
        assertFalse(WebNavigation.isConfigurationRequest(action, page, ready))
    }
}
