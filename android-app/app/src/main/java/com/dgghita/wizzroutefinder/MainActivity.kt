package com.dgghita.wizzroutefinder

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var mainWebView: WebView
    private lateinit var wizzWebView: WebView
    private val handler = Handler(Looper.getMainLooper())

    private val authLock = Any()
    private val authHeaders = HashMap<String, String>()

    @Volatile private var routesJson: String? = null
    @Volatile private var dynamicUrl: String? = null
    @Volatile private var notifiedDataReady = false

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

        mainWebView.loadUrl("file:///android_asset/popup.html")

        if (routesJson == null || dynamicUrl == null) {
            showWizzLogin(false)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webChromeClient = WebChromeClient()
            addJavascriptInterface(WizzBridge(), "Android")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWizzWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    if (request.url.host?.endsWith("wizzair.com") == true) {
                        val headers = request.requestHeaders
                        if (!headers.isNullOrEmpty()) {
                            synchronized(authLock) {
                                for ((name, value) in headers) {
                                    if (name.lowercase() !in SKIP_CAPTURE_HEADERS) {
                                        authHeaders[name] = value
                                    }
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
            mainWebView.visibility = View.GONE
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
                    notifyDataReady()
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
                    notifyDataReady()
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
                wizzWebView.visibility = View.GONE
                mainWebView.visibility = View.VISIBLE
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
            wizzWebView.visibility = View.GONE
            mainWebView.visibility = View.VISIBLE
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

        /**
         * Native POST to Wizz Air's availability endpoint. Runs on a bridge
         * worker thread; blocking here is safe (like the extension's fetch,
         * this bypasses CORS entirely).
         */
        @JavascriptInterface
        fun checkRoute(url: String, payloadJson: String): String {
            return try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = 30_000
                connection.readTimeout = 30_000

                val headers = synchronized(authLock) { HashMap(authHeaders) }
                headers["Content-Type"] = "application/json"
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
                JSONObject().put("status", status).put("body", body).toString()
            } catch (e: Exception) {
                JSONObject().put("status", 0).put("body", e.message ?: e.javaClass.simpleName).toString()
            }
        }
    }

    companion object {
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
