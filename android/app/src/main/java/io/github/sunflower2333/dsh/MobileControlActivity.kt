package io.github.sunflower2333.dsh

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/** Native, user-owned controls. Web content cannot grant a Mobile use session. */
class MobileControlActivity : Activity() {
    private val colors by lazy { NativeUiColors(this) }
    private lateinit var enabledValue: TextView
    private lateinit var connectedValue: TextView
    private lateinit var activeValue: TextView
    private lateinit var reasonValue: TextView
    private lateinit var packageValue: TextView
    private lateinit var allowButton: Button
    private lateinit var pauseButton: Button
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            refreshStatus()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(AndroidAppearance.theme(this))
        super.onCreate(savedInstanceState)
        title = getString(R.string.mobile_use_title)
        setContentView(buildView())
        // API 30 needs a DecorView before PhoneWindow.insetsController is read.
        configureSystemBars()
    }

    override fun onResume() {
        super.onResume()
        // Reading native status never resumes control, including on return
        // from Accessibility Settings and after recreation or host restart.
        handler.removeCallbacks(refresh)
        refresh.run()
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun buildView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colors.background)
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
                insets
            }
        }
        root.addView(colors.style(Button(this)).apply {
            text = getString(R.string.mobile_use_back)
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            minHeight = dp(48)
            setPadding(dp(20), 0, dp(20), 0)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(24))
        }
        content.addView(label(R.string.mobile_use_title, 24f).apply {
            setTypeface(typeface, Typeface.BOLD)
            isAccessibilityHeading = true
        })
        content.addView(label(R.string.mobile_use_description, 15f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(12), 0, dp(20))
        })
        enabledValue = addStatusRow(content, R.string.mobile_use_enabled_label)
        connectedValue = addStatusRow(content, R.string.mobile_use_connected_label)
        activeValue = addStatusRow(content, R.string.mobile_use_active_label)
        reasonValue = label(R.string.mobile_use_status_unavailable, 14f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(8), 0, dp(16))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        content.addView(reasonValue)
        packageValue = addStatusRow(content, R.string.mobile_use_package_label)
        packageValue.minLines = 2
        packageValue.maxLines = 2
        packageValue.ellipsize = android.text.TextUtils.TruncateAt.END
        packageValue.text = getString(R.string.mobile_use_package_none)

        content.addView(actionButton(R.string.mobile_use_accessibility_settings) {
            try {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this, R.string.mobile_use_settings_unavailable, Toast.LENGTH_LONG).show()
            }
        })
        allowButton = actionButton(R.string.mobile_use_allow) {
            // This physical native button is the only resume path in the UI.
            // No intent extras, onResume callback or JS bridge can invoke it.
            showStatus(runCatching { MobileUseController.resumeFromUser(this) }.getOrNull())
        }.apply { isEnabled = false }
        content.addView(allowButton)
        pauseButton = actionButton(R.string.mobile_use_pause) {
            MobileUseController.pause("user_paused")
            refreshStatus()
        }
        content.addView(pauseButton)
        content.addView(label(R.string.mobile_use_pause_hint, 13f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(8), 0, 0)
        })
        content.addView(CheckBox(this).apply {
            text = getString(R.string.mobile_use_feedback_label)
            setTextColor(colors.primary)
            minHeight = dp(48)
            filterTouchesWhenObscured = true
            isChecked = MobileFeedbackSettings.enabled(this@MobileControlActivity)
            setOnCheckedChangeListener { _, checked -> MobileFeedbackSettings.setFromUser(this@MobileControlActivity, checked) }
        })
        content.addView(label(R.string.mobile_use_feedback_hint, 13f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(8), 0, 0)
        })
        root.addView(ScrollView(this).apply {
            isFillViewport = true
            addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.post { root.requestApplyInsets() }
        return root
    }

    private fun label(resource: Int, size: Float) = TextView(this).apply {
        text = getString(resource)
        textSize = size
        setTextColor(colors.primary)
    }

    private fun addStatusRow(parent: LinearLayout, resource: Int): TextView {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(8))
        }
        row.addView(label(resource, 15f), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val value = label(R.string.mobile_use_status_unavailable, 15f).apply {
            gravity = Gravity.END
            setPadding(dp(16), 0, 0, 0)
        }
        row.addView(value, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        parent.addView(row)
        return value
    }

    private fun actionButton(resource: Int, action: () -> Unit) = colors.style(Button(this)).apply {
        text = getString(resource)
        isAllCaps = false
        minHeight = dp(48)
        filterTouchesWhenObscured = true
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setOnClickListener { action() }
    }

    private fun refreshStatus() = showStatus(runCatching { MobileUseController.status(this) }.getOrNull())

    private fun showStatus(status: JSONObject?) {
        // Malformed/unavailable status must not be shown as an active session.
        val flags = runCatching {
            requireNotNull(status)
            Triple(status.getBoolean("enabled"), status.getBoolean("connected"), status.getBoolean("active"))
        }.getOrNull()
        if (flags == null) {
            for (value in listOf(enabledValue, connectedValue, activeValue, reasonValue)) {
                updateText(value, getString(R.string.mobile_use_status_unavailable))
            }
            allowButton.isEnabled = false
            pauseButton.isEnabled = true
            updateText(packageValue, getString(R.string.mobile_use_package_none))
            return
        }
        val (enabled, connected, active) = flags
        val reason = status!!.optString("reason")
        updateText(enabledValue, getString(if (enabled) R.string.mobile_use_enabled else R.string.mobile_use_disabled))
        updateText(connectedValue, getString(if (connected) R.string.mobile_use_connected else R.string.mobile_use_disconnected))
        updateText(activeValue, getString(if (active) R.string.mobile_use_active else R.string.mobile_use_paused))
        activeValue.setTextColor(if (active) colors.active else colors.primary)
        updateText(reasonValue, getString(when {
            active -> R.string.mobile_use_reason_active
            !enabled -> R.string.mobile_use_reason_disabled
            !connected -> R.string.mobile_use_reason_disconnected
            reason == "device_locked" -> R.string.mobile_use_reason_locked
            reason == "host_started" || reason == "host_stopped" -> R.string.mobile_use_reason_host
            reason == "service_disconnected" || reason == "service_interrupted" -> R.string.mobile_use_reason_interrupted
            else -> R.string.mobile_use_reason_paused
        }))
        allowButton.isEnabled = enabled && connected && !active && reason != "device_locked" && reason != "host_stopped"
        pauseButton.isEnabled = active
        val currentPackage = status.optString("currentPackage").takeUnless { it.isBlank() || it == "null" }
        updateText(packageValue, currentPackage ?: getString(R.string.mobile_use_package_none))
    }

    private fun updateText(view: TextView, value: String) {
        // Polling status should not announce unchanged content every second.
        if (view.text.toString() != value) view.text = value
    }

    @Suppress("DEPRECATION")
    private fun configureSystemBars() {
        window.setDecorFitsSystemWindows(false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false
        SystemBarAppearance.apply(window, colors.dark)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

}
