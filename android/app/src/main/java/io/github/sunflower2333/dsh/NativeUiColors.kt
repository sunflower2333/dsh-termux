package io.github.sunflower2333.dsh

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.widget.Button

internal class NativeUiColors(context: Context) {
    val dark = AndroidAppearance.dark(context)
    val background = if (dark) Color.rgb(19, 24, 33) else Color.WHITE
    val primary = if (dark) Color.rgb(232, 238, 248) else Color.rgb(24, 34, 52)
    val secondary = if (dark) Color.rgb(176, 188, 206) else Color.rgb(90, 103, 122)
    val active = if (dark) Color.rgb(109, 218, 158) else Color.rgb(18, 115, 63)

    fun style(button: Button): Button = button.apply {
        setTextColor(primary)
        if (dark) backgroundTintList = ColorStateList.valueOf(Color.rgb(40, 50, 66))
    }
}
