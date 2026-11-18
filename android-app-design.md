# Android App Design: Wizz AYCF Route Finder (Simplified)

## Overview

**Goal:** Create a minimal Android app that reuses the existing Chrome extension HTML/JS code, with Android WebView plumbing to handle the Wizz Air site interaction.

**Key Insight:** The existing extension is already phone-shaped (sidebar). We just need Android to:
1. Host the popup UI in a WebView
2. Provide a controlled WebView for the Wizz Air site
3. Bridge communication between them (replacing Chrome extension APIs)

---

## Architecture (Simplified)

```
Android App
├── MainActivity
│   └── WebView (loads popup.html + popup.js + bulma.min.css)
│
├── WizzDataExtractor
│   └── Hidden WebView (loads multipass.wizzair.com)
│       ├── Extracts window.CVO.routes
│       ├── Extracts dynamic API URL
│       └── Captures auth headers
│
└── JavaScript Bridge
    ├── Android (Kotlin) ↔ JavaScript communication
    ├── Replaces chrome.tabs.* APIs
    └── Replaces localStorage
```

**What stays the same:**
- All HTML/CSS from `popup.html`
- All route-finding logic from `popup.js`
- All scraping logic from `content.js` (with minor modifications)

**What changes:**
- Chrome extension APIs (`chrome.tabs.*`, `chrome.runtime.*`) → JavaScript bridge
- `localStorage` → Android SharedPreferences via bridge

---

## Implementation Steps

### Step 1: Set Up Android Project

**In Android Studio:**
1. File → New → New Project... → **Empty Activity** (not Compose)
2. Name: `WizzRouteFinder`
3. Package name: `com.dgghita.wizzroutefinder`
4. Language: **Kotlin** (not Java)
5. Minimum SDK: **API 24 (Android 7.0)** or higher
6. Click Finish

**Or via command line:**
```bash
# Not recommended; use Android Studio for simplicity
```

---

### Step 2: Add Existing Files to Assets

Copy these files from your extension into `app/src/main/assets/`:
```
app/src/main/assets/
├── popup.html
├── popup.js
├── content.js
└── css/
    └── bulma.min.css
```

**Note:** You may need to create the `assets` folder first (right-click `app/src/main` → New → Folder → Assets Folder).

---

### Step 3: Create MainActivity

```kotlin
// MainActivity.kt
package com.dgghita.wizzroutefinder

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var wizzWebView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // WebView for your UI (popup.html)
        webView = findViewById(R.id.webview)
        configureWebView(webView)

        // Hidden WebView for Wizz Air site
        wizzWebView = WebView(this)
        configureWizzWebView(wizzWebView)

        // Add JavaScript bridge
        webView.addJavascriptInterface(WebAppInterface(), "Android")

        // Load your popup
        webView.loadUrl("file:///android_asset/popup.html")
    }

    private fun configureWebView(webView: WebView) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                // Inject any additional scripts if needed
            }
        }
    }

    private fun configureWizzWebView(webView: WebView) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                // Extract data when Wizz Air page loads
                extractRoutesData(view)
                extractDynamicUrl(view)
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                // Capture auth headers from Wizz Air requests
                request?.requestHeaders?.let { headers ->
                    if (request.url.host == "multipass.wizzair.com") {
                        // Store headers for later use
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }
        }
    }

    private fun extractRoutesData(webView: WebView) {
        webView.evaluateJavascript("""
            (function() {
                if (window.CVO && window.CVO.routes) {
                    return JSON.stringify(window.CVO.routes);
                }
                const match = document.head.innerHTML.match(/\"routes\":\[(.*?)\]\.*?\"isOneWayFlightsOnly\"/gms);
                if (match) {
                    return match[0].split('\"routes\":')[1].split(',\"isOneWayFlightsOnly\"')[0];
                }
                return null;
            })();
        """.trimIndent()) { result ->
            if (result != "null") {
                // Store extracted routes
                // Call back to popup via JavaScript
                webView.evaluateJavascript("window.receiveRoutes(${result});")
            }
        }
    }

    private fun extractDynamicUrl(webView: WebView) {
        webView.evaluateJavascript("""
            (function() {
                if (window.CVO && window.CVO.flightSearchUrlJson) {
                    return window.CVO.flightSearchUrlJson;
                }
                const headMatch = document.head.innerHTML.match(/\"searchFlight\":\"https:\\\/\\\/multipass\\.wizzair\\.com[^\"]+\\\/([^\"]+)\"/);
                if (headMatch) {
                    return 'https://multipass.wizzair.com/w6/subscriptions/json/availability/' + headMatch[1];
                }
                const bodyMatch = document.body.innerHTML.match(/window\\.CVO\\.flightSearchUrlJson\\s*=\\s*\"(https:\\\/\\/[^\"]+)\"/);
                if (bodyMatch) {
                    return bodyMatch[1];
                }
                return null;
            })();
        """.trimIndent()) { result ->
            if (result != "null") {
                // Store dynamic URL
                webView.evaluateJavascript("window.receiveDynamicUrl('${result.removeSurrounding("\"")}');")
            }
        }
    }

    inner class WebAppInterface {

        /**
         * Called from popup.js to open Wizz Air page
         */
        @JavascriptInterface
        fun openWizzAirPage() {
            runOnUiThread {
                wizzWebView.loadUrl("https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets")
            }
        }

        /**
         * Called from popup.js to get stored routes
         */
        @JavascriptInterface
        fun getStoredRoutes(): String? {
            // Return routes stored from WizzWebView
            return null // TODO: Implement
        }

        /**
         * Called from popup.js to get dynamic URL
         */
        @JavascriptInterface
        fun getDynamicUrl(): String? {
            // Return dynamic URL stored from WizzWebView
            return null // TODO: Implement
        }

        /**
         * Called from popup.js to get auth headers
         */
        @JavascriptInterface
        fun getAuthHeaders(): String? {
            // Return auth headers stored from WizzWebView
            return null // TODO: Implement
        }

        /**
         * localStorage replacement
         */
        @JavascriptInterface
        fun localStorageGet(key: String): String? {
            val prefs = getSharedPreferences("wizzrf", MODE_PRIVATE)
            return prefs.getString(key, null)
        }

        @JavascriptInterface
        fun localStorageSet(key: String, value: String) {
            val prefs = getSharedPreferences("wizzrf", MODE_PRIVATE)
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun localStorageRemove(key: String) {
            val prefs = getSharedPreferences("wizzrf", MODE_PRIVATE)
            prefs.edit().remove(key).apply()
        }
    }
}
```

---

### Step 4: Create activity_main.xml

```xml
<!-- app/src/main/res/layout/activity_main.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    tools:context=".MainActivity">

    <WebView
        android:id="@+id/webview"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

</LinearLayout>
```

---

### Step 5: Modify popup.js

Replace Chrome extension APIs with Android bridge calls:

```javascript
// === REPLACE chrome.tabs.query() === 
// OLD:
chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { ... });

// NEW:
if (typeof Android !== 'undefined') {
    Android.openWizzAirPage();
    // Data will be injected via window.receiveRoutes() and window.receiveDynamicUrl()
} else {
    // Fallback for Chrome extension
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { ... });
}


// === REPLACE chrome.tabs.sendMessage() === 
// OLD:
chrome.tabs.sendMessage(tab.id, { action: "getDestinations", origin: origin }, function(response) { ... });

// NEW:
if (typeof Android !== 'undefined') {
    // Data is already injected by Android
    const routes = Android.getStoredRoutes();
    if (routes) {
        // Use routes
    }
} else {
    chrome.tabs.sendMessage(tab.id, { action: "getDestinations", origin: origin }, function(response) { ... });
}


// === REPLACE localStorage === 
// OLD:
localStorage.getItem(key);
localStorage.setItem(key, value);
localStorage.removeItem(key);

// NEW:
if (typeof Android !== 'undefined') {
    // Use Android bridge
    Android.localStorageGet(key);
    Android.localStorageSet(key, value);
    Android.localStorageRemove(key);
} else {
    // Use regular localStorage
    localStorage.getItem(key);
    localStorage.setItem(key, value);
    localStorage.removeItem(key);
}


// === ADD: Receive data from Android === 
// Add these to popup.js
window.receiveRoutes = function(routes) {
    // Store routes for later use
    window.extractedRoutes = routes;
};

window.receiveDynamicUrl = function(url) {
    // Store dynamic URL for later use
    window.dynamicUrl = url;
};
```

---

### Step 6: Update AndroidManifest.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="Wizz Route Finder"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.Light.NoActionBar"
        tools:targetApi="31">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.AppCompat.Light.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>
</manifest>
```

---

### Step 7: Add Dependencies (Optional)

If you want to use newer Android features, add to `app/build.gradle`:

```gradle
dependencies {
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.squareup.okhttp3:okhttp:4.12.0' // Optional for API calls
}
```

---

## Modified Files Summary

### Files to Keep As-Is
- `popup.html` (no changes needed)
- `css/bulma.min.css` (no changes needed)
- Most of `popup.js` (only API replacements needed)

### Files to Modify
- `popup.js` (replace Chrome APIs with Android bridge calls)
- `content.js` (may need minor adjustments for standalone use)

### Files to Create
- `MainActivity.kt`
- `activity_main.xml`
- `AndroidManifest.xml`

---

## How It Works

1. **User opens app** → `MainActivity` loads `popup.html` in a WebView
2. **User clicks "Check Routes"** → `popup.js` calls `Android.openWizzAirPage()`
3. **Android opens Wizz Air** → Hidden WebView loads `multipass.wizzair.com`
4. **Data extraction** → When Wizz Air page loads, `extractRoutesData()` and `extractDynamicUrl()` run
5. **Data injection** → Extracted data is injected back into the popup WebView via `window.receiveRoutes()` and `window.receiveDynamicUrl()`
6. **User sees results** → `popup.js` processes the data and displays flights

---

## Token Expiration (Optional Enhancement)

If you want to add the token expiration countdown from earlier discussions, you can:

1. Track when data was extracted in `MainActivity`
2. Expose a JavaScript interface method like `Android.getTokenExpiry()`
3. Update `popup.js` to display the countdown

But this is optional for the MVP.

---

## Testing

1. Run the app on your device/emulator
2. The popup UI should load
3. Click "Check Routes" → should open Wizz Air in the background
4. Log into Wizz Air if needed
5. Results should appear in the popup

---

## Next Steps

1. **Create the Android Studio project**
2. **Copy your existing files to assets**
3. **Create the layout and activity files**
4. **Modify popup.js** with the bridge replacements
5. **Test and debug**

Would you like me to provide any of these files in full, or do you want to start with the setup and ask questions as you go?
