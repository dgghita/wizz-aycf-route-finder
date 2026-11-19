package com.dgghita.wizzroutefinder

import android.annotation.SuppressLint
import android.app.Activity
import android.content.res.Configuration
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
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
    private lateinit var closeWizzButton: Button
    private val handler = Handler(Looper.getMainLooper())

    // Background HTTP for the async bridge: the WebView's JS thread must
    // never block on a network call, or nothing paints
    private val httpExecutor = Executors.newFixedThreadPool(2)

    private val authLock = Any()
    private val authHeaders = HashMap<String, String>()

    @Volatile private var routesJson: String? = null
    @Volatile private var dynamicUrl: String? = null
    @Volatile private var notifiedDataReady = false

    // Token expiry (from the JWT `exp` claim in the Authorization header), so
    // the UI can show a real countdown
    @Volatile private var tokenExpiryEpochSeconds: Long? = null
    @Volatile private var tokenCapturedAtEpochSeconds: Long? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this)
        setContentView(root)

        mainWebView = createMainWebView()
        wizzWebView = createWizzWebView()

        root.addView(mainWebView, FrameLayout.LayoutParams(-1, -1))
        root.addView(wizzWebView, FrameLayout.LayoutParams(-1, -1))
        wizzWebView.visibility = View.GONE

        // Fixed X at the top of the (fullscreen) Wizz webview so the user is
        // never stuck there
        closeWizzButton = Button(this).apply {
            text = "X Close"
            visibility = View.GONE
            setOnClickListener { hideWizzWebview() }
        }
        val closeParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.END
        )
        closeParams.setMargins(24, 96, 24, 0)
        root.addView(closeWizzButton, closeParams)

        mainWebView.loadUrl("file:///android_asset/popup.html")

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
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webChromeClient = createConsoleForwardingClient("popup")
            addJavascriptInterface(WizzBridge(), "Android")
        }
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
                    }
                }
            }
        }
    }

    private fun showWizzLogin(clearData: Boolean) {
        handler.post {
            if (clearData) {
                routesJson = null
                dynamicUrl = null
                notifiedDataReady = false
            }
            wizzWebView.loadUrl(WALLETS_URL)
            wizzWebView.visibility = View.VISIBLE
            closeWizzButton.visibility = View.VISIBLE
            mainWebView.visibility = View.GONE
        }
    }

    private fun hideWizzWebview() {
        handler.post {
            wizzWebView.visibility = View.GONE
            closeWizzButton.visibility = View.GONE
            mainWebView.visibility = View.VISIBLE
        }
    }

    private fun tryExtract() {
        if (routesJson == null) {
            wizzWebView.evaluateJavascript(EXTRACT_ROUTES_JS) { result ->
                val parsed = runCatching {
                    JSONTokener(result).nextValue() as? String
                }.getOrNull()
                if (!parsed.isNullOrBlank() && parsed != "null") {
                    routesJson = parsed
                    Log.d(TAG, "routes extracted (${parsed.length} chars)")
                    notifyDataReady()
                } else {
                    Log.d(TAG, "routes extraction returned nothing yet")
                }
            }
        }
        if (dynamicUrl == null) {
            wizzWebView.evaluateJavascript(EXTRACT_URL_JS) { result ->
                val parsed = runCatching {
                    JSONTokener(result).nextValue() as? String
                }.getOrNull()
                if (!parsed.isNullOrBlank() && parsed != "null") {
                    dynamicUrl = parsed
                    Log.d(TAG, "dynamic URL extracted: $parsed")
                    notifyDataReady()
                } else {
                    Log.d(TAG, "dynamic URL extraction returned nothing yet")
                }
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

        @JavascriptInterface
        fun hasWizzData(): Boolean = routesJson != null && dynamicUrl != null

        @JavascriptInterface
        fun getRoutesJson(): String = routesJson ?: ""

        @JavascriptInterface
        fun getDynamicUrl(): String = dynamicUrl ?: ""

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
    }
}
