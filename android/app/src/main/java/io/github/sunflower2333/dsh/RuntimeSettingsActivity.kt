package io.github.sunflower2333.dsh

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** User initiated system settings. No permission request occurs on ordinary app launch. */
class RuntimeSettingsActivity : Activity() {
    private val colors by lazy { NativeUiColors(this) }
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var hostValue: TextView
    private lateinit var taskValue: TextView
    private lateinit var notificationValue: TextView
    private lateinit var batteryValue: TextView
    private val refresh = object : Runnable {
        override fun run() { refreshStatus(); handler.postDelayed(this, 1_000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(AndroidAppearance.theme(this))
        super.onCreate(savedInstanceState)
        setContentView(buildView())
        configureSystemBars()
    }

    override fun onResume() {
        super.onResume()
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
        root.addView(button(R.string.mobile_use_back) { finish() }.apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setPadding(dp(20), 0, dp(20), 0)
        })
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(24))
        }
        content.addView(label(R.string.runtime_settings_title, 24f).apply {
            setTypeface(typeface, Typeface.BOLD)
            isAccessibilityHeading = true
        })
        content.addView(label(R.string.runtime_background_description, 15f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(12), 0, dp(20))
        })
        hostValue = status(content, R.string.runtime_host_label)
        taskValue = status(content, R.string.runtime_tasks_label)
        notificationValue = status(content, R.string.runtime_notifications_label)
        content.addView(button(R.string.runtime_notifications_settings) { configureNotifications() })
        content.addView(label(R.string.runtime_notifications_hint, 13f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(8), 0, dp(20))
        })
        batteryValue = status(content, R.string.runtime_battery_label)
        content.addView(button(R.string.runtime_battery_settings) {
            openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        })
        content.addView(label(R.string.runtime_battery_hint, 13f).apply {
            setTextColor(colors.secondary)
            setPadding(0, dp(8), 0, dp(16))
        })
        content.addView(label(R.string.runtime_progress_hint, 13f).apply {
            setTextColor(colors.secondary)
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

    private fun status(parent: LinearLayout, resource: Int): TextView {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(10))
        }
        row.addView(label(resource, 14f).apply { setTextColor(colors.secondary) })
        return label(R.string.mobile_use_status_unavailable, 16f).apply {
            setPadding(0, dp(4), 0, 0)
            row.addView(this)
            parent.addView(row)
        }
    }

    private fun button(resource: Int, action: () -> Unit) = colors.style(Button(this)).apply {
        text = getString(resource)
        isAllCaps = false
        minHeight = dp(48)
        filterTouchesWhenObscured = true
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setOnClickListener { action() }
    }

    private fun refreshStatus() {
        val status = DshService.runtimeTaskStatus
        update(hostValue, getString(if (status.hostRunning) R.string.runtime_host_running else R.string.runtime_host_stopped))
        update(taskValue, when {
            !status.hostRunning -> getString(R.string.runtime_host_stopped)
            !status.connected -> getString(R.string.runtime_tasks_unknown)
            status.running > 0 -> getString(R.string.running_tasks_status, status.running)
            status.waiting > 0 -> getString(R.string.waiting_tasks_status, status.waiting)
            else -> getString(R.string.runtime_tasks_idle)
        })
        val manager = getSystemService(NotificationManager::class.java)
        val channels = listOf(RuntimeTaskNotifications.ATTENTION_CHANNEL, RuntimeTaskNotifications.COMPLETION_CHANNEL, RuntimeTaskNotifications.NOTICE_CHANNEL)
        val disabledCategory = channels.any { manager.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE }
        update(notificationValue, getString(when {
            !manager.areNotificationsEnabled() -> R.string.runtime_notifications_disabled
            disabledCategory -> R.string.runtime_notifications_partial
            else -> R.string.runtime_notifications_enabled
        }))
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        update(batteryValue, getString(if (exempt) R.string.runtime_battery_unrestricted else R.string.runtime_battery_optimized))
    }

    private fun configureNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            val preferences = getSharedPreferences("dsh-notifications", MODE_PRIVATE)
            if (!preferences.getBoolean("requested", false) || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                preferences.edit().putBoolean("requested", true).apply()
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATIONS_REQUEST)
            } else openSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        } else openSettings(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    private fun openSettings(intent: Intent) {
        try { startActivity(intent) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this, R.string.runtime_system_settings_unavailable, Toast.LENGTH_LONG).show() }
    }

    private fun update(view: TextView, text: String) { if (view.text.toString() != text) view.text = text }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    @Suppress("DEPRECATION")
    private fun configureSystemBars() {
        window.setDecorFitsSystemWindows(false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        val light = if (colors.dark) 0 else
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(light,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
    }

    companion object { private const val NOTIFICATIONS_REQUEST = 46 }
}
