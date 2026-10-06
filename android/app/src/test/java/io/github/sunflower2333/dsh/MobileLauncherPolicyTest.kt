package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class MobileLauncherPolicyTest {
    @Test fun appOperationsAcceptOnlyLauncherPackageNamesAndStrictGrantFields() {
        assertEquals(MobileCommand.ListApps("grant-1"), MobileProtocol.parse(MobileProtocol.operation("/v1/mobile/list_apps"), mapOf("sessionId" to "grant-1")))
        val fields = mapOf("sessionId" to "grant-1", "observationId" to "obs-1", "packageName" to "com.android.settings")
        assertEquals(MobileCommand.OpenApp("grant-1", "obs-1", "com.android.settings"),
            MobileProtocol.parse(MobileProtocol.operation("/v1/mobile/open_app"), fields))
        for (bad in listOf("intent://settings", "com.android.settings/.Settings", "com.android.settings?uri=1", "com..settings", "android", "a".repeat(257) + ".b")) {
            try { MobileProtocol.parse(MobileOperation.OPEN_APP, fields + ("packageName" to bad)); fail("Invalid package accepted") }
            catch (_: MobileProtocolException) { }
        }
        try { MobileProtocol.parse(MobileOperation.OPEN_APP, fields + ("component" to ".Settings")); fail("Arbitrary component accepted") }
        catch (_: MobileProtocolException) { }
    }

    @Test fun launcherLabelsCannotSplitSurrogatesOrReturnInvalidUnicode() {
        assertEquals("package.name", MobileLauncherPolicy.label("\uD800\u0000\uDC00", "package.name"))
        val truncated = MobileLauncherPolicy.label("a".repeat(127) + "\uD83D\uDE00", "package.name")
        assertEquals("a".repeat(127), truncated)
        assertEquals("app😀", MobileLauncherPolicy.label("app😀", "package.name"))
    }
}
