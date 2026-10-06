package io.github.sunflower2333.dsh

import android.view.View
import android.view.Window
import android.view.WindowInsetsController

/** API 30 can reapply legacy decor light-bar flags during the next traversal. */
@Suppress("DEPRECATION")
internal object SystemBarAppearance {
    fun legacyFlags(current: Int, dark: Boolean): Int {
        val mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        return if (dark) current and mask.inv() else current or mask
    }

    fun apply(window: Window, dark: Boolean) {
        val decor = window.decorView
        val previous = decor.systemUiVisibility
        val updated = legacyFlags(previous, dark)
        if (updated != previous) decor.systemUiVisibility = updated
        val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(if (dark) 0 else mask, mask)
    }
}
