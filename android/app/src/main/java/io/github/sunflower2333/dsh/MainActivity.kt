package io.github.sunflower2333.dsh

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var webView: WebView
    private lateinit var start: Button
    private lateinit var stop: Button
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val value = intent?.getStringExtra(DshService.EXTRA_VALUE).orEmpty()
            when (intent?.action) {
                DshService.ACTION_READY -> {
                    status.text = getString(R.string.running_status)
                    webView.loadUrl(value)
                }
                DshService.ACTION_ERROR -> status.text = getString(R.string.error_status, value)
                DshService.ACTION_LOG -> if (status.text == getString(R.string.starting_status)) status.text = value
                DshService.ACTION_EXITED -> {
                    status.text = getString(R.string.idle_status)
                    start.isEnabled = true
                    stop.isEnabled = false
                }
            }
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildView())
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
        val filter = IntentFilter().apply {
            addAction(DshService.ACTION_READY); addAction(DshService.ACTION_LOG)
            addAction(DshService.ACTION_ERROR); addAction(DshService.ACTION_EXITED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(receiver, filter)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildView(): android.view.View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(16, 10, 16, 10) }
        status = TextView(this).apply { text = getString(R.string.idle_status); layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) }
        start = Button(this).apply { text = getString(R.string.start); setOnClickListener { startDsh() } }
        stop = Button(this).apply { text = getString(R.string.stop); isEnabled = false; setOnClickListener { stopDsh() } }
        bar.addView(status); bar.addView(start); bar.addView(stop)
        root.addView(bar)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !LocalUrl.isAllowed(request.url.toString())
            }
        }
        root.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun startDsh() {
        val intent = Intent(this, DshService::class.java).setAction(DshService.ACTION_START)
        startForegroundService(intent)
        status.text = getString(R.string.starting_status)
        start.isEnabled = false
        stop.isEnabled = true
    }

    private fun stopDsh() {
        startService(Intent(this, DshService::class.java).setAction(DshService.ACTION_STOP))
        status.text = getString(R.string.stopping_status)
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        webView.destroy()
        super.onDestroy()
    }
}
