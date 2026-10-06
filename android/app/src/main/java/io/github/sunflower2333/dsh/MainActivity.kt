package io.github.sunflower2333.dsh

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var errorBar: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var terminalError = false
    private var lastErrorMessage: String? = null
    @Volatile private var lastReadyLaunchUrl: String? = null
    private var pendingFileSelection: ValueCallback<Array<Uri>>? = null
    private var pendingDownload: AndroidDownloadRequest? = null
    private var pendingDownloadDestination: Uri? = null
    private var readyHostConfirmed = false
    private var downloadPageReady = false
    private val downloads by lazy { AndroidDownloads(this) }
    private var uiCheckGeneration = 0
    private var backNavigationPending = false
    private var pendingConfigurationExport = false
    private val webDiagnostics by lazy { StartupDiagnostics(File(cacheDir, "dsh-webview.log")) }
    // Keep the callback behind an Any-typed slot: OnBackInvokedCallback was
    // introduced in API 33 while this client still supports API 30.
    private var backInvokedCallback: Any? = null
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val value = intent?.getStringExtra(DshService.EXTRA_VALUE).orEmpty()
            when (intent?.action) {
                DshService.ACTION_READY -> {
                    if (!LocalUrl.isAllowed(value)) return
                    val reload = terminalError || lastReadyLaunchUrl != value ||
                        !WebNavigation.isCurrentOrigin(webView.url, value)
                    terminalError = false
                    lastErrorMessage = null
                    errorBar.visibility = View.GONE
                    // Request interception runs on WebView's IO thread.
                    lastReadyLaunchUrl = value
                    readyHostConfirmed = true
                    // Reuse the restored page/history when the same server
                    // and authentication token are still alive.
                    if (reload) {
                        downloadPageReady = false
                        webView.visibility = View.INVISIBLE
                        webView.loadUrl(value)
                    }
                    else awaitDshUi()
                    savePendingDownload()
                }
                DshService.ACTION_ERROR -> showError(value)
                DshService.ACTION_EXITED -> {
                    readyHostConfirmed = false
                    if (!terminalError && value != "stopped") showError(getString(R.string.exited_status))
                }
            }
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Userdebug Android images can enable WebView debugging by default.
        // Set both build modes explicitly before creating the WebView.
        WebView.setWebContentsDebuggingEnabled(
            applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )
        setContentView(buildView())
        // API 30's PhoneWindow.insetsController dereferences the DecorView.
        // setContentView installs it before we configure the controller; the
        // root's posted inset request runs after this edge-to-edge setup.
        configureSystemBars()
        restoreWebState(savedInstanceState)
        restoreFileOperations(savedInstanceState)
        savedInstanceState?.getString(STATE_ERROR)?.let { showError(it) }
        registerBackCallback()
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
        val filter = IntentFilter().apply {
            addAction(DshService.ACTION_READY)
            addAction(DshService.ACTION_ERROR)
            addAction(DshService.ACTION_EXITED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter,
            DshService.INTERNAL_PERMISSION, null, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(receiver, filter, DshService.INTERNAL_PERMISSION, null)
        // Opening the app always starts or reconnects to the real DSH host.
        // The standard branded launch background remains until its UI mounts.
    }

    override fun onStart() {
        super.onStart()
        // Returning from another app also reconnects or starts the local host.
        // READY from the same host preserves the existing page and picker DOM.
        readyHostConfirmed = false
        startDsh()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // The launcher or notification can deliver an intent to the current
        // foreground instance without calling onStart, including just after
        // the notification's Stop action terminated the local host.
        readyHostConfirmed = false
        startDsh()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildView(): View {
        val root = FrameLayout(this).apply {
            // Keep the official window launch logo visible until DSH mounts.
            setBackgroundColor(Color.TRANSPARENT)
            // Android 15 enforces edge-to-edge for target 35. Own the insets on
            // every supported API so neither old decor fitting nor a cutout
            // can put a toolbar underneath the system status/navigation bars.
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
                insets
            }
        }
        webView = WebView(this).apply {
            visibility = View.INVISIBLE
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            android.webkit.CookieManager.getInstance().setAcceptCookie(true)
            setDownloadListener { url, userAgent, disposition, mimeType, _ ->
                chooseDownloadDestination(url, userAgent, disposition, mimeType)
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    parameters: FileChooserParams,
                ): Boolean {
                    pendingFileSelection?.onReceiveValue(null)
                    pendingFileSelection = callback
                    return try {
                        startActivityForResult(parameters.createIntent(), FILE_SELECTION_REQUEST)
                        true
                    } catch (_: ActivityNotFoundException) {
                        pendingFileSelection = null
                        callback.onReceiveValue(null)
                        Toast.makeText(this@MainActivity, R.string.file_picker_unavailable, Toast.LENGTH_SHORT).show()
                        true
                    }
                }

                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    // A plugin can recover from an individual request error.
                    // Keep diagnostics; document failures and actual boot state
                    // determine whether the application failed to start.
                    webDiagnostics.append("${message.messageLevel()}: ${message.message()}")
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (!WebNavigation.blocksForeignLoopbackRequest(request.url.toString(), lastReadyLaunchUrl)) return null
                    // Cookies do not distinguish localhost ports. Block direct
                    // cross-port resources before WebView sends any credentials.
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(),
                        ByteArrayInputStream(ByteArray(0)))
                }
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.isForMainFrame && WebNavigation.isConfigurationRequest(
                            request.url.toString(), view.url, lastReadyLaunchUrl)) {
                        openConfigurationDocument()
                        return true
                    }
                    return when (WebNavigation.classify(request.url.toString(), lastReadyLaunchUrl)) {
                        WebNavigationDecision.INTERNAL -> false
                        WebNavigationDecision.EXTERNAL_HTTP -> {
                            openExternalUrl(request.url)
                            true
                        }
                        WebNavigationDecision.BLOCKED -> true
                    }
                }
                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    if (!terminalError && WebNavigation.isCurrentOrigin(url, lastReadyLaunchUrl)) {
                        downloadPageReady = true
                        awaitDshUi()
                        savePendingDownload()
                    }
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    super.onReceivedError(view, request, error)
                    if (request.isForMainFrame) showError(error.description?.toString() ?: getString(R.string.web_load_error))
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    super.onReceivedHttpError(view, request, response)
                    if (request.isForMainFrame) showError(getString(R.string.web_http_error, response.statusCode))
                }
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        errorBar = TextView(this).apply {
            visibility = View.GONE
            textSize = 14f
            maxLines = 3
            setTextColor(Color.rgb(122, 26, 26))
            setBackgroundColor(Color.rgb(255, 236, 236))
            setPadding(dp(16), dp(12), dp(16), dp(12))
            minHeight = dp(48)
            contentDescription = getString(R.string.error_details)
            setOnClickListener { showErrorDetails() }
        }
        root.addView(errorBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        root.post { root.requestApplyInsets() }
        return root
    }

    @Suppress("DEPRECATION")
    private fun configureSystemBars() {
        window.setDecorFitsSystemWindows(false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false
        window.insetsController?.setSystemBarsAppearance(
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
        )
    }

    /** Reveal the real application, after its own plugin boot DOM has gone away. */
    private fun awaitDshUi() {
        val generation = ++uiCheckGeneration
        val deadline = android.os.SystemClock.uptimeMillis() + 60_000
        fun check() {
            if (generation != uiCheckGeneration || terminalError || isFinishing || isDestroyed) return
            if (android.os.SystemClock.uptimeMillis() >= deadline) {
                showError(getString(R.string.web_boot_timeout, webDiagnostics.tail()))
                return
            }
            webView.evaluateJavascript(UI_STATE_SCRIPT) { value ->
                if (generation != uiCheckGeneration || terminalError || isFinishing || isDestroyed) return@evaluateJavascript
                val state = runCatching { JSONObject(value) }.getOrNull()
                val failure = state?.optString("error").orEmpty()
                if (failure.isNotBlank()) {
                    showError(failure)
                } else if (state?.optBoolean("ready") == true) {
                    webView.visibility = View.VISIBLE
                } else {
                    handler.postDelayed({ check() }, 200)
                }
            }
        }
        check()
    }

    private fun restoreWebState(savedInstanceState: Bundle?) {
        if (savedInstanceState == null) return
        lastReadyLaunchUrl = savedInstanceState.getString(STATE_LAUNCH_URL)?.takeIf { LocalUrl.isAllowed(it) }
        val restored = runCatching { webView.restoreState(savedInstanceState) }.getOrNull()
        val restoredUrl = webView.url ?: restored?.currentItem?.url
        val restoredWebState = restored != null && WebNavigation.isCurrentOrigin(restoredUrl, lastReadyLaunchUrl)
        if (!restoredWebState) {
            webView.clearHistory()
            lastReadyLaunchUrl = null
        }
    }

    private fun restoreFileOperations(savedInstanceState: Bundle?) {
        if (savedInstanceState == null) return
        pendingConfigurationExport = savedInstanceState.getBoolean(STATE_CONFIGURATION_EXPORT)
        savedInstanceState.getBundle(STATE_PENDING_DOWNLOAD)?.let { state ->
            val url = state.getString("url")?.takeIf { LocalUrl.isAllowed(it) }
            if (url != null) {
                pendingDownload = AndroidDownloadRequest(url,
                    AndroidDownloadPolicy.filename(state.getString("filename").orEmpty()),
                    state.getString("mime") ?: "application/octet-stream", state.getString("userAgent"))
                pendingDownloadDestination = state.getString("destination")?.let(Uri::parse)
                    ?.takeIf { it.scheme == "content" }
            }
        }
        if (savedInstanceState.getBoolean(STATE_FILE_OPERATION_INTERRUPTED)) {
            Toast.makeText(this, R.string.file_operation_interrupted, Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Activity result compatibility for the native WebView file picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == CONFIGURATION_EXPORT_REQUEST) {
            val expected = pendingConfigurationExport
            pendingConfigurationExport = false
            if (resultCode == RESULT_OK && expected) {
                data?.data?.takeIf { it.scheme == "content" }?.let { saveConfigurationCopy(it) }
            }
            return
        }
        if (requestCode == DOWNLOAD_DESTINATION_REQUEST) {
            if (resultCode != RESULT_OK) {
                pendingDownload = null
                pendingDownloadDestination = null
                return
            }
            if (pendingDownload == null) {
                Toast.makeText(this, R.string.file_operation_interrupted, Toast.LENGTH_LONG).show()
                return
            }
            pendingDownloadDestination = data?.data?.takeIf { it.scheme == "content" }
            if (pendingDownloadDestination == null) {
                pendingDownload = null
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
                return
            }
            // A restored Activity waits for a fresh Service READY, then the
            // corresponding page's cookie handshake, before using this URL.
            savePendingDownload()
            return
        }
        if (requestCode != FILE_SELECTION_REQUEST) return
        val results = if (resultCode == RESULT_OK && data?.clipData != null) {
            val clips = data.clipData!!
            Array(clips.itemCount) { index -> clips.getItemAt(index).uri }
        } else WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        val selected = results
            ?.filter { it.scheme == "content" }?.toTypedArray()
        pendingFileSelection?.onReceiveValue(selected)
        pendingFileSelection = null
    }

    private fun savePendingDownload() {
        val request = pendingDownload ?: return
        val destination = pendingDownloadDestination ?: return
        if (!readyHostConfirmed) return
        if (!WebNavigation.isCurrentOrigin(request.url, lastReadyLaunchUrl)) {
            pendingDownload = null
            pendingDownloadDestination = null
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
            return
        }
        if (!downloadPageReady) return
        pendingDownload = null
        pendingDownloadDestination = null
        if (!AndroidDownloadPolicy.isAllowed(request.url, webView.url, lastReadyLaunchUrl)) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
            return
        }
        // Capture the current cookie only now, and never put it in savedState.
        val cookie = CookieManager.getInstance().getCookie(request.url)
        if (!downloads.save(request, destination, cookie) { result ->
                if (isFinishing || isDestroyed) return@save
                when (result) {
                    AndroidDownloads.Result.SAVED -> Toast.makeText(this,
                        getString(R.string.download_saved, request.filename), Toast.LENGTH_LONG).show()
                    AndroidDownloads.Result.FAILED -> Toast.makeText(this,
                        R.string.download_failed, Toast.LENGTH_LONG).show()
                    AndroidDownloads.Result.CANCELLED -> Unit
                }
            }) Toast.makeText(this, R.string.download_busy, Toast.LENGTH_SHORT).show()
    }

    private fun chooseDownloadDestination(url: String, userAgent: String?, disposition: String?, mimeType: String?) {
        if (!AndroidDownloadPolicy.isAllowed(url, webView.url, lastReadyLaunchUrl)) {
            Toast.makeText(this, R.string.download_local_only, Toast.LENGTH_LONG).show()
            return
        }
        if (pendingDownload != null || downloads.isRunning) {
            Toast.makeText(this, R.string.download_busy, Toast.LENGTH_SHORT).show()
            return
        }
        val filename = AndroidDownloadPolicy.filename(URLUtil.guessFileName(url, disposition, mimeType))
        val type = mimeType?.substringBefore(';')?.trim()?.takeIf { it.contains('/') }
            ?: "application/octet-stream"
        pendingDownload = AndroidDownloadRequest(url, filename, type, userAgent ?: webView.settings.userAgentString)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            setType(type)
            putExtra(Intent.EXTRA_TITLE, filename)
        }
        try {
            startActivityForResult(intent, DOWNLOAD_DESTINATION_REQUEST)
        } catch (_: ActivityNotFoundException) {
            pendingDownload = null
            Toast.makeText(this, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show()
        }
    }

    private fun startDsh() {
        startForegroundService(Intent(this, DshService::class.java).setAction(DshService.ACTION_START))
    }

    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.external_browser_unavailable, Toast.LENGTH_SHORT).show()
        }
    }

    private fun openConfigurationDocument() {
        val uri = ConfigurationDocumentProvider.uri(this)
        try {
            // Prove that the provider-owned document exists before launching
            // an editor. The frontend has already prepared it through DSH.
            contentResolver.openFileDescriptor(uri, "r")?.use { }
                ?: throw java.io.FileNotFoundException("Configuration unavailable")
            for (action in listOf(Intent.ACTION_EDIT, Intent.ACTION_VIEW)) {
                val intent = Intent(action).apply {
                    setDataAndType(uri, "text/plain")
                    clipData = ClipData.newRawUri(ConfigurationDocumentPolicy.FILENAME, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    if (action == Intent.ACTION_EDIT) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
                if (intent.resolveActivity(packageManager) == null) continue
                try {
                    startActivity(Intent.createChooser(intent, getString(R.string.configuration_open_with)))
                    return
                } catch (_: ActivityNotFoundException) { }
            }
            // Stock Android need not include a YAML/text editor. Keep the
            // button useful by opening the real system document picker for a
            // copy, rather than silently failing the desktop open command.
            if (pendingConfigurationExport) return
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/yaml"
                putExtra(Intent.EXTRA_TITLE, ConfigurationDocumentPolicy.FILENAME)
            }
            pendingConfigurationExport = true
            try {
                startActivityForResult(intent, CONFIGURATION_EXPORT_REQUEST)
                Toast.makeText(this, R.string.configuration_save_copy, Toast.LENGTH_LONG).show()
            } catch (_: ActivityNotFoundException) {
                pendingConfigurationExport = false
                Toast.makeText(this, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show()
            }
        } catch (_: Exception) {
            Toast.makeText(this, R.string.configuration_open_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun saveConfigurationCopy(destination: Uri) {
        Thread({
            val saved = runCatching {
                contentResolver.openInputStream(ConfigurationDocumentProvider.uri(this)).use { input ->
                    requireNotNull(input)
                    contentResolver.openOutputStream(destination, "wt").use { output ->
                        requireNotNull(output)
                        val buffer = ByteArray(32 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            check(total <= 16L * 1024 * 1024) { "Configuration document is too large" }
                            output.write(buffer, 0, count)
                        }
                        output.flush()
                    }
                }
            }.isSuccess
            handler.post {
                if (!isFinishing && !isDestroyed) Toast.makeText(this,
                    if (saved) getString(R.string.download_saved, ConfigurationDocumentPolicy.FILENAME)
                    else getString(R.string.download_failed), Toast.LENGTH_LONG).show()
            }
        }, "dsh-configuration-copy").apply { isDaemon = true }.start()
    }

    private fun showError(message: String) {
        terminalError = true
        readyHostConfirmed = false
        downloadPageReady = false
        if (pendingDownloadDestination != null) {
            pendingDownload = null
            pendingDownloadDestination = null
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
        }
        ++uiCheckGeneration
        lastErrorMessage = StartupDiagnostics.sanitize(message)
        errorBar.text = getString(R.string.error_summary, lastErrorMessage?.lineSequence()?.firstOrNull().orEmpty())
        errorBar.visibility = View.VISIBLE
        // Existing DSH content and genuine WebView error pages remain visible.
        if (webView.url != null && webView.url != "about:blank") webView.visibility = View.VISIBLE
    }

    private fun showErrorDetails() {
        val message = lastErrorMessage ?: return
        val text = TextView(this).apply {
            this.text = message
            setPadding(dp(16), dp(12), dp(16), dp(12))
            setTextIsSelectable(true)
        }
        val scroll = ScrollView(this).apply { addView(text) }
        AlertDialog.Builder(this)
            .setTitle(R.string.error_details)
            .setView(scroll)
            .setPositiveButton(R.string.copy_error) { _, _ ->
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), message))
                Toast.makeText(this, R.string.error_copied, Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun navigateBackOrFinish() {
        if (!::webView.isInitialized) {
            finish()
            return
        }
        if (webView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) {
            window.insetsController?.hide(WindowInsets.Type.ime())
            return
        }
        if (backNavigationPending) return
        if (!WebNavigation.isCurrentOrigin(webView.url, lastReadyLaunchUrl)) {
            if (webView.canGoBack()) webView.goBack() else finish()
            return
        }
        backNavigationPending = true
        webView.evaluateJavascript(BACK_SCRIPT) { result ->
            backNavigationPending = false
            if (isFinishing || isDestroyed || result == "true") return@evaluateJavascript
            if (webView.canGoBack()) webView.goBack() else finish()
        }
    }

    private fun registerBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val callback = OnBackInvokedCallback { navigateBackOrFinish() }
        backInvokedCallback = callback
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
    }

    private fun unregisterBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val callback = backInvokedCallback as? OnBackInvokedCallback ?: return
        onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
        backInvokedCallback = null
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() = navigateBackOrFinish()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.saveState(outState)
        lastReadyLaunchUrl?.let { outState.putString(STATE_LAUNCH_URL, it) }
        lastErrorMessage?.let { outState.putString(STATE_ERROR, it) }
        pendingDownload?.let { request ->
            outState.putBundle(STATE_PENDING_DOWNLOAD, Bundle().apply {
                putString("url", request.url)
                putString("filename", request.filename)
                putString("mime", request.mimeType)
                putString("userAgent", request.userAgent)
                pendingDownloadDestination?.let { putString("destination", it.toString()) }
            })
        }
        // Callback objects and running transfer handles belong to this Activity
        // and are cancelled on destruction. The replacement must say so.
        outState.putBoolean(STATE_FILE_OPERATION_INTERRUPTED,
            pendingFileSelection != null || downloads.isRunning)
        outState.putBoolean(STATE_CONFIGURATION_EXPORT, pendingConfigurationExport)
    }

    override fun onDestroy() {
        pendingDownload = null
        pendingDownloadDestination = null
        downloads.close()
        pendingFileSelection?.onReceiveValue(null)
        pendingFileSelection = null
        ++uiCheckGeneration
        handler.removeCallbacksAndMessages(null)
        unregisterBackCallback()
        unregisterReceiver(receiver)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val STATE_ERROR = "dsh.startup.error"
        private const val STATE_LAUNCH_URL = "dsh.launch.url"
        private const val STATE_PENDING_DOWNLOAD = "dsh.pending.download"
        private const val STATE_FILE_OPERATION_INTERRUPTED = "dsh.file.operation.interrupted"
        private const val STATE_CONFIGURATION_EXPORT = "dsh.configuration.export"
        private const val FILE_SELECTION_REQUEST = 43
        private const val DOWNLOAD_DESTINATION_REQUEST = 44
        private const val CONFIGURATION_EXPORT_REQUEST = 45
        private val BACK_SCRIPT = """
            (function () {
                try {
                    return typeof window.__DSH_ANDROID_BACK__ === 'function' &&
                        window.__DSH_ANDROID_BACK__() === true;
                } catch (error) { return false; }
            })();
        """.trimIndent()
        private val UI_STATE_SCRIPT = """
            (function () {
                const root = document.getElementById('root');
                const boot = root && root.querySelector('[data-dsh-boot]');
                const error = boot && /Failed to load plugins/.test(boot.innerText) ? boot.innerText : '';
                return {ready: !!root && root.childElementCount > 0 && !boot, error: error};
            })();
        """.trimIndent()
    }
}
