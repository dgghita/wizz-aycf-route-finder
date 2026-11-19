package com.dgghita.wizzroutefinder

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var mainWebView: WebView
    private lateinit var wizzWebView: WebView
    private lateinit var wizzToolbar: LinearLayout
    private lateinit var closeWizzButton: Button
    private lateinit var reloadWizzButton: Button
    private val handler = Handler(Looper.getMainLooper())

    // Background HTTP for the async bridge: the WebView's JS thread must
    // never block on a network call, or nothing paints
    private val httpExecutor = Executors.newFixedThreadPool(2)

    // Held while a batch runs so a screen-off/unplugged device keeps
    // servicing requests (Doze throttles network and freezes JS timers)
    private var batchWakeLock: PowerManager.WakeLock? = null

    private fun setBatchWakeLock(active: Boolean) {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (active) {
            if (batchWakeLock?.isHeld == true) return
            batchWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "wizzfinder:batch"
            ).apply {
                // Safety cap: a wedged batch must not drain the battery
                acquire(30 * 60 * 1000L)
            }
            Log.d(TAG, "batch wake lock acquired")
        } else {
            batchWakeLock?.takeIf { it.isHeld }?.release()
            batchWakeLock = null
            Log.d(TAG, "batch wake lock released")
        }
    }

    private val authLock = Any()
    private val authHeaders = HashMap<String, String>()

    @Volatile private var routesJson: String? = null
    @Volatile private var dynamicUrl: String? = null
    @Volatile private var notifiedDataReady = false

    /** Captured data survives activity recreation (theme switch, fold/unfold). */
    private fun persistData() {
        getSharedPreferences(DATA_PREFS, MODE_PRIVATE)
            .edit()
            .putString("routesJson", routesJson)
            .putString("dynamicUrl", dynamicUrl)
            .apply()
    }

    // Token expiry (from the JWT `exp` claim in the Authorization header), so
    // the UI can show a real countdown
    @Volatile private var tokenExpiryEpochSeconds: Long? = null
    @Volatile private var tokenCapturedAtEpochSeconds: Long? = null

    /**
     * Theme (light|dark|auto), shared with the page's localStorage toggle.
     * dark/light force the uiMode so the Wizz webviews dark too (algorithmic
     * darkening + prefers-color-scheme); auto leaves the system value.
     */
    private fun appThemeMode(): String =
        getSharedPreferences(THEME_PREFS, MODE_PRIVATE)
            .getString("mode", "auto") ?: "auto"

    private fun isDarkThemeActive(): Boolean =
        when (appThemeMode()) {
            "dark" -> true
            "light" -> false
            // auto: read the system uiMode from the application context — the
            // activity's resources may have been force-wrapped with
            // NIGHT_YES by attachBaseContext at launch and won't track the
            // system switch (this was why "system" was never detected)
            else ->
                (applicationContext.resources.configuration.uiMode and
                    Configuration.UI_MODE_NIGHT_MASK) ==
                    Configuration.UI_MODE_NIGHT_YES
        }

    override fun attachBaseContext(base: Context) {
        val mode =
            base.getSharedPreferences(THEME_PREFS, MODE_PRIVATE)
                .getString("mode", "auto") ?: "auto"
        val nightBits =
            when (mode) {
                "dark" -> Configuration.UI_MODE_NIGHT_YES
                "light" -> Configuration.UI_MODE_NIGHT_NO
                else -> null
            }
        super.attachBaseContext(
            if (nightBits == null) {
                base
            } else {
                val config = Configuration(base.resources.configuration)
                config.uiMode =
                    nightBits or
                        (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv())
                base.createConfigurationContext(config)
            }
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Kill the white flash while the webviews load: background follows
        // the theme the same way the page's pre-paint script does
        val bg = if (isDarkThemeActive()) 0xFF1E1E1E.toInt() else 0xFFFFFFFF.toInt()
        window.setBackgroundDrawable(ColorDrawable(bg))

        root = FrameLayout(this)
        setContentView(root)

        mainWebView = createMainWebView()
        wizzWebView = createWizzWebView()
        mainWebView.setBackgroundColor(bg)
        wizzWebView.setBackgroundColor(bg)

        root.addView(mainWebView, FrameLayout.LayoutParams(-1, -1))
        root.addView(wizzWebView, FrameLayout.LayoutParams(-1, -1))
        wizzWebView.visibility = View.GONE

        // Toolbar on top of the (fullscreen) Wizz webview: Reload and Close,
        // so the user is never stuck there and can refresh a stale page
        wizzToolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            visibility = View.GONE
            setPadding(24, 32, 24, 8)
        }
        reloadWizzButton = Button(this).apply {
            text = "Reload"
            setOnClickListener { wizzWebView.reload() }
        }
        wizzToolbar.addView(reloadWizzButton)
        closeWizzButton = Button(this).apply {
            text = "Close"
            setOnClickListener { hideWizzWebview() }
        }
        wizzToolbar.addView(closeWizzButton)
        root.addView(
            wizzToolbar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        )

        mainWebView.loadUrl("file:///android_asset/popup.html")

        // Restore the last capture so a theme switch (recreate) or process
        // death doesn't force the user through the login webview again
        val dataPrefs = getSharedPreferences(DATA_PREFS, MODE_PRIVATE)
        routesJson = dataPrefs.getString("routesJson", null)
        dynamicUrl = dataPrefs.getString("dynamicUrl", null)

        if (routesJson == null || dynamicUrl == null) {
            showWizzLogin(false)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Fold/unfold: with the config change handled here (no Activity
        // recreation) the WebView's drawing surface can keep the stale size
        // until something re-layouts. Kick it on this frame and the next,
        // since the window may not have finished resizing yet.
        val kick = Runnable {
            root.forceLayout()
            root.invalidate()
            for (view in listOf(mainWebView, wizzWebView)) {
                if (view.visibility != View.GONE) {
                    view.forceLayout()
                    view.invalidate()
                }
            }
        }
        root.post(kick)
        root.postDelayed(kick, 120)

        // System dark-mode flip while the popup is open: re-resolve the
        // theme (auto mode asks the bridge, which reads the new uiMode)
        mainWebView.evaluateJavascript(
            "typeof applyStoredTheme === 'function' && applyStoredTheme();",
            null
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webChromeClient = createConsoleForwardingClient("popup")
            addJavascriptInterface(WizzBridge(), "Android")
            webViewClient = object : WebViewClient() {
                // The popup is a local file; anything else (e.g. the footer's
                // Changelog link) belongs to the system browser. Handing it
                // over stops the WebView from navigating away and letting the
                // back button exit the app.
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    // Local popup content stays in the WebView
                    if (url.scheme in setOf("file", "data", "about", "javascript")) {
                        return false
                    }
                    // http(s) or anything exotic: system browser's job
                    try {
                        startActivity(
                            android.content.Intent(android.content.Intent.ACTION_VIEW, url)
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "no activity to open $url")
                    }
                    return true
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    rebuildMainWebView()
                    return true
                }
            }
        }
    }

    /**
     * Renderer crash recovery: the killed WebView must leave the view tree
     * (or Android takes the whole app down). Replace it with a fresh one and
     * reload the popup — captured data and theme prefs survive in storage.
     */
    private fun rebuildMainWebView() {
        val bg = if (isDarkThemeActive()) 0xFF1E1E1E.toInt() else 0xFFFFFFFF.toInt()
        val dead = mainWebView
        root.removeView(dead)
        dead.destroy()
        mainWebView = createMainWebView()
        mainWebView.setBackgroundColor(bg)
        root.addView(mainWebView, 0, FrameLayout.LayoutParams(-1, -1))
        mainWebView.loadUrl("file:///android_asset/popup.html")
        Log.d(TAG, "main webview rebuilt after renderer crash")
    }

    /** Mirror WebView console output to logcat so `adb logcat` shows JS logs. */
    private fun createConsoleForwardingClient(source: String): WebChromeClient {
        return object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                if (consoleMessage != null) {
                    Log.d(
                        TAG,
                        "[$source] ${consoleMessage.message()} " +
                            "(${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})"
                    )
                }
                return true
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWizzWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Wizz pages are not adaptive; algorithmic darkening force-darkens
            // them when the theme (or the forced uiMode) is night. The main
            // webview must NOT get this: the popup CSS has its own dark theme.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                settings.isAlgorithmicDarkeningAllowed = true
            }
            webChromeClient = createConsoleForwardingClient("wizz")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    if (request.url.host?.endsWith("wizzair.com") == true) {
                        val headers = request.requestHeaders
                        if (!headers.isNullOrEmpty()) {
                            val knownKeys: Set<String>
                            synchronized(authLock) {
                                knownKeys = authHeaders.keys.toSet()
                                for ((name, value) in headers) {
                                    if (name.lowercase() !in SKIP_CAPTURE_HEADERS) {
                                        authHeaders[name] = value
                                    }
                                    if (name.equals("authorization", ignoreCase = true)) {
                                        val expiry = parseJwtExpiry(value)
                                        if (expiry != null && expiry != tokenExpiryEpochSeconds) {
                                            tokenExpiryEpochSeconds = expiry
                                            tokenCapturedAtEpochSeconds =
                                                System.currentTimeMillis() / 1000
                                            Log.d(
                                                TAG,
                                                "token expiry parsed: $expiry " +
                                                    "(captured at ${tokenCapturedAtEpochSeconds})"
                                            )
                                        }
                                    }
                                }
                                if (authHeaders.keys != knownKeys) {
                                    Log.d(TAG, "captured headers: ${authHeaders.keys}")
                                }
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    if (url?.startsWith("https://multipass.wizzair.com") == true) {
                        // The page is a SPA; give it a moment to populate window.CVO
                        handler.postDelayed({ tryExtract() }, 1500)
                        handler.postDelayed({ tryExtract() }, 6000)
                        // Remember/pre-fill the login form (no browser behind
                        // the webview, so we keep the credentials ourselves)
                        handler.postDelayed({ injectCredentialHooks(view) }, 1500)
                        handler.postDelayed({ injectCredentialHooks(view) }, 4500)
                    }
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    rebuildWizzWebView()
                    return true
                }
            }
        }
    }

    private fun rebuildWizzWebView() {
        val bg = if (isDarkThemeActive()) 0xFF1E1E1E.toInt() else 0xFFFFFFFF.toInt()
        val wasVisible = wizzWebView.visibility == View.VISIBLE
        val dead = wizzWebView
        root.removeView(dead)
        dead.destroy()
        wizzWebView = createWizzWebView()
        wizzWebView.setBackgroundColor(bg)
        root.addView(wizzWebView, 1, FrameLayout.LayoutParams(-1, -1))
        if (wasVisible) {
            wizzWebView.loadUrl(WALLETS_URL)
            wizzToolbar.visibility = View.VISIBLE
        } else {
            wizzWebView.visibility = View.GONE
        }
        Log.d(TAG, "wizz webview rebuilt after renderer crash")
    }

    private fun showWizzLogin(clearData: Boolean) {
        handler.post {
            if (clearData) {
                routesJson = null
                dynamicUrl = null
                notifiedDataReady = false
                getSharedPreferences(DATA_PREFS, MODE_PRIVATE)
                    .edit().clear().apply()
            }
            wizzWebView.loadUrl(WALLETS_URL)
            wizzWebView.visibility = View.VISIBLE
            wizzToolbar.visibility = View.VISIBLE
            mainWebView.visibility = View.GONE
        }
    }

    private fun hideWizzWebview() {
        handler.post {
            wizzWebView.visibility = View.GONE
            wizzToolbar.visibility = View.GONE
            mainWebView.visibility = View.VISIBLE
            // Returning from the Wizz page: refresh the session chip right
            // away (close = back too, so both paths get it)
            mainWebView.evaluateJavascript(
                "typeof checkSessionStatus === 'function' && " +
                    "checkSessionStatus().catch(function() {});",
                null
            )
        }
    }

    /**
     * Inject the credential remember/pre-fill script into the Wizz page.
     * Listeners install once per document; pre-fill runs on every injection
     * so a late-rendered SPA login form still gets filled.
     */
    private fun injectCredentialHooks(view: WebView) {
        val prefs = getSharedPreferences(CREDS_PREFS, MODE_PRIVATE)
        val user = prefs.getString("username", "") ?: ""
        val pass = prefs.getString("password", "") ?: ""
        val js = CRED_HOOK_JS
            .replace("__SAVED_USER__", JSONObject.quote(user))
            .replace("__SAVED_PASS__", JSONObject.quote(pass))
        view.evaluateJavascript(js, null)
        Log.d(TAG, "credential hooks injected")
    }

    private fun tryExtract() {
        // Always re-extract and overwrite: routes update often, and every
        // fresh page load (login, manual Reload, Wizz Page button) should
        // refresh the capture — not just the very first one. This is what
        // made the old Re-login button redundant.
        wizzWebView.evaluateJavascript(EXTRACT_ROUTES_JS) { result ->
            val parsed = runCatching {
                JSONTokener(result).nextValue() as? String
            }.getOrNull()
            if (!parsed.isNullOrBlank() && parsed != "null") {
                routesJson = parsed
                persistData()
                Log.d(TAG, "routes extracted (${parsed.length} chars)")
                notifyDataReady()
            } else {
                Log.d(TAG, "routes extraction returned nothing yet")
            }
        }
        wizzWebView.evaluateJavascript(EXTRACT_URL_JS) { result ->
            val parsed = runCatching {
                JSONTokener(result).nextValue() as? String
            }.getOrNull()
            if (!parsed.isNullOrBlank() && parsed != "null") {
                dynamicUrl = parsed
                persistData()
                Log.d(TAG, "dynamic URL extracted: $parsed")
                notifyDataReady()
            } else {
                Log.d(TAG, "dynamic URL extraction returned nothing yet")
            }
        }
    }

    private fun notifyDataReady() {
        if (routesJson != null && dynamicUrl == null) {
            handler.post { tryExtract() }
            return
        }
        if (routesJson != null && dynamicUrl != null && !notifiedDataReady) {
            notifiedDataReady = true
            handler.post {
                hideWizzWebview()
                mainWebView.evaluateJavascript(
                    "window.__onWizzDataReady && window.__onWizzDataReady()",
                    null
                )
                Toast.makeText(this, "Wizz Air session captured", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (wizzWebView.visibility == View.VISIBLE) {
            hideWizzWebview()
        } else {
            super.onBackPressed()
        }
    }

    inner class WizzBridge {

        /** Show the Wizz Air login page only when we have no data yet. */
        @JavascriptInterface
        fun openWizzLogin() {
            if (routesJson == null || dynamicUrl == null) {
                showWizzLogin(false)
            }
        }

        /** Unconditionally show the Wizz page, keeping any captured data. */
        @JavascriptInterface
        fun openWizzPage() {
            showWizzLogin(false)
        }

        /** Force the login page to show, discarding any captured data. */
        @JavascriptInterface
        fun forceReLogin() {
            showWizzLogin(true)
        }

        /**
         * Page-side theme switch (light|dark|auto), from the popup's toggle.
         * Persist only: the popup applies its own dark theme via CSS, so
         * recreating here (the previous behaviour) just churned WebViews and
         * destabilized the app. The Wizz page webview picks the new uiMode up
         * on next launch.
         */
        @JavascriptInterface
        fun setAppTheme(mode: String) {
            val cleaned = if (mode == "light" || mode == "dark") mode else "auto"
            getSharedPreferences(THEME_PREFS, MODE_PRIVATE)
                .edit()
                .putString("mode", cleaned)
                .apply()
            Log.d(TAG, "app theme set to $cleaned (no recreation)")
            runOnUiThread {
                val bg =
                    if (isDarkThemeActive()) 0xFF1E1E1E.toInt()
                    else 0xFFFFFFFF.toInt()
                window.setBackgroundDrawable(ColorDrawable(bg))
                mainWebView.setBackgroundColor(bg)
            }
        }

        @JavascriptInterface
        fun hasWizzData(): Boolean = routesJson != null && dynamicUrl != null

        /**
         * Whether the app currently renders dark (explicit dark, explicit
         * light, or the system uiMode for auto). The popup asks this instead
         of trusting the WebView's prefers-color-scheme, which does not
         reliably track system dark mode.
         */
        @JavascriptInterface
        fun isAppDarkTheme(): Boolean = isDarkThemeActive()

        /** Presence of each captured piece, for the status chip's verdicts. */
        @JavascriptInterface
        fun hasRoutes(): Boolean = routesJson != null

        @JavascriptInterface
        fun hasDynamicUrl(): Boolean = dynamicUrl != null

        @JavascriptInterface
        fun getRoutesJson(): String = routesJson ?: ""

        @JavascriptInterface
        fun getDynamicUrl(): String = dynamicUrl ?: ""

        /**
         * Called by the page when a batch starts (active=true) and ends
         * (active=false): holds a partial wakelock so screen-off batches
         * keep running through Doze.
         */
        @JavascriptInterface
        fun batchKeepAlive(active: Boolean) {
            setBatchWakeLock(active)
        }

        /**
         * Called by the page's credential hook when the user submits the
         * login form: remember the credentials for future pre-fill. Stored
         * plaintext in app-private storage (personal app, local device).
         */
        @JavascriptInterface
        fun saveWizzCredentials(username: String, password: String) {
            if (username.isEmpty() || password.isEmpty()) return
            getSharedPreferences(CREDS_PREFS, MODE_PRIVATE)
                .edit()
                .putString("username", username)
                .putString("password", password)
                .apply()
            Log.d(TAG, "wizz credentials saved (username length ${username.length})")
        }

        /** JWT expiry info for the session countdown, or hasToken=false. */
        @JavascriptInterface
        fun getTokenInfo(): String {
            val expiry = tokenExpiryEpochSeconds
            return if (expiry == null) {
                JSONObject().put("hasToken", false).toString()
            } else {
                JSONObject()
                    .put("hasToken", true)
                    .put("expiresAtEpochSeconds", expiry)
                    .put("capturedAtEpochSeconds", tokenCapturedAtEpochSeconds ?: 0L)
                    .toString()
            }
        }

        /**
         * Native POST to Wizz Air's availability endpoint — async. The old
         * synchronous variant blocked the WebView's JS thread on the HTTP
         * call, which froze the whole UI (no paints) for every request.
         * Runs on a background executor and delivers the JSON response via
         * window.__nativeHttpCallback(callbackId, response).
         */
        @JavascriptInterface
        fun checkRoute(url: String, payloadJson: String, callbackId: String) {
            postAsync(url, payloadJson, callbackId, fullBodyLog = false)
        }

        /**
         * Cheap async session probe: a minimal availability POST. Wizz answers
         * 401/403 when the session is dead regardless of payload, so any
         * other status means the auth headers are still accepted.
         */
        @JavascriptInterface
        fun checkSession(callbackId: String) {
            val url = dynamicUrl
            if (url == null) {
                deliverToJs(
                    callbackId,
                    JSONObject().put("status", 0).put("body", "no dynamic URL").toString()
                )
                return
            }
            val probePayload = JSONObject().apply {
                put("flightType", "OW")
                put("origin", "AAA")
                put("destination", "BBB")
                put("departure", "2030-01-01")
                put("arrival", "")
                put("intervalSubtype", JSONObject.NULL)
            }
            postAsync(url, probePayload.toString(), callbackId, fullBodyLog = true)
        }

        private fun postAsync(url: String, payloadJson: String, callbackId: String, fullBodyLog: Boolean) {
            httpExecutor.execute {
                deliverToJs(callbackId, executePost(url, payloadJson, fullBodyLog))
            }
        }

        private fun deliverToJs(callbackId: String, json: String) {
            runOnUiThread {
                mainWebView.evaluateJavascript(
                    "window.__nativeHttpCallback && window.__nativeHttpCallback(" +
                        JSONObject.quote(callbackId) + ", " + json + ");",
                    null
                )
            }
        }

        private fun executePost(url: String, payloadJson: String, fullBodyLog: Boolean): String {
            val startedAt = System.currentTimeMillis()
            Log.d(TAG, "POST $url payload=$payloadJson")
            return try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = 30_000
                connection.readTimeout = 30_000

                val headers = synchronized(authLock) { HashMap(authHeaders) }
                headers["Content-Type"] = "application/json"
                // shouldInterceptRequest never exposes the WebView's cookies,
                // so replay them explicitly: Wizz binds the JWT to the cookie
                // session, and without them it answers 500 error.token.mismatch
                runCatching {
                    val cookies = CookieManager.getInstance().getCookie(url)
                    if (!cookies.isNullOrEmpty() && headers.keys.none { it.equals("Cookie", ignoreCase = true) }) {
                        headers["Cookie"] = cookies
                    }
                }
                for ((name, value) in headers) {
                    if (name.lowercase() !in SKIP_SEND_HEADERS) {
                        runCatching { connection.setRequestProperty(name, value) }
                    }
                }

                connection.outputStream.use { out ->
                    out.write(payloadJson.toByteArray(Charsets.UTF_8))
                }

                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                val elapsed = System.currentTimeMillis() - startedAt
                Log.d(TAG, "-> $status in ${elapsed}ms body: ${body.take(BODY_LOG_SNIPPET)}")
                if (status == 429 && body.isNotEmpty()) {
                    Log.w(TAG, "429 body: ${body.take(RATE_LIMIT_BODY_LOG)}")
                }
                val responseHeaders = JSONObject()
                for ((name, value) in connection.headerFields) {
                    if (name != null) {
                        responseHeaders.put(name, value.joinToString(", "))
                    }
                }
                JSONObject()
                    .put("status", status)
                    .put("body", body)
                    .put("headers", responseHeaders)
                    .toString()
            } catch (e: Exception) {
                val elapsed = System.currentTimeMillis() - startedAt
                Log.e(TAG, "-> failed after ${elapsed}ms: ${e.message}", e)
                JSONObject().put("status", 0).put("body", e.message ?: e.javaClass.simpleName).toString()
            }
        }
    }

    companion object {
        private const val TAG = "WizzFinder"
        private const val BODY_LOG_SNIPPET = 200
        private const val RATE_LIMIT_BODY_LOG = 1000
        private const val CREDS_PREFS = "wizz-credentials"
        private const val THEME_PREFS = "wizz-theme"
        private const val DATA_PREFS = "wizz-data"

        /** Decode the `exp` claim from a JWT-shaped Authorization value. */
        private fun parseJwtExpiry(value: String): Long? {
            val token = value.removePrefix("Bearer ").trim()
            val parts = token.split(".")
            if (parts.size != 3) return null
            return try {
                val payload = String(
                    Base64.decode(
                        parts[1],
                        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
                    ),
                    Charsets.UTF_8
                )
                val exp = JSONObject(payload).optLong("exp", -1L)
                if (exp > 0) exp else null
            } catch (e: Exception) {
                null
            }
        }

        private const val WALLETS_URL =
            "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"

        private val SKIP_CAPTURE_HEADERS = setOf("host", "content-length")
        private val SKIP_SEND_HEADERS = setOf(
            "host", "content-length", "connection", "accept-encoding", "range"
        )

        private val EXTRACT_ROUTES_JS = """
            (function() {
                try {
                    if (window.CVO && window.CVO.routes) {
                        return JSON.stringify(window.CVO.routes);
                    }
                    var headMatch = document.head.innerHTML.match(/"routes":\[(.*?)\][\s\S]*?"isOneWayFlightsOnly"/);
                    var bodyMatch = document.body.innerHTML.match(/window\.CVO\.routes\s*=\s*(\[[\s\S]*?\]);/);
                    var raw = null;
                    if (headMatch && headMatch[0]) {
                        raw = '{"routes":' + headMatch[0].split('"routes":')[1].split(',"isOneWayFlightsOnly"')[0] + '}';
                    } else if (bodyMatch && bodyMatch[1]) {
                        raw = '{"routes":' + bodyMatch[1] + '}';
                    }
                    if (raw) {
                        return JSON.stringify(JSON.parse(raw).routes);
                    }
                } catch (e) {}
                return null;
            })()
        """.trimIndent()

        private val EXTRACT_URL_JS = """
            (function() {
                try {
                    if (window.CVO && window.CVO.flightSearchUrlJson) {
                        return window.CVO.flightSearchUrlJson;
                    }
                    var headMatch = document.head.innerHTML.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
                    if (headMatch && headMatch[1]) {
                        return "https://multipass.wizzair.com/w6/subscriptions/json/availability/" + headMatch[1];
                    }
                    var bodyMatch = document.body.innerHTML.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/[^"]+)"/);
                    if (bodyMatch && bodyMatch[1]) {
                        return bodyMatch[1];
                    }
                } catch (e) {}
                return null;
            })()
        """.trimIndent()

        /**
         * Credential remember/pre-fill for the Wizz login form. The app
         * replaces __SAVED_USER__ / __SAVED_PASS__ with JSON-quoted values
         * (or "" when nothing is saved yet). The React-style native setter +
         * input events make SPA-bound fields actually accept the values.
         */
        private val CRED_HOOK_JS = """
            (function() {
                function findEmail() {
                    return document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
                }
                function findPassword() {
                    return document.querySelector('input[type="password"]');
                }
                function setValue(input, value) {
                    if (!input || !value) return;
                    var setter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, value);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
                function capture() {
                    try {
                        var email = findEmail(); var pass = findPassword();
                        if (email && pass && email.value && pass.value) {
                            window.Android.saveWizzCredentials(email.value, pass.value);
                        }
                    } catch (e) {}
                }
                if (!window.__wizzCredHook) {
                    window.__wizzCredHook = true;
                    document.addEventListener('click', function(ev) {
                        var el = ev.target.closest &&
                            ev.target.closest('button, input[type="submit"], [role="button"]');
                        if (el) capture();
                    }, true);
                    document.addEventListener('submit', capture, true);
                }
                var savedUser = __SAVED_USER__;
                var savedPass = __SAVED_PASS__;
                if (savedUser && savedPass) {
                    function prefill() {
                        var email = findEmail(); var pass = findPassword();
                        if (email && pass && !email.value && !pass.value) {
                            setValue(email, savedUser);
                            setValue(pass, savedPass);
                        }
                    }
                    prefill();
                    setTimeout(prefill, 3000);
                }
            })()
        """.trimIndent()
    }
}
