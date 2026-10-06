package io.github.sunflower2333.dsh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigurationNavigationTest {
    @Test fun requiresAnExactNativeActionFromTheCurrentDshPage() {
        val ready = "http://127.0.0.1:4312/?token=fixture-only"
        val page = "http://127.0.0.1:4312/session#chat"
        val action = "http://127.0.0.1:4312${WebNavigation.CONFIGURATION_PATH}"
        assertTrue(WebNavigation.isConfigurationRequest(action, page, ready))
        for (candidate in listOf("$action?path=/other", "$action#other", "$action/",
            action.replace("4312", "4313"), action.replace("127.0.0.1", "localhost"),
            action.replace("open-configuration", "%6fpen-configuration"))) {
            assertFalse(WebNavigation.isConfigurationRequest(candidate, page, ready))
        }
        assertFalse(WebNavigation.isConfigurationRequest(action, "https://example.test/", ready))
        assertFalse(WebNavigation.isConfigurationRequest(action, null, ready))
        assertFalse(WebNavigation.isConfigurationRequest(action, page, null))
    }

    @Test fun contentGrantsCannotSelectAnotherPrivateFile() {
        val app = "io.github.sunflower2333.dsh"
        val uri = ConfigurationDocumentPolicy.uri(app)
        assertTrue(ConfigurationDocumentPolicy.isAllowedUri(uri, app))
        for (candidate in listOf("$uri/../credentials", "$uri?path=credentials", "$uri#credentials",
            uri.replace("/configuration", "/%63onfiguration"), uri.replace(app, "another.app"),
            uri.replace("content:", "file:"))) {
            assertFalse(ConfigurationDocumentPolicy.isAllowedUri(candidate, app))
        }
    }
}
