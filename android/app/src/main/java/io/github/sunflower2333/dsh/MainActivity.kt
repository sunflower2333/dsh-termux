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
import android.graphics.Color
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var loading: LinearLayout
    private lateinit var status: TextView
    private lateinit var retry: Button
    private var terminalError = false
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val value = intent?.getStringExtra(DshService.EXTRA_VALUE).orEmpty()
            when (intent?.action) {
                DshService.ACTION_READY -> {
                    terminalError = false
                    webView.loadUrl(value)
                }
                DshService.ACTION_ERROR -> showError(value)
                DshService.ACTION_LOG -> if (loading.visibility == android.view.View.VISIBLE) status.text = value
                DshService.ACTION_EXITED -> {
                    if (!terminalError && value != "stopped") showError(getString(R.string.exited_status))
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
        // DSH is the app's main surface. Starting it is part of opening the
        // app, so users never land on an empty WebView or a separate browser.
        startDsh()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildView(): android.view.View {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            android.webkit.CookieManager.getInstance().setAcceptCookie(true)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !LocalUrl.isAllowed(request.url.toString())
                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    if (LocalUrl.isAllowed(url)) loading.visibility = android.view.View.GONE
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    super.onReceivedError(view, request, error)
                    if (request.isForMainFrame) showError(error.description?.toString() ?: getString(R.string.web_load_error))
                }
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        loading = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
            setBackgroundColor(Color.WHITE)
        }
        val title = TextView(this).apply {
            text = getString(R.string.app_name)
            textSize = 24f
            setTextColor(Color.rgb(24, 34, 52))
            gravity = Gravity.CENTER
        }
        status = TextView(this).apply {
            text = getString(R.string.starting_status)
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(90, 103, 122))
            setPadding(0, 18, 0, 18)
        }
        val progress = ProgressBar(this).apply { isIndeterminate = true }
        retry = Button(this).apply {
            text = getString(R.string.retry)
            visibility = android.view.View.GONE
            setOnClickListener { startDsh() }
        }
        loading.addView(title)
        loading.addView(status)
        loading.addView(progress)
        loading.addView(retry)
        root.addView(loading, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return root
    }

    private fun startDsh() {
        terminalError = false
        loading.visibility = android.view.View.VISIBLE
        retry.visibility = android.view.View.GONE
        status.text = getString(R.string.starting_status)
        val intent = Intent(this, DshService::class.java).setAction(DshService.ACTION_START)
        startForegroundService(intent)
    }

    private fun showError(message: String) {
        terminalError = true
        loading.visibility = android.view.View.VISIBLE
        retry.visibility = android.view.View.VISIBLE
        status.text = getString(R.string.error_status, message)
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        webView.destroy()
        super.onDestroy()
    }
}
