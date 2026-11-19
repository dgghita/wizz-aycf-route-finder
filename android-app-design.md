# Wizz AYCF Route Finder — Android App Design

## What this is

A native Android app that reuses the Chrome extension's HTML/JS UI (`shared/`) inside a WebView, with native plumbing for the parts the browser sandbox can't do: a controlled WebView that logs into Wizz Air Multipass, extracts routes/tokens, and fires the availability API without CORS restrictions.

```
shared/                     popup.html / popup.js / css / icon / music   (single copies)
├── extension root: symlinks → shared/, plus content.js / background.js / manifest.json
└── android-app/            MainActivity.kt hosts popup in WebView,
                            hidden WizzAir WebView for login + extraction,
                            JS bridge ("Android") replaces chrome.* APIs;
                            API calls run natively via HttpURLConnection
```

---

## Changelog

### Shipped — v1 (commit `a012b0a`)

Milestone: **the web version works and the Android app exists.**

- Shared-asset layout: one copy of UI code in `shared/`; extension uses
  symlinks, app consumes it via Gradle `sourceSets`. `content.js` and
  `background.js` correctly split out as extension-only.
- `popup.js` is environment-agnostic: `typeof Android` guards route to the
  bridge (app) or the original `chrome.*` content-script flow (extension).
- `MainActivity.kt`: popup WebView + hidden Wizz Air WebView, extraction of
  `window.CVO.routes` + dynamic API URL on page load, request-header capture
  via `shouldInterceptRequest`, native `checkRoute()` POST (CORS-free),
  automatic re-login prompt on 401/403, 429 handling.
- Search history (20 entries, localStorage) with per-entry delete and Clear
  All, replacing the old result-caching.
- CLI build chain (no Android Studio): brew openjdk@17 + cmdline-tools +
  Gradle 8.4 wrapper; one-command `./gradlew assembleDebug` → ~1 MB debug APK.

**Known issue from first real-world test:** a batch returned zero flights and
an immediate rate limit. Suspected cause: Wizz's API requires custom request
headers the extension used to read from `serverTiming` (`request_header_*`);
our WebView header capture may be missing or stale, so calls fail/instantly
429. No visibility into per-call status exists yet — that is exactly what v2
fixes.

---

### Planned — v2: Observability & batch control

Nothing below is implemented yet. Order is roughly build-then-polish; items
2–4 come first so the behaviors in 1/3/5 are debuggable.

#### 0. UI structure (v2 rework)
- **Session header** at the top. The **status chip itself is the sync
  button**: colored status dot + text ("Up to date" / "Missing login" /
  "Missing routes" / "Missing search URL" / ... inside a small button;
  tapping it runs another sync — see item 5 (in the extension it flips into
  "Sync failed — tap to reload" mode when the content script is missing). On
  the right: **"Wizz AYCF Page"** — in the extension it switches to the
  multipass tab or opens one if none exists; in the app it shows the capture
  webview (with its Reload/Close toolbar, plus back-button close). The app
  has **no
  manual Re-login button** (removed build 14): pages now always re-capture
  routes/dynamic-URL on load, so opening the Wizz page and logging in is
  itself the full re-login; `forceReLogin()` remains as an internal
  mechanism the batch triggers on expiry/token-mismatch/stale-URL.
  **Closing the webview also auto-runs the session check** (build 15), so
  the chip is current the moment you're back — Close button and back
  gesture both.
  In the **extension both run automatically on popup open**: the session
  probe (any multipass tab, not just the active one) and a fresh routes
  scrape into the cache, which also re-renders the airport suggestions. The
  app does not auto-probe (the countdown + probe-on-Start cover it).
- The Wizz webview is fullscreen, so it gets a **fixed toolbar** at the top
  (Reload on the left, Close on the right; back gesture also still closes).
- **Login credentials remembered** (build 12): the webview has no browser
  behind it, so the app keeps its own store — a hook injected on page load
  saves email/password from the login form on submit (click-capture, only
  when both fields are non-empty) into app-private `SharedPreferences`, and
  pre-fills the form on later loads (React-style native setter + input
  events, blank-fields only, re-tried at 1.5 s / 3 s / 4.5 s for the
  late-rendered SPA form). Plaintext in private storage — accepted
  trade-off for a personal, single-device app.
- **Tab buttons** (two buttons stuck together, one active/pressed) for both
  the main view: "Find Routes | Search History", and the mode: "Depart from |
  Arrive to". No more radios.
  - History mode: **Start is replaced, not hidden-and-empty** — it disappears
    and a same-sized red "Clear All" takes its full-width slot; the in-list
    "Search History" heading is gone (the tab names the view). Back on Find
    Routes both are restored. Viewing a stored entry is read-only.
    **Find Return is removed entirely** (button, live search, and all
    supporting code) — dead weight for this use case.
- **Start** is a full-width button below the tabs. While a batch runs it turns
  red and becomes **Stop** — same button, no graying out, no separate stop
  button. Two batches can never run at once; clicking mid-batch aborts.
- Order on screen: session header,Depart/Arrive, airport, date, music,
  tabs, Start, [dashboard], [progress bar], results.

#### 1. Batch progress indicator
- Rendered **under the dashboard summary row** (not fixed to the screen edge):
  fat bar with the status text overlaid (debian-installer style), counter in
  `12/37` style; cooldowns and back-offs count down on it.
- No waiting music. Visual only.
- **Done when:** starting a search shows the bar; it counts up in real time;
  it disappears when the batch ends, is stopped, or fails.
- **Pacing change (reactive-only):** the preventive every-25-routes 15 s
  pause was dropped — in practice a 429 kept landing right after it, and the
  jitter alone (now widened to a random 1-4 s between requests) plus
  reactive backoff is the whole strategy. Back-offs still count down on the
  bar and are Stop-interruptible.

#### 2. Stop button
- The **Start button turns into a red Stop** while a batch runs; clicking it
  aborts immediately: no further API calls, partial results stay rendered.
- Must abort even during rate-limit back-off sleeps (the preventive cooldown
  sleeps are gone; See item 1's pacing change).
- **Done when:** mid-batch Stop leaves the UI responsive, Start comes back
  green, no further calls fire (verifiable in logcat), partial results remain.

#### 3. Status cards (not a mode — a visibility filter)
- During every batch, the UI renders a **card per route** in real time, styled
  like the flight cards: a route header with a status tag plus a detail row
  where flight details would go (flight count, or the actual error message).
- The cards are part of the official result list (a `route-cards` section
  inside it), not a separate overlay. They persist after the batch ends —
  no re-render wipes them.
- The **"Show detailed log"** toggle only flips the container's `show-details`
  class, so it is fully **retroactive**: turn it on after a finished batch and
  past Closed/Errored outcomes appear; flip it off and they hide. Works
  mid-batch too.
- The whole batch's outcomes are stored in the history entry (`outcomes`
  array), so opening a history entry renders the same retroactive status
  cards. Old entries created before this change show Available-only (no
  stored outcomes) — expected.
- One vocabulary everywhere: **Available** (flights came back) / **Closed**
  (nothing on the route/date, including `error.availability`) / **Errored**
  (the request failed). Used by the summary counters, the status-card tags,
  and the end-of-batch messages alike.
- Four states, kept truthful to the latest outcome:
  - `in flight...` — request pending
  - `Available` — flights returned (shows count)
  - `Closed` — empty response, or Wizz's `error.availability` 400
  - `Errored` — anything else, with the actual error message in the card
    body; includes the rate-limit give-up path (no route left dangling as
    "in flight" forever)
- **Done when:** flipping the toggle on at any time — mid-batch or after —
  reveals per-route outcomes for every destination pair in both the live
  view and history, without reading logs.

#### 3b. Batch summary counters (always visible, no debug mode needed)
- Between the buttons and the results, a dashboard-style row of three columns
  with a big number over a label: **Available** (green) / **Closed** (dark
  gray) / **Errored** (red).
- Live-updated during the batch; reset at the start of each one and stays
  visible afterwards, including partial/aborted batches.
- The point: **if Errored climbs, the user knows to hit Stop** — in normal
  mode there's no other way to tell "errors behind the scenes" apart from
  "flights just not found".
- **Done when:** a batch with dead headers shows Errored climbing while
  Available stays at zero, without debug mode on.

#### 4. Android-side logging for `adb logcat`
- Bridge logs every API call: target URL, payload summary, HTTP status,
  latency, and first ~200 chars of the response body (429 bodies especially —
  they should explain the rate limiting).
- WebView console (`popup.js` `console.log`) mirrored to logcat via
  `WebChromeClient.onConsoleMessage`.
- Extraction events logged too: what the hidden WebView found (routes JSON
  size, dynamic URL, captured header names).
- **Done when:** running a search on-device while watching `adb logcat` tells
  us exactly why calls fail.
- **Extension equivalent (no adb needed):** both request paths (bridge and
  extension fetch) now emit one `[api]` line per call into the popup console —
  status, latency, `Retry-After` when present, first ~200 chars of the body.
  Open the popup's DevTools and filter the console by `api` for the same
  view logcat gives on device.

#### 5. Session status = the health of the whole data pipeline
- **Rework (supersedes "token validation"):** the chip no longer answers
  "are the auth headers alive" but "does the app have everything it needs to
  operate": token + routes + search URL. One green state (`Up to date`,
  with the live countdown in parens, app only) and specific failure states:
  gray `Not synced yet` (no sync ever attempted), yellow `Syncing data...`
  (in flight), red `Missing login` / `Missing routes` / `Missing search
  URL` (the first missing piece wins: login > routes > search URL), yellow
  `Sync failed` (probe unreachable). `Up to date` requires the probe to
  prove the captured auth is accepted; 401/403 and `error.token.mismatch`
  read as `Missing login`.
- Tapping the chip runs another sync of whatever is stale (app: native probe
  + presence checks; extension: probe + a fresh routes scrape from the
  multipass tab). The sync NEVER opens or reloads a page by itself — the
  Wizz AYCF Page button is the explicit path. Exception kept: in the
  extension, a missing/stale content script flips the chip into
  "Sync failed — tap to reload" (reload happens only on that tap).
- **Check Routes runs the same sync first** and only `up-to-date` starts a
  batch; the refusal messages name the missing piece and point at the Wizz
  page button (no auto-login).
- **Done when:** the user can tell at a glance which piece of session data
  is missing, a dead session never wastes a batch, and the chip reaches
  green on its own after closing the capture webview (sync fires on close).

#### 6. Honor Wizz's back-off instructions
- 429 responses are treated as instructions, not as fatal: the bridge now
  returns response headers alongside status/body, so `Retry-After` (seconds or
  HTTP-date) is read and honored.
- On 429 the top bar shows `Backing off Ns at Wizz's request`, waits the
  requested time (Stop-interruptible), then retries the same route. After 3
  backoffs the batch gives up, shows the rate-limit banner, and keeps partial
  results.
- HTTP errors carry the response body snippet in the user-visible message
  instead of a bare `HTTP error! status: X`. Without `Retry-After`, a random
  10-20 s back-off applies (varies per 429 so retries don't lock into a
  rhythm).
- **Done when:** a mid-batch 429 recovers by itself if Wizz allows it, and the
  user always sees why a call failed.

#### 7. Token expiry countdown (app only)
- The app parses the `exp` claim of any captured JWT (inside the WebView
  request interceptor — no page scripts involved) and exposes
  `{hasToken, expiresAtEpochSeconds, capturedAtEpochSeconds}` to the JS via a
  `getTokenInfo()` bridge.
- The session header composes a real countdown into the status text:
  "Up to date (MM:SS)" counting down, refreshed every 15 s. The countdown
  renders while the chip is green (item 5 rework: the states are discrete
  messages, so the parens countdown belongs to `Up to date`); the chip
  reaches `up-to-date` right after a successful sync (on popup open and on
  capture-webview close), so it is current from the start.
  Amber when under 2 minutes remain, red past expiry. When the countdown hits
  zero, the text suggests a re-login.
- Extension unaffected (no `getTokenInfo` bridge there).
- **Optimistic auto-refresh on Start**: if the token is expired or under a
  minute from expiry, Start reloads the capture webview before probing —
  the multipass cookie is assumed to outlive the JWT, so re-auth is silent
  and the batch proceeds (polls up to 60s for a fresh capture). If the
  refresh produces nothing, the batch is refused with an "open the Wizz page
  and log in again" message (there is no manual Re-login button since
  build 14).
- **Done when:** after a re-login the header shows the countdown ticking down
  and flips amber near expiry, and a batch started against an expired token
  recovers on its own (webview blip, fresh capture, batch runs).

#### 8. UI polish round (extension + app)
- **Inverted progress bar:** dark gray track, white overlaid text (no glow
  needed anymore), same blue fill.
- **"Show detailed log"** replaces the Debug mode checkbox: a settings-style
  row with the label left and a phone toggle switch right, sitting directly
  above the card list. Same behavior under the hood (`#debug-mode-checkbox`).
- **Waiting music removed from existence** — checkbox, player code, and the
  `background-music.mp3` asset are all gone.
- **Tab-button pairs stretch to full width** (both Find Routes | Search History
  and Depart from | Arrive to).
- **Bug fix: "Arrive to" never actually inverted the search.** All
  `fetchDestinations` paths only looked for `departureStation.id === origin`;
  a shared `extractDestinationIds` helper now resolves inbound routes in
  arrive mode (airports that fly *into* the chosen airport).
- **Same button pair also never switched on click**: the radio-to-tab-button
  conversion left no click listener, so the pressed state stayed on
  "Depart from" forever (`getSearchType()` reads it). One listener per button
  now flips the pressed state at click time.
- **The session header is a real header bar:** full-width, sticky at the very
  top of the page, border-bottom, in front of all scrolling content — not a
  row buried under the title.
- **Done when:** a batch shows white text on the dark bar; the toggle hides/
  reveals detailed cards mid-batch; a full-width tab pair stays attached with
  no gaps; "Arrive to" returns inbound routes; the header stays fixed while
  scrolling.

#### 9. Controls round: bar refinement, date chips, autocomplete
- **Progress bar, third styling:** back to a light track (`#f0f0f0`) with a
  lighter blue (`#7e93e6`) and almost-black bold text front and center.
  Bigger text (1em), taller track (30px), no side paddings/maxWidth — the bar
  lines up with the rest of the controls.
- **"Show detailed log" sits directly above the Find Routes | Search History
  tabs** (with its own top margin), not between the dashboard and the bar:
  it reads as a control for the card tables below the tabs. It stays a
  live-batch-only control (decided 2025-11-19: no history behavior for now).
- **End-of-batch notices styled like a dimmed bar** ("All routes Closed for
  X"): full-width light-gray track, small near-black bold text. The
  extension's oversized rescue-line messages go away.
- **The 4-date dropdown becomes 4 calendar-style tab-buttons**: the weekday
  pops out at you (big, bold, uppercase) with the month/day as a small caption
  under it, stretched full-width, same pressed styling as the other tab pairs.
  Kills the Chrome side-panel dropdown geometry bug and saves a click.
  Selected chip carries the actual API date
  (`getSelectedDate()` replaces the `<select>`).
- **Airport autocomplete** via a **custom dropdown we render ourselves**
  (the native `<datalist>` popup is browser-styled and sits offset in narrow
  sidebars). Data comes from the routes we already capture (Wizz page object
  on both platforms — nothing new is downloaded): **airport name bold left,
  IATA code dimmed right**; matches work on both name and code and convert
  internally to the code — picking always fills the code, and anything left
  in the field on blur is resolved to a code when the match is unique.
  **App only — the input is gated on a fresh capture**: the routes JSON is
  memory-only (never persisted), so until `hasWizzData()` is true the input
  is disabled with placeholder "Loading airport data..."; once the Wizz page
  capture lands (`__onWizzDataReady`, chained with the login-wait hook) the
  input enables and the suggestions render from that fresh data. The
  extension runs the same gate: it polls the cache, actively scrapes the
  multipass tab while waiting, gives up after 10 s (input re-enables for
  free typing). The loading placeholder is "Loading airport data...", the
  ready/fallback one "Type an airport name...".
- **Dropdown opens in-flow, select-style**: a chevron on the input's right
  edge toggles the list on demand (empty query = full airport network); while
  typing it filters. The box does not float — it opens **inside the layout
  directly under the input**, pushing the content below down (the "mouth
  opening"). Retro split-open panel: **fixed height** (~5 rows, empty rows
  stay empty), gray frame behind the rows, hairline borders between them;
  hover/active rows turn white. Nothing overlaps; mobile-friendly by
  construction. Input's bottom corners square off while open, arrow keys
  open it when closed, clicking outside closes it. The chevron is vertically
  centered on the input only, so it doesn't drift when the panel opens.
- **Disclaimer moved into a pinned footer**: very small, dimmed text with a
  hairline top border (disclaimer, usage note, version). It's a flex footer —
  the section above scrolls under it and the footer never moves. The sticky
  session header now holds position structurally (flex sibling of the
  scrolling section) instead of relying on `position: sticky`.
- **Done when:** the toggle shows between dashboard and bar during a run;
  "All routes Closed" reads as a dim bar; dates are tappable chips; typing
  "LT" suggests Wizz airports after a search has been run once; the
  disclaimer stays pinned at the bottom while results scroll.

#### 10. Stale search-endpoint auto-recovery
- When Wizz answers an availability request with the SPA's HTML shell (HTTP
  200 + `<!DOCTYPE`), the captured "dynamic URL" is dead. The batch treats
  this as a **retryable** condition, not a per-route error:
  extension → reload the multipass Wizz tab programmatically (the content
  script reads the URL out of the page's DOM, so a stale page can never yield
  a fresh URL), wait for the load to complete, wait a settle beat for
  `window.CVO`, retry the same route. App → `forceReLogin()` (already called)
  and poll the bridge for the recaptured URL, up to 45s.
- Capped at 3 refreshes per batch; past that the route's card reads "Gave up
  after 3 refreshes". If the Wizz page isn't the active tab in the extension,
  the refresh fails cleanly with a card saying so.
- **Done when:** a batch started against a long-idle Wizz page recovers on
  its own mid-run (bar announces the reload, the route card stays "in
  flight", then resolves normally) — no extension reload, no tab juggling.

#### 11. Async native HTTP bridge (perceived-freeze fix)

- **Symptom on device:** the UI never painted mid-batch — no "Checking
  session..." text, cards only appeared in the gaps between requests; it
  felt like freezes. Cause: the bridge methods returned `String`
  synchronously, so the WebView's JS thread blocked on the native HTTP call
  and no rendering happened until it returned.
- **Fix:** `checkRoute(url, payload, callbackId)` and
  `checkSession(callbackId)` are now fire-and-forget: the HTTP runs on a
  small background executor (`Executors.newFixedThreadPool(2)`) and the
  result is delivered with `evaluateJavascript` into
  `window.__nativeHttpCallback(callbackId, response)`. The shared script
  wraps that in `nativeHttpPost()` / `nativeHttpSessionProbe()` promises,
  with a 45s timeout resolving `{status: 0, body: "native call timed out"}`
  so a wedged native call can never hang a card. The Kotlin `executePost`
  logic itself is unchanged.
- **Done when:** batches on device paint continuously — the bar and
  "Checking session..." render immediately, cards populate as responses
  land.

#### 12. Screen-off batches (wakelock)
- **Problem:** with the screen off, Doze throttles network and freezes JS
  timers, so batches stall (maybe the same root cause as the perceived
  freezing; the async bridge fixed rendering, not this).
- **Fix (build 13):** the page calls `Android.batchKeepAlive(true)` when a
  batch starts and `batchKeepAlive(false)` in its `finally` — the app holds
  a `PARTIAL_WAKE_LOCK` (tagged `wizzfinder:batch`, WAKE_LOCK permission)
  for the duration, capped at 30 min so a wedged batch can't drain the
  battery. Extension-side code is untouched (`typeof Android` guards).
- **Done when:** a batch started with the screen off still progresses
  (cards populate; check afterwards). On aggressive OEMs (Honor) battery
  settings may still need the app whitelisted from optimization.

#### 13. Dark mode (light / dark / auto)
- **Intent:** the user wants a real application look on device. A single
  icon button in the session header (styled like the session chip)
  cycles the theme light -> dark -> auto; the icon (sun / moon / monitor)
  shows the active mode. The choice persists in
  `localStorage["wizz-theme"]`; `auto` tracks `prefers-color-scheme` live
  (listener re-applies on OS switch without reload).
- **Scope:** chrome-wide dark mode in the shared UI (popup + app webviews)
  and, as far as Android allows, the Wizz pages too. The extension popup and
  the app main webview share the exact same CSS, so no platform split is
  needed for the UI itself.
- **Fix:** Bulma 1.0.2 natively supports `html[data-theme="dark"]`, so
  setting that attribute flips every Bulma component. The custom CSS in
  `shared/popup.html` is converted to CSS custom properties (one var set on
  `:root`, one dark override on `html[data-theme="dark"]`) and every
  hardcoded hex goes away. The few inline styles set from `shared/popup.js`
  are switched to `var(...)` strings (browser accepts them). A tiny inline
  script runs before first paint to resolve and set `data-theme`, avoiding a
  light flash on dark phones. Only the *chrome* is currently under CSS the
  shared style controls; the whiteish flash on webview load needs the
  app-side native mainWebView background color fixed too.
- **Fix (app, build 17):** the Wizz pages themselves get the same theme via
  `settings.isAlgorithmicDarkeningAllowed = true` (API 33+, algorithmic
  darkening) plus a `attachBaseContext` override forcing `uiMode`
  (dark -> `UI_MODE_NIGHT_YES`) so the WebView sees night mode, saved as
  `"app-theme"` in prefs. The JS bridge gains `setAppTheme(mode)` which
  persists the pref and calls `recreate()`. The main window background is
  set natively (dark when the override is on) to kill the white flash while
  the webview loads, and the webview background is set to match.
- **Done when:** the toggle flips every surface of the chrome to a readable
  dark palette with no light-flash on open, persists across restarts, and
  `auto` follows the system theme live; in the app the Wizz webview darkens
  to match (native darkening, API 33+).
- **Fix (first on-device round):** Bulma's `is-light` helpers (inactive tab
  buttons, chips, history rows, delete buttons) resolve their background
  from `--bulma-light-l`, which is 96% and static in the shipped build —
  the dark block now overrides it (plus the three `*-light-invert-l` text
  values), so inactive controls are inverted like active ones. The
  "Show detailed log" label kept a literal `#363636`; converted.

#### 14. Search history: accordion entries (no drill-down)
- **Intent:** clicking a history entry used to replace the whole list with
  its results, and the only way back was re-clicking the tab. Instead,
  entries behave like accordion headings: the first click renders the
  entry's results (date header, flight cards, and the closed/errored
  outcome cards — unchanged markup, so the "Show detailed log" toggle
  applies to them too) in a bordered panel right below the heading; a
  second click hides it. A small rotating chevron signals the open state.
- **Fix:** `displayResults` gained an optional target element (default
  stays the live `.route-list`); history entries render into their own
  panel lazily (once) and toggle `display`. "Clear All" keeps its
  full-width slot but drops the hard red for the soft `is-light` danger
  variant, matching the per-row Delete buttons — hard red stays reserved
  for Stop and the error labels.
- **Done when:** in the extension, an entry expands/collapses in place
  (both in light and dark), the detailed-log toggle shows/hides the
  outcome cards inside an open panel, and Clear All reads as a soft red.

#### Explicitly out of scope for v2- Full UI overhaul (user intent: it's coming, after observability proves out).
- (Token expiry countdown was moved into scope as item 7; a manual re-login
  already exists via error paths.)

---

## Versioning

- The extension manifest and the Android `versionName` move together; the
  footer in `popup.html` follows.
- The Android APK additionally carries a `versionCode` in
  `android-app/app/build.gradle.kts` — it must be strictly incremented on
  every Android build so it can install over the previous one.
- Scheme for this phase: `1.9.9` with the `versionCode` as the build number
  (1.9.9 = build 2, next Android build = build 3, ...). `2.0.0` is reserved
  for when v2 is operational on-device. **Update 2025-11-19: v2 was declared
  operational on-device, so `versionName` is now `2.0.0`** (build 7 was the
  first 2.0.0 build); the Android `versionCode` keeps incrementing.
- **App icon (build 7)**: master asset `shared/app-icon.jpeg` (white plane
  shape with heart on Wizz pink). `android-app/scripts/make-icons.py`
  regenerates the launcher set from it: legacy `mipmap-*/ic_launcher.png`
  (full square) plus an adaptive icon — solid-pink background
  (`#FB3D95`, sampled from the master) and a white-shape-on-transparent
  foreground (`drawable/ic_launcher_foreground.png`), so launcher masking
  never crops the shape. Running it again only needs `python3` + Pillow.
- Android builds are requested explicitly; extension testing needs no build.

## Build & install (current, CLI-only)

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
cd android-app && ./gradlew assembleRelease
# → app/build/outputs/apk/release/WizzRouteFinder-v<version>-build<N>-release.apk
```

- Release is signed with the debug key (`signingConfig = signingConfigs.getByName("debug")`),
  so it installs over the debug builds. Outputs are named with the version
  (`WizzRouteFinder-v2.0.0-build7-release.apk`). Verify signatures with
  `apksigner verify --print-certs <apk>` (jarsigner does not see v2-only schemes).

- `-  adb` at `/opt/homebrew/share/android-commandlinetools/platform-tools/adb`
- **Watch logs:** `adb logcat | grep -i wizz` (once v2 logging lands, filter tag TBD)
- Reinstall on device: `adb install -r app/build/outputs/apk/debug/app-debug.apk`
