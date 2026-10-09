package io.github.sunflower2333.dsh

import android.app.Notification
import android.os.Build
import android.os.Bundle

/** Android 16 Live Updates are the public entry point for ColorOS 16 Fluid Cloud.
 * OEM eligibility and the user's promotion setting remain authoritative.
 * Keep compile/min SDK unchanged; Android 16.0 exposes promotion via extras,
 * while the Builder method itself was added only in Android 16.1.
 */
internal object RuntimeLiveUpdates {
    private val standardOngoingSurface = setOf("xiaomi", "redmi", "vivo", "oppo", "oneplus", "realme")

    internal fun shouldRequest(apiLevel: Int, manufacturer: String): Boolean =
        apiLevel >= 36 || manufacturer.lowercase(java.util.Locale.ROOT) in standardOngoingSurface

    fun request(builder: Notification.Builder, shortText: String) {
        // ColorOS 16 exposes Android 16 Live Updates directly. HyperOS and
        // OriginOS use the same ongoing notification surface on supported
        // releases, but do not expose a stable public Fluid/Atomic Island API.
        // Keep one standard notification contract for those vendors instead of
        // depending on private SDKs or pretending to be a media session.
        val manufacturer = Build.MANUFACTURER
        val androidLiveUpdates = Build.VERSION.SDK_INT >= 36
        if (!shouldRequest(Build.VERSION.SDK_INT, manufacturer)) return
        if (androidLiveUpdates) {
            builder.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
            runCatching {
                Notification.Builder::class.java.getMethod("setShortCriticalText", String::class.java)
                    .invoke(builder, shortText.take(7))
            }
        }
    }
}
