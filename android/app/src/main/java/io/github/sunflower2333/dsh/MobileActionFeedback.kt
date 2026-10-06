package io.github.sunflower2333.dsh

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager

internal object MobileFeedbackSettings {
    private const val FILE = "dsh-mobile-feedback"
    fun enabled(context: Context): Boolean = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean("enabled", true)
    fun setFromUser(context: Context, enabled: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
        if (!enabled) MobileUseController.hideFeedback()
    }
}

/** Compositor quiet time prevents feedback pixels from contaminating model observations. */
internal class MobileFeedbackTiming(private val now: () -> Long) {
    private var visibleUntil = 0L
    private var quietUntil = 0L
    fun shown(duration: Long) { visibleUntil = now() + duration.coerceIn(0, 1_600) }
    fun hidden() { visibleUntil = 0; quietUntil = now() + 160 }
    fun captureDelayMs(): Long = (maxOf(if (visibleUntil > 0) visibleUntil + 160 else 0, quietUntil) - now()).coerceAtLeast(0)
}

/** Touch-through accessibility overlay, created only by the real granted service. */
internal class MobileActionFeedback(private val service: AccessibilityService, private val main: Handler) : AutoCloseable {
    private val manager = service.getSystemService(WindowManager::class.java)
    private val timing = MobileFeedbackTiming(SystemClock::uptimeMillis)
    private var overlay: FeedbackView? = null
    private val remove = Runnable { hide() }
    private var closed = false

    fun gesture(fromX: Double, fromY: Double, toX: Double, toY: Double, duration: Long, width: Int, height: Int) {
        val moving = fromX != toX || fromY != toY
        show(FeedbackView(service, fromX.toFloat(), fromY.toFloat(), toX.toFloat(), toY.toFloat(),
            if (moving) duration else 0, if (moving) duration + 400 else 800, null), width, height)
    }

    fun type(rect: Rect, width: Int, height: Int) {
        show(FeedbackView(service, 0f, 0f, 0f, 0f, 0, 850, RectF(rect)), width, height)
    }

    private fun show(view: FeedbackView, width: Int, height: Int) {
        if (closed || !MobileFeedbackSettings.enabled(service)) return
        hide()
        val flags = WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        val parameters = WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            flags, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            setFitInsetsTypes(0)
            title = "DSH phone action feedback"
        }
        try { manager.addView(view, parameters) }
        catch (_: RuntimeException) { return } // Feedback failure never changes the real action result.
        overlay = view
        timing.shown(view.duration)
        main.postDelayed(remove, view.duration)
        view.postInvalidateOnAnimation()
    }

    fun captureDelayMs(): Long = timing.captureDelayMs()

    fun hide() {
        main.removeCallbacks(remove)
        val view = overlay ?: return
        overlay = null
        runCatching { manager.removeViewImmediate(view) }
        timing.hidden()
    }

    override fun close() { closed = true; hide() }

    private class FeedbackView(context: Context, private val fromX: Float, private val fromY: Float,
        private val toX: Float, private val toY: Float, private val movement: Long, val duration: Long,
        private val field: RectF?) : View(context) {
        private val start = SystemClock.uptimeMillis()
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(30, 144, 255); strokeWidth = 3 * resources.displayMetrics.density }
        private val location = IntArray(2)

        init {
            isClickable = false
            isFocusable = false
            isFocusableInTouchMode = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val elapsed = (SystemClock.uptimeMillis() - start).coerceAtLeast(0)
            val fraction = (elapsed.toFloat() / duration).coerceIn(0f, 1f)
            // Gesture/node bounds use physical display pixels. Offset by the
            // actual overlay origin instead of assuming an inset-free window.
            getLocationOnScreen(location)
            canvas.save()
            canvas.translate(-location[0].toFloat(), -location[1].toFloat())
            paint.alpha = ((1f - fraction) * 220).toInt()
            paint.style = Paint.Style.STROKE
            if (field != null) canvas.drawRoundRect(field, 8f, 8f, paint)
            else {
                val progress = if (movement > 0) (elapsed.toFloat() / movement).coerceIn(0f, 1f) else 1f
                val x = fromX + (toX - fromX) * progress
                val y = fromY + (toY - fromY) * progress
                if (movement > 0) {
                    val path = Path().apply { moveTo(fromX, fromY); lineTo(x, y) }
                    canvas.drawPath(path, paint)
                }
                val radius = (12 + fraction * 16) * resources.displayMetrics.density
                canvas.drawCircle(x, y, radius, paint)
                paint.style = Paint.Style.FILL
                canvas.drawCircle(x, y, 4 * resources.displayMetrics.density, paint)
            }
            canvas.restore()
            if (elapsed < duration && isAttachedToWindow) postInvalidateOnAnimation()
        }
    }
}
