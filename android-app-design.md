# Android App Design: Wizz AYCF Route Finder

## Overview

This document outlines the complete design for converting the Chrome extension "Wizz AYCF Route Finder" into a **native Android application**. The key motivation is to avoid browser security restrictions (Same-Origin Policy) that prevent a hosted web app from reading data from `multipass.wizzair.com`.

The Android app uses an embedded **WebView** to:
1. Allow users to authenticate with Wizz Air's Multipass website
2. Extract necessary data (routes, dynamic API URL, auth headers)
3. Use that data to make API calls from the native app
4. Display results in a native UI with a **token expiration countdown** and **re-authenticate button**

---

## Architecture

```
WizzRouteFinder (Android App)
├── MainActivity (Navigation Host)
│
├── LoginScreen
│   └── WebView → https://multipass.wizzair.com/...
│       ├── Extracts window.CVO.routes from page
│       ├── Extracts dynamic API URL from page
│       └── Captures auth headers from network requests
│
├── WizzViewModel (State Management)
│   ├── Holds extracted routes
│   ├── Holds dynamic API URL
│   ├── Holds auth headers
│   ├── Tracks tokenExpiryTime
│   └── Exposes tokenExpiryRemaining (derived state)
│
├── WizzApiClient (Network Layer)
│   └── Makes POST requests to Wizz Air's API
│       ├── Uses extracted dynamic URL
│       ├── Includes captured auth headers
│       └── Throws TokenExpiredException on 401/403
│
└── RouteFinderScreen (Main UI)
    ├── Search controls (airport, date, type)
    ├── Results list
    └── TokenExpiryBanner (countdown + re-login button)
```

---

## Key Features

### 1. Token Expiration Handling

The app implements **three complementary mechanisms** to handle token expiration:

| Mechanism | Description | Accuracy |
|-----------|-------------|----------|
| **Estimated Countdown** | Starts a 20-minute timer when user authenticates | ⚠️ Good enough |
| **API Error Detection** | Catches 401/403 responses from Wizz Air | ✅ 100% accurate |
| **Manual Re-login Button** | User can trigger re-authentication at any time | ✅ User-controlled |

#### State Flow

```
User logs in → ViewModel.onLoginSuccess()
    → tokenExpiryTime = now + 20 minutes
    → tokenExpiryRemaining flows to UI
    → TokenExpiryBanner displays countdown

API call returns 401/403 → WizzApiClient throws TokenExpiredException
    → ViewModel.markSessionExpired()
    → tokenExpiryTime = 0
    → TokenExpiryBanner shows "Session expired"

User taps "Re-login" → Navigates to LoginScreen
    → ViewModel.resetSession()
    → All data cleared
```

---

## Implementation Details

### 1. Data Models

#### Route and Station
```kotlin
// Models for route data extracted from Wizz Air
data class Route(
    val departureStation: Station,
    val arrivalStations: List<Station>
)

data class Station(
    val id: String,       // e.g., "LTN"
    val name: String?    // e.g., "London Luton"
)
```

#### Flight
```kotlin
// Model for flight search results
data class Flight(
    val route: String,
    val date: String,
    val departure: String,
    val arrival: String,
    val flightCode: String,
    val duration: String
)
```

---

### 2. WizzViewModel

Central state management using Kotlin Flow and ViewModel.

```kotlin
@HiltViewModel
class WizzViewModel : ViewModel() {

    // --- Core Data ---
    
    private val _routes = MutableStateFlow<List<Route>?>(null)
    val routes: StateFlow<List<Route>?> = _routes

    private val _dynamicUrl = MutableStateFlow<String?>(null)
    val dynamicUrl: StateFlow<String?> = _dynamicUrl

    private val _authHeaders = MutableStateFlow<Map<String, String>?>(null)
    val authHeaders: StateFlow<Map<String, String>?> = _authHeaders

    // --- Token Expiration Tracking ---
    
    private val _tokenExpiryTime = MutableStateFlow<Long?>(null)
    val tokenExpiryTime: StateFlow<Long?> = _tokenExpiryTime

    // Remaining time in milliseconds (derived state)
    val tokenExpiryRemaining: StateFlow<Long?> = tokenExpiryTime
        .map { expiryTime ->
            expiryTime?.let { maxOf(0, it - System.currentTimeMillis()) }
        }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = null
        )

    // Whether the session is expired or not yet initialized
    val isSessionExpired: StateFlow<Boolean> = tokenExpiryRemaining
        .map { it == null || it <= 0 }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = true
        )

    // --- Public Methods ---
    
    /** Called when user successfully authenticates */
    fun onLoginSuccess() {
        // Wizz Air sessions typically last ~15-30 minutes
        // Use 20 minutes as a conservative estimate
        _tokenExpiryTime.value = System.currentTimeMillis() + (20 * 60 * 1000)
    }

    /** Called when API returns 401/403 */
    fun markSessionExpired() {
        _tokenExpiryTime.value = 0
    }

    /** Clear all session data */
    fun resetSession() {
        _routes.value = null
        _dynamicUrl.value = null
        _authHeaders.value = null
        _tokenExpiryTime.value = null
    }

    /** Save extracted routes */
    fun saveRoutes(json: String) {
        try {
            // Clean up JSON if needed
            val cleanJson = if (!json.startsWith("[")) {
                json.substring(json.indexOf('['))
            } else {
                json
            }
            val routesArray = JSONArray(cleanJson)
            _routes.value = parseRoutes(routesArray)
        } catch (e: Exception) {
            Log.e("WizzViewModel", "Failed to parse routes", e)
        }
    }

    /** Save dynamic API URL */
    fun saveDynamicUrl(url: String) {
        _dynamicUrl.value = url
    }

    /** Save auth headers from WebView requests */
    fun saveAuthHeaders(headers: Map<String, String>) {
        _authHeaders.value = headers
    }

    /** Check if we have all required data */
    fun hasAllData(): Boolean {
        return _routes.value != null 
            && _dynamicUrl.value != null 
            && _authHeaders.value != null
    }

    // Optional: Try to extract actual expiry from Set-Cookie headers
    private fun extractExpiryFromHeaders(headers: Map<String, String>): Long? {
        headers["Set-Cookie"]?.let { cookieString ->
            // Try to find expires= date
            val expiresMatch = """expires=([^;]+)""".toRegex().find(cookieString)
            expiresMatch?.groupValues?.get(1)?.let { dateStr ->
                return try {
                    SimpleDateFormat("EEE, dd-MMM-yyyy HH:mm:ss 'GMT'", Locale.US)
                        .parse(dateStr)?.time
                } catch (e: Exception) {
                    null
                }
            }
            // Try to find Max-Age
            val maxAgeMatch = """Max-Age=(\d+)""".toRegex().find(cookieString)
            maxAgeMatch?.groupValues?.get(1)?.toLongOrNull()?.let { maxAge ->
                return System.currentTimeMillis() + (maxAge * 1000)
            }
        }
        return null
    }

    private fun parseRoutes(routesArray: JSONArray): List<Route> {
        // Parse JSON array into Route objects
        // Implementation depends on Wizz Air's data structure
    }
}
```

---

### 3. WizzApiClient

Handles API requests to Wizz Air's endpoints.

```kotlin
class WizzApiClient(
    private val dynamicUrl: String,
    private val authHeaders: Map<String, String>
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Check flight availability for a specific route and date.
     * 
     * @throws TokenExpiredException if session is no longer valid (401/403)
     * @throws RateLimitedException if too many requests (429)
     * @throws ApiException for other HTTP errors
     */
    @Throws(
        TokenExpiredException::class,
        RateLimitedException::class,
        ApiException::class
    )
    suspend fun checkRoute(
        origin: String,
        destination: String,
        date: String
    ): List<Flight> {
        val json = """
            {
                "flightType": "OW",
                "origin": "$origin",
                "destination": "$destination",
                "departure": "$date",
                "arrival": "",
                "intervalSubtype": null
            }
        """.trimIndent()

        val request = Request.Builder()
            .url(dynamicUrl)
            .post(json.toRequestBody("application/json".toMediaType()))
            .headers(
                Headers.Builder()
                    .apply { authHeaders.forEach { (k, v) -> add(k, v) } }
                    .add("Content-Type", "application/json")
                    .build()
            )
            .build()

        return withContext(Dispatchers.IO) {
            try {
                val response = client.newCall(request).execute()
                
                // Check for token expiration
                if (response.code == 401 || response.code == 403) {
                    throw TokenExpiredException("Session expired - please re-authenticate")
                }
                
                // Check for rate limiting
                if (response.code == 429) {
                    throw RateLimitedException("Rate limited - please wait a few minutes")
                }
                
                if (!response.isSuccessful) {
                    throw ApiException("HTTP error: ${response.code}")
                }
                
                val body = response.body?.string() ?: throw ApiException("Empty response")
                parseFlights(body)
            } catch (e: Exception) {
                Log.e("WizzApiClient", "API call failed", e)
                throw e
            }
        }
    }

    private fun parseFlights(json: String): List<Flight> {
        return try {
            val data = JSONObject(json)
            val flightsArray = data.getJSONArray("flightsOutbound")
            (0 until flightsArray.length()).map { i ->
                val flightJson = flightsArray.getJSONObject(i)
                Flight(
                    route = "${flightJson.getString("departureStationText")} to ${flightJson.getString("arrivalStationText")}",
                    date = flightJson.getString("departureDate"),
                    departure = flightJson.getString("departure"),
                    arrival = flightJson.getString("arrival"),
                    flightCode = flightJson.getString("flightCode"),
                    duration = flightJson.getString("duration")
                )
            }
        } catch (e: Exception) {
            Log.e("WizzApiClient", "Failed to parse flights", e)
            emptyList()
        }
    }
}

// Custom exceptions for error handling
class TokenExpiredException(message: String) : Exception(message)
class RateLimitedException(message: String) : Exception(message)
class ApiException(message: String) : Exception(message)
```

---

### 4. TokenExpiryBanner

Composable that displays the countdown timer and re-authenticate button.

```kotlin
@Composable
fun TokenExpiryBanner(
    viewModel: WizzViewModel,
    onReauthenticate: () -> Unit,
    modifier: Modifier = Modifier
) {
    val remainingMillis by viewModel.tokenExpiryRemaining.collectAsState()
    val isExpired by viewModel.isSessionExpired.collectAsState()

    remainingMillis?.let { remaining ->
        val minutes = (remaining / 1000 / 60).toInt()
        val seconds = ((remaining / 1000) % 60).toInt()

        // Determine color based on time remaining
        val color = when {
            isExpired -> MaterialTheme.colorScheme.error
            minutes < 2 -> MaterialTheme.colorScheme.errorContainer
            minutes < 5 -> MaterialTheme.colorScheme.tertiaryContainer
            else -> MaterialTheme.colorScheme.primaryContainer
        }

        // Determine text based on state
        val text = when {
            isExpired -> "⏰ Session expired - Please re-authenticate"
            minutes == 0 && seconds > 0 -> "⏰ Session expires in: $seconds s"
            minutes > 0 -> "⏰ Session expires in: ${minutes}m ${seconds}s"
            else -> "⏰ Session expiring soon!"
        }

        // Determine button colors
        val buttonContainerColor = if (isExpired) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.secondaryContainer
        }
        val buttonContentColor = if (isExpired) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSecondaryContainer
        }

        Row(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .background(color, RoundedCornerShape(8.dp))
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (isExpired) {
                    MaterialTheme.colorScheme.onError
                } else {
                    MaterialTheme.colorScheme.onPrimaryContainer
                }
            )

            Button(
                onClick = onReauthenticate,
                colors = ButtonDefaults.buttonColors(
                    containerColor = buttonContainerColor,
                    contentColor = buttonContentColor
                ),
                modifier = Modifier.padding(start = 8.dp)
            ) {
                Text("Re-login")
            }
        }
    }
}
```

---

### 5. LoginScreen

Handles the WebView authentication flow.

```kotlin
@Composable
fun LoginScreen(
    viewModel: WizzViewModel,
    onLoginSuccess: () -> Unit
) {
    val context = LocalContext.current
    val webView = remember { WebView(context) }

    // Track if we've extracted all data
    LaunchedEffect(viewModel.hasAllData()) {
        if (viewModel.hasAllData()) {
            viewModel.onLoginSuccess()
            onLoginSuccess()
        }
    }

    // Configure WebView
    LaunchedEffect(Unit) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                // Capture auth headers from requests to Wizz Air
                request?.requestHeaders?.let { headers ->
                    if (request.url.host == "multipass.wizzair.com") {
                        viewModel.saveAuthHeaders(headers)
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                // Extract data when page finishes loading
                extractRoutesData(view)
                extractDynamicUrl(view)
            }
        }

        webView.loadUrl("https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets")
    }

    // Extract routes from the page
    fun extractRoutesData(webView: WebView) {
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
                viewModel.saveRoutes(result)
            }
        }
    }

    // Extract dynamic URL from the page
    fun extractDynamicUrl(webView: WebView) {
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
                viewModel.saveDynamicUrl(result.removeSurrounding("\""))
            }
        }
    }

    // Display WebView
    AndroidView(
        factory = { webView },
        modifier = Modifier.fillMaxSize()
    )
}
```

---

### 6. RouteFinderScreen

Main screen for searching and viewing flight results.

```kotlin
@Composable
fun RouteFinderScreen(
    viewModel: WizzViewModel,
    onReauthenticate: () -> Unit
) {
    var searchType by remember { mutableStateOf("depart") }
    var airport by remember { mutableStateOf("") }
    var selectedDate by remember { mutableStateOf("") }
    var isSearching by remember { mutableStateOf(false) }
    var flights by remember { mutableStateOf<List<Flight>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var rateLimited by remember { mutableStateOf(false) }

    val routes by viewModel.routes.collectAsState()
    val dynamicUrl by viewModel.dynamicUrl.collectAsState()
    val authHeaders by viewModel.authHeaders.collectAsState()

    // Create API client when data is available
    val apiClient = remember(routes, dynamicUrl, authHeaders) {
        if (routes != null && dynamicUrl != null && authHeaders != null) {
            WizzApiClient(dynamicUrl!!, authHeaders!!)
        } else {
            null
        }
    }

    // Generate date options
    val availableDates = remember {
        val calendar = Calendar.getInstance()
        val dates = mutableListOf<String>()
        repeat(30) {
            dates.add(
                SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
                    .format(calendar.time)
            )
            calendar.add(Calendar.DAY_OF_MONTH, 1)
        }
        dates
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        // Token expiry banner at the top
        TokenExpiryBanner(
            viewModel = viewModel,
            onReauthenticate = onReauthenticate,
            modifier = Modifier.padding(top = 8.dp)
        )

        Spacer(modifier = Modifier.height(8.dp))
        Text("Wizz AYCF Route Finder", style = MaterialTheme.typography.headlineSmall)
        Spacer(modifier = Modifier.height(16.dp))

        // Search type selection
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = searchType == "depart", onClick = { searchType = "depart" })
            Text("Depart from")
            Spacer(modifier = Modifier.width(16.dp))
            RadioButton(selected = searchType == "arrive", onClick = { searchType = "arrive" })
            Text("Arrive to")
        }

        Spacer(modifier = Modifier.height(8.dp))
        
        // Airport input
        OutlinedTextField(
            value = airport,
            onValueChange = { airport = it.uppercase() },
            label = { Text("Airport code (e.g., LTN)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        Spacer(modifier = Modifier.height(8.dp))
        
        // Date selector
        OutlinedTextField(
            value = selectedDate,
            onValueChange = { selectedDate = it },
            label = { Text("Departure Date") },
            modifier = Modifier.fillMaxWidth(),
            readOnly = true,
            trailingIcon = { Icon(Icons.Default.DateRange, contentDescription = "Date") }
        )

        Spacer(modifier = Modifier.height(16.dp))
        
        // Search button
        Button(
            onClick = { startSearch() },
            modifier = Modifier.fillMaxWidth(),
            enabled = !isSearching && airport.isNotBlank() && selectedDate.isNotBlank()
        ) {
            if (isSearching) CircularProgressIndicator(modifier = Modifier.size(24.dp))
            else Text("Check Routes")
        }

        // Results and error displays would go here
    }

    fun startSearch() {
        if (apiClient == null) {
            error = "Session expired. Please re-authenticate."
            return
        }
        // ... search logic ...
    }
}
```

---

### 7. Navigation

```kotlin
// MainActivity.kt
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val navController = rememberNavController()
        val viewModel: WizzViewModel = viewModel()

        SetContent {
            WizzRouteFinderTheme {
                NavHost(
                    navController = navController,
                    startDestination = "login"
                ) {
                    composable("login") {
                        LoginScreen(
                            viewModel = viewModel,
                            onLoginSuccess = { navController.navigate("routeFinder") }
                        )
                    }
                    composable("routeFinder") {
                        RouteFinderScreen(
                            viewModel = viewModel,
                            onReauthenticate = {
                                viewModel.resetSession()
                                navController.navigate("login") {
                                    popUpTo("routeFinder") { inclusive = true }
                                }
                            }
                        )
                    }
                }
            }
        }
    }
}
```

---

### 8. AndroidManifest.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.WizzRouteFinder"
        tools:targetApi="31">
        
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:theme="@style/Theme.WizzRouteFinder">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

---

### 9. Dependencies (build.gradle)

```gradle
dependencies {
    // Core
    implementation 'androidx.core:core-ktx:1.12.0'
    implementation 'androidx.lifecycle:lifecycle-runtime-ktx:2.6.2'
    implementation 'androidx.activity:activity-compose:1.8.0'
    
    // Compose
    implementation platform('androidx.compose:compose-bom:2023.10.01')
    implementation 'androidx.compose.ui:ui'
    implementation 'androidx.compose.ui:ui-graphics'
    implementation 'androidx.compose.ui:ui-tooling-preview'
    implementation 'androidx.compose.material3:material3'
    
    // Navigation
    implementation 'androidx.navigation:navigation-compose:2.7.5'
    
    // Networking
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    
    // Coroutines
    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3'
    implementation 'androidx.lifecycle:lifecycle-viewmodel-compose:2.6.2'
}
```

---

## User Flow

### First Time / Expired Session
1. User opens app → LoginScreen displays WebView
2. User authenticates on Wizz Air → WebView extracts data
3. ViewModel starts 20-minute countdown → Navigates to RouteFinder
4. TokenExpiryBanner shows: "Session expires in: 20m 0s"

### Normal Search
1. User enters airport & date → Taps "Check Routes"
2. App checks session (not expired) → Makes API calls
3. Results displayed → Countdown continues

### Token Expiration
- **Countdown reaches 0**: Banner shows "Session expired" + Re-login button
- **API returns 401/403**: Error dialog + session marked expired
- **User taps Re-login**: Navigates to LoginScreen, session reset

---

## Token Expiration States

| State | Remaining Time | Banner Color | Banner Text |
|-------|----------------|--------------|-------------|
| Normal | ≥ 15 minutes | Primary Container | "Session expires in: Xm Ys" |
| Warning | 2-5 minutes | Tertiary Container | "Session expires in: Xm Ys" |
| Critical | < 2 minutes | Error Container | "Session expires in: Xm Ys" |
| Expired | 0 or null | Error | "Session expired - Please re-authenticate" |

---

## Rate Limiting

- Random delay: 500-1000ms between requests
- Cooldown: 15-second break every 25 requests
- Error handling: Catches 429 and shows warning

---

## Implementation Effort

| Task | Time |
|------|------|
| Project setup | 1-2h |
| Dependencies | 30m |
| Data models | 1h |
| ViewModel | 2-3h |
| API Client | 2-3h |
| TokenExpiryBanner | 1-2h |
| LoginScreen | 3-4h |
| RouteFinderScreen | 4-6h |
| Navigation | 1-2h |
| **MVP Total** | **1-2 days** |

---

## Project Structure

```
app/
├── src/main/java/com/example/wizzroutefinder/
│   ├── MainActivity.kt
│   ├── screens/
│   │   ├── LoginScreen.kt
│   │   ├── RouteFinderScreen.kt
│   │   └── components/
│   │       ├── TokenExpiryBanner.kt
│   │       └── FlightCard.kt
│   ├── viewmodel/WizzViewModel.kt
│   ├── network/
│   │   ├── WizzApiClient.kt
│   │   └── exceptions.kt
│   └── models/
│       ├── Flight.kt
│       ├── Route.kt
│       └── Station.kt
└── AndroidManifest.xml
```
