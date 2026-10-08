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
    fun request(builder: Notification.Builder, shortText: String) {
        if (Build.VERSION.SDK_INT < 36) return
        builder.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
        runCatching {
            Notification.Builder::class.java.getMethod("setShortCriticalText", String::class.java)
                .invoke(builder, shortText.take(7))
        }
    }
}
