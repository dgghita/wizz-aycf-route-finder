console.log("popup.js loaded");

/**
 * Theme: light | dark | auto, persisted in localStorage["wizz-theme"].
 * The head inline script in popup.html already set data-theme before first
 * paint; this block owns the three-way toggle in the session header, the
 * live system-change tracking for auto mode, and the app-side native sync.
 */
const THEME_KEY = "wizz-theme";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function getThemeMode() {
  try {
    return localStorage.getItem(THEME_KEY) || "auto";
  } catch (e) {
    return "auto";
  }
}

function resolveTheme(mode) {
  return mode === "auto" ? (themeMedia.matches ? "dark" : "light") : mode;
}

function applyStoredTheme() {
  document.documentElement.setAttribute(
    "data-theme",
    resolveTheme(getThemeMode())
  );
}

function setThemeMode(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
  // App: persist on the native side (drives the Wizz webviews' darkening
  // and the window background) and restart so attachBaseContext picks it up
  if (typeof Android !== "undefined" && Android.setAppTheme) {
    Android.setAppTheme(mode);
  }
}

// Auto mode follows the OS theme switch live, without a reload
themeMedia.addEventListener("change", () => {
  if (getThemeMode() === "auto") applyStoredTheme();
});

function waitForWizzData(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const getData = () => {
      if (Android.hasWizzData()) {
        try {
          return JSON.parse(Android.getRoutesJson());
        } catch (e) {
          console.error("Failed to parse routes from Android bridge:", e);
          return null;
        }
      }
      return null;
    };

    let data = getData();
    if (data) {
      resolve(data);
      return;
    }

    const started = Date.now();
    const poll = setInterval(() => {
      data = getData();
      if (data) {
        clearInterval(poll);
        resolve(data);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error("Timed out waiting for Wizz Air login"));
      }
    }, 500);

    window.__onWizzDataReady = () => {
      data = getData();
      if (data) {
        clearInterval(poll);
        resolve(data);
      }
    };
  });
}

/**
 * Airport suggestions: harvest every station that appears in the Wizz routes
 * data we already capture on each platform (no new request), then render a
 * custom dropdown under the input (the native datalist popup is browser-styled
 * and sits offset in narrow sidebars).
 * Station objects carry the IATA code in `id` (that is what the whole
 * pipeline matches on); a human label is used when present.
 */
let airportStations = [];

function refreshAirportSuggestions() {
  let routes = null;
  try {
    if (typeof Android !== "undefined") {
      if (Android.hasWizzData()) {
        routes = JSON.parse(Android.getRoutesJson());
      }
    } else {
      const pageData = JSON.parse(
        localStorage.getItem("wizz_page_data") || "{}"
      );
      routes = pageData.routes || null;
    }
  } catch (e) {
    console.error("Failed to load data for airport suggestions:", e);
  }
  if (!Array.isArray(routes)) return false;

  const stations = new Map();
  const record = (station) => {
    if (!station || !station.id || stations.has(station.id)) return;
    const label =
      station.name || station.cityName || station.fullName || station.code || "";
    stations.set(station.id, label);
  };
  routes.forEach((route) => {
    record(route.departureStation);
    (route.arrivalStations || []).forEach(record);
  });

  airportStations = [...stations.entries()]
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => a.code.localeCompare(b.code));
  console.log(`Airport suggestions: ${airportStations.length} stations`);
  return true;
}

/**
 * Extension only, fire-and-forget: ask any multipass tab to scrape the routes
 * data off the page into the popup cache. The routes gate polls this cache;
 * this just feeds it while the user has a multipass page open.
 */
function scrapeRoutesFromMultipassTab() {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query) {
    return;
  }
  chrome.tabs.query({}, function (tabs) {
    const tab = (tabs || []).find(
      (t) => t.url && t.url.includes("multipass.wizzair.com")
    );
    if (!tab) return;
    chrome.tabs.sendMessage(
      tab.id,
      { action: "getDestinations", origin: "" },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.routes) return;
        try {
          const pageData = JSON.parse(
            localStorage.getItem("wizz_page_data") || "{}"
          );
          pageData.routes = response.routes;
          pageData.timestamp = Date.now();
          localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
          console.log("Scraped fresh routes data from the multipass tab");
          refreshAirportSuggestions();
        } catch (e) {
          console.error("Failed to cache scraped routes:", e);
        }
      }
    );
  });
}

function hideAirportDropdown() {
  const dropdown = document.getElementById("airport-dropdown");
  if (dropdown) dropdown.style.display = "none";
  const input = document.getElementById("airport-input");
  if (input) {
    input.classList.remove("dropdown-open");
    const chevron = document.getElementById("airport-chevron");
    if (chevron) chevron.classList.remove("open");
  }
}

function openAirportDropdown(query) {
  const input = document.getElementById("airport-input");
  if (!input || airportStations.length === 0) return;
  let dropdown = document.getElementById("airport-dropdown");
  if (!dropdown) {
    const control = input.parentNode;
    dropdown = document.createElement("div");
    dropdown.id = "airport-dropdown";
    dropdown.className = "airport-dropdown";
    control.appendChild(dropdown);
  }

  // Empty query = opened on demand via the chevron: show the whole network.
  // Zero matches renders an empty panel — the open/closed geometry never
  // jumps around.
  const matches = (
    query
      ? airportStations.filter(
          (station) =>
            station.code.includes(query) ||
            station.label.toUpperCase().includes(query)
        )
      : airportStations
  ).slice(0, 200);

  dropdown.innerHTML = "";
  let activeIndex = -1;
  const setActive = (index) => {
    activeIndex = index;
    [...dropdown.querySelectorAll(".airport-option")].forEach((option, i) => {
      option.classList.toggle("active", i === activeIndex);
      if (i === activeIndex) option.scrollIntoView({ block: "nearest" });
    });
  };

  matches.forEach((station) => {
    const option = document.createElement("div");
    option.className = "airport-option";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = station.label || station.code;
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = station.code;
    option.appendChild(name);
    option.appendChild(code);
    option.addEventListener("mousedown", (event) => {
      event.preventDefault(); // keep focus in the input
      input.value = station.code;
      hideAirportDropdown();
    });
    dropdown.appendChild(option);
  });

  // In-flow: pushes the content below down instead of floating over it
  dropdown.style.display = "block";
  input.classList.add("dropdown-open");
  const chevron = document.getElementById("airport-chevron");
  if (chevron) chevron.classList.add("open");

  // Keyboard navigation lives on the input: focus never leaves it
  input.onkeydown = (event) => {
    if (dropdown.style.display !== "block") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(matches.length - 1, activeIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, activeIndex - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      input.value = matches[activeIndex].code;
      hideAirportDropdown();
    } else if (event.key === "Escape") {
      hideAirportDropdown();
    }
  };
}

/**
 * The whole pipeline speaks IATA codes, but the user may have typed an airport
 * NAME and chosen it visually. Resolve what's in the input to a code: exact
 * code passes through; a unique code-prefix or station-name match converts.
 * Returns null when it cannot be resolved confidently (then the raw value
 * flows on and Wizz decides).
 */
function resolveAirportInput(raw) {
  const value = String(raw).trim().toUpperCase();
  if (!value) return null;
  const byCode = airportStations.filter(
    (station) => station.code.toUpperCase() === value
  );
  if (byCode.length > 0) return value;
  const byLabel = airportStations.filter(
    (station) => station.label.toUpperCase().includes(value)
  );
  if (byLabel.length === 1) return byLabel[0].code;
  return null;
}

function setupAirportDropdown() {
  const input = document.getElementById("airport-input");
  if (!input || input.dataset.dropdownReady) return;
  input.dataset.dropdownReady = "true";

  const control = input.parentNode;
  control.style.position = "relative";

  // Chevron on the input's right edge: opens/closes the list on demand
  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.id = "airport-chevron";
  chevron.className = "airport-chevron";
  chevron.setAttribute("aria-label", "Show airport list");
  chevron.addEventListener("mousedown", (event) => event.preventDefault());
  chevron.addEventListener("click", () => {
    const dropdown = document.getElementById("airport-dropdown");
    const isOpen = dropdown && dropdown.style.display === "block";
    if (isOpen) {
      hideAirportDropdown();
    } else {
      openAirportDropdown(input.value.trim().toUpperCase());
    }
  });
  input.insertAdjacentElement("afterend", chevron);

  input.addEventListener("input", () => {
    openAirportDropdown(input.value.trim().toUpperCase());
  });
  // Tapping/focusing the field opens the list (full network when empty) —
  // standard autocomplete behavior, and touch-friendly on the phone
  input.addEventListener("focus", () => {
    openAirportDropdown(input.value.trim().toUpperCase());
  });
  // Leaving the field with an airport name in it: convert to the code
  input.addEventListener("blur", () => {
    const value = input.value.trim();
    if (!value) return;
    const code = resolveAirportInput(value);
    if (code) {
      input.value = code;
    }
  });
  // ArrowDown opens the list when closed (old-school select behavior)
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const dropdown = document.getElementById("airport-dropdown");
    if (!dropdown || dropdown.style.display !== "block") {
      openAirportDropdown(input.value.trim().toUpperCase());
    }
  });
  // Click anywhere outside closes it (blur-based hiding would fight the
  // chevron button)
  document.addEventListener("mousedown", (event) => {
    if (!control.contains(event.target)) hideAirportDropdown();
  });
}

/**
 * Airports to check for the chosen mode: "depart" = airports served FROM
 * origin; "arrive" = airports that fly INTO origin. Returns null when the
 * routes data has no match, so callers can fall through to the next source.
 */
function extractDestinationIds(routes, origin, searchType) {
  if (searchType === "arrive") {
    const inbound = routes
      .filter(
        (route) =>
          route.departureStation &&
          route.departureStation.id !== origin &&
          route.arrivalStations &&
          route.arrivalStations.some((station) => station.id === origin)
      )
      .map((route) => route.departureStation.id);
    if (inbound.length === 0) return null;
    console.log(`Routes to ${origin}:`, inbound);
    return inbound;
  }
  const routesFromOrigin = routes.find(
    (route) => route.departureStation.id === origin
  );
  if (routesFromOrigin && routesFromOrigin.arrivalStations) {
    const destinationIds = routesFromOrigin.arrivalStations.map(
      (station) => station.id
    );
    console.log(`Routes from ${origin}:`, destinationIds);
    return destinationIds;
  }
  return null;
}

async function fetchDestinations(origin, searchType) {
  if (typeof Android !== "undefined") {
    Android.openWizzLogin();

    const routes = await waitForWizzData();
    const destinationIds = extractDestinationIds(routes, origin, searchType);
    if (destinationIds) {
      return destinationIds;
    }
    throw new Error(`No ${searchType === "arrive" ? "routes to" : "routes from"} ${origin}`);
  }

  // Chrome extension: use cached page data or the content script
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.routes) {
      console.log("Using cached routes data");
      const destinationIds = extractDestinationIds(
        data.routes,
        origin,
        searchType
      );
      if (destinationIds) {
        return destinationIds;
      }
    }
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      if (currentTab.url.includes("multipass.wizzair.com")) {
        chrome.tabs.sendMessage(
          currentTab.id,
          { action: "getDestinations", origin: origin },
          function (response) {
            if (response && response.routes) {
              const pageData = {
                routes: response.routes,
                timestamp: Date.now(),
              };
              localStorage.setItem("wizz_page_data", JSON.stringify(pageData));

              const destinationIds = extractDestinationIds(
                response.routes,
                origin,
                searchType
              );
              if (destinationIds) {
                resolve(destinationIds);
              } else {
                reject(
                  new Error(
                    `No ${searchType === "arrive" ? "routes to" : "routes from"} ${origin}`
                  )
                );
              }
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else {
              reject(new Error("Failed to fetch destinations"));
            }
          }
        );
      } else {
        chrome.tabs.create({
          url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets",
        });
        reject(
          new Error(
            "Not on the Wizzair Multipass page. Opening the correct page for you. Please enter any random route and press Search."
          )
        );
      }
    });
  });
}

async function getDynamicUrl() {
  if (typeof Android !== "undefined") {
    const dynamicUrl = Android.getDynamicUrl();
    if (dynamicUrl) {
      return dynamicUrl;
    }
    Android.openWizzLogin();
    throw new Error("Wizz Air session lost. Please log in to Wizz Air again.");
  }

  // Chrome extension: use cached page data or the content script
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.dynamicUrl) {
      console.log("Using cached dynamic URL");
      return data.dynamicUrl;
    }
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      chrome.tabs.sendMessage(
        currentTab.id,
        { action: "getDynamicUrl" },
        function (response) {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else if (response && response.dynamicUrl) {
            const pageData = JSON.parse(
              localStorage.getItem("wizz_page_data") || "{}"
            );
            pageData.dynamicUrl = response.dynamicUrl;
            pageData.timestamp = Date.now();
            localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
            resolve(response.dynamicUrl);
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            reject(new Error("Failed to get dynamic URL"));
          }
        }
      );
    });
  });
}

// Wizz answered with HTML instead of JSON: the search-endpoint URL's source
// is stale. In the extension the content script reads that URL out of the
// loaded page's DOM, so the only real refresh is reloading the Wizz tab; in
// the app the hidden webview recaptures on its own after forceReLogin().
function refreshDynamicSource() {
  if (typeof Android !== "undefined") {
    return new Promise((resolve) => {
      // up to 45s for the webview to reload and recapture
      let waited = 0;
      const tick = () => {
        if (Android.getDynamicUrl()) {
          resolve(true);
          return;
        }
        if (batchAborted || waited >= 45000) {
          resolve(false);
          return;
        }
        waited += 1000;
        setTimeout(tick, 1000);
      };
      setTimeout(tick, 1000);
    });
  }

  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes("multipass.wizzair.com")) {
        resolve(false);
        return;
      }
      chrome.tabs.reload(tab.id, {}, () => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            // The SPA needs a beat before its URL config is populated again
            setTimeout(() => resolve(true), 2000);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  });
}

const HISTORY_KEY = "wizz_search_history";
const HISTORY_LIMIT = 20;

/** "depart" | "arrive", from the Depart/Arrive tab-buttons. */
function getSearchType() {
  const active = document.querySelector("#search-type-tabs .button.is-link");
  return active ? active.getAttribute("data-search-type") : "depart";
}

// Batch control: stop flag plus the fixed progress bar shown while a batch runs
let batchAborted = false;
let batchRunning = false;

/** The main button doubles as Stop: green "Start", red "Stop" while running. */
function setMainButtonRunning(running) {
  const button = document.getElementById("search-flights");
  if (!button) return;
  button.textContent = running ? "Stop" : "Start";
  button.classList.toggle("is-primary", !running);
  button.classList.toggle("is-danger", running);
}

// Backing off at Wizz's request (429)
const DEFAULT_BACKOFF_SECONDS = 15;
const MAX_BACKOFFS_PER_BATCH = 3;

function getRetryAfterSeconds(headers) {
  if (!headers) return null;
  const value = headers["Retry-After"] || headers["retry-after"];
  if (!value) return null;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) return Math.ceil(asNumber);
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }
  return null;
}

function makeRateLimitError(backoffSeconds) {
  // No Retry-After from Wizz: fall back to a random 10-20 s, so repeated
  // 429s don't synchronize into a fixed rhythm
  const wait =
    backoffSeconds || Math.floor(Math.random() * 11) + 10;
  const error = new Error(
    backoffSeconds
      ? `Wizz asked us to back off for ${wait}s; retrying automatically`
      : `Rate limited (429); backing off ${wait}s before retrying`
  );
  error.isRateLimit = true;
  error.backoffSeconds = wait;
  return error;
}

function makeHttpError(status, bodySnippet) {
  const detail = bodySnippet ? String(bodySnippet).slice(0, 200) : "";
  return new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

// Wizz answered an availability request with the SPA's HTML shell instead of
// JSON: the captured search-endpoint URL is no longer an API endpoint. The
// batch treats this as retryable after refreshing the URL's source page.
function makeStaleUrlError(message) {
  const error = new Error(message);
  error.isStaleUrl = true;
  return error;
}

// Same observability as the native bridge's logcat output, into the popup
// console: one "[api]" line per request. Filter the DevTools console by
// "api" to see only these.
function logApiCall(label, status, latencyMs, bodySnippet, headers) {
  const retryAfter = headers ? getRetryAfterSeconds(headers) : null;
  const extras = retryAfter !== null ? ` Retry-After=${retryAfter}s` : "";
  const body = bodySnippet ? ` body=${String(bodySnippet).slice(0, 200)}` : "";
  console.log(`[api] ${label}: status=${status} in ${latencyMs}ms${extras}${body}`);
}

// End-of-batch notices, styled like a de-emphasized progress bar track:
// light gray fill, small almost-black bold text centered in the bar
function showBatchNotice(text, container) {
  const notice = document.createElement("div");
  notice.className = "batch-notice";
  notice.style.width = "100%";
  notice.style.margin = "0 0 8px";
  notice.style.height = "26px";
  notice.style.display = "flex";
  notice.style.alignItems = "center";
  notice.style.justifyContent = "center";
  notice.style.backgroundColor = "var(--wizz-surface-alt)";
  notice.style.borderRadius = "4px";
  notice.style.fontSize = "0.85em";
  notice.style.fontWeight = "bold";
  notice.style.color = "var(--wizz-text-soft)";
  notice.textContent = text;
  (container || document.querySelector(".route-list")).prepend(notice);
}

function abortableSleep(ms, onTick) {
  return new Promise((resolve) => {
    let remaining = ms;
    const tick = () => {
      if (batchAborted || remaining <= 0) {
        resolve();
        return;
      }
      remaining -= 250;
      if (onTick) onTick(Math.max(0, remaining));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function ensureBatchBar() {
  let bar = document.getElementById("batch-bar");
  if (bar) return bar;

  // Sits directly under the dashboard summary row, in the page flow
  ensureBatchSummary();
  const summary = document.getElementById("batch-summary");

  bar = document.createElement("div");
  bar.id = "batch-bar";
  bar.style.width = "100%";
  bar.style.margin = "0 0 8px";
  bar.style.display = "flex";
  bar.style.alignItems = "center";

  // Fat track with the status text overlaid, so the bar never changes size.
  // Light track, light-ish blue fill, nearly-black text front and center.
  const track = document.createElement("div");
  track.style.position = "relative";
  track.style.flex = "1";
  track.style.height = "30px";
  track.style.backgroundColor = "var(--wizz-surface-alt)";
  track.style.borderRadius = "4px";
  track.style.overflow = "hidden";

  const fill = document.createElement("div");
  fill.id = "batch-bar-fill";
  fill.style.height = "100%";
  fill.style.width = "0%";
  fill.style.backgroundColor = "var(--wizz-aqua)";
  fill.style.transition = "width 0.2s ease";
  track.appendChild(fill);

  const text = document.createElement("span");
  text.id = "batch-bar-text";
  text.style.position = "absolute";
  text.style.top = "50%";
  text.style.left = "50%";
  text.style.transform = "translate(-50%, -50%)";
  text.style.fontSize = "0.85em";
  text.style.whiteSpace = "nowrap";
  text.style.color = "var(--wizz-text-strong)";
  text.style.fontWeight = "bold";
  track.appendChild(text);
  bar.appendChild(track);

  if (summary && summary.parentNode) {
    summary.insertAdjacentElement("afterend", bar);
  } else {
    document.body.appendChild(bar);
  }
  return bar;
}

function updateBatchBar(text, fraction) {
  const bar = document.getElementById("batch-bar");
  if (!bar) return;
  const fill = document.getElementById("batch-bar-fill");
  const label = document.getElementById("batch-bar-text");
  if (fill && fraction !== undefined) {
    fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  }
  if (label && text !== undefined) {
    label.textContent = text;
  }
}

function removeBatchBar() {
  const bar = document.getElementById("batch-bar");
  if (bar) bar.remove();
}

// Batch summary: dashboard-style Available / Closed / Errored counters, always
// visible during and after a batch (independent of debug mode)
let batchCounts = { found: 0, closed: 0, errored: 0 };

function makeBatchSummaryColumn(id, label, color) {
  const column = document.createElement("div");
  column.style.textAlign = "center";
  column.style.flex = "1";

  const number = document.createElement("div");
  number.id = `batch-summary-${id}`;
  number.textContent = "0";
  number.style.fontSize = "1.8em";
  number.style.fontWeight = "bold";
  number.style.color = color;
  number.style.lineHeight = "1.1";
  if (id === "errored") {
    // Flips to a red chip with white text once the count is non-zero,
    // so a climbing error tally is impossible to miss
    number.style.padding = "0 10px";
    number.style.borderRadius = "5px";
  }
  column.appendChild(number);

  const labelText = document.createElement("div");
  labelText.textContent = label;
  labelText.style.fontSize = "0.8em";
  labelText.style.color = "var(--wizz-text-soft)";
  column.appendChild(labelText);

  return column;
}

function ensureBatchSummary() {
  const existing = document.getElementById("batch-summary");
  if (existing) return existing;

  const row = document.createElement("div");
  row.id = "batch-summary";
  row.style.display = "none";
  row.style.justifyContent = "space-around";
  row.style.alignItems = "center";
  row.style.width = "100%";
  row.style.maxWidth = "600px";
  row.style.margin = "10px auto";
  row.style.padding = "10px";
  row.style.border = "1px solid var(--wizz-border)";
  row.style.borderRadius = "5px";
  row.style.backgroundColor = "var(--wizz-surface-alt)";

  row.appendChild(makeBatchSummaryColumn("found", "Available", "var(--wizz-ok)"));
  row.appendChild(makeBatchSummaryColumn("closed", "Closed", "var(--wizz-muted)"));
  row.appendChild(makeBatchSummaryColumn("errored", "Errored", "var(--wizz-danger)"));

  const routeList = document.querySelector(".route-list");
  if (routeList && routeList.parentNode) {
    routeList.parentNode.insertBefore(row, routeList);
  } else {
    document.body.appendChild(row);
  }
  return row;
}

function renderBatchSummary() {
  for (const key of ["found", "closed", "errored"]) {
    const element = document.getElementById(`batch-summary-${key}`);
    if (!element) continue;
    element.textContent = String(batchCounts[key]);
    if (key === "errored") {
      const alarmed = batchCounts[key] > 0;
      element.style.backgroundColor = alarmed ? "var(--wizz-danger)" : "transparent";
      element.style.color = alarmed ? "#ffffff" : "var(--wizz-danger)";
    }
  }
}

function bumpBatchSummary(kind) {
  batchCounts[kind]++;
  renderBatchSummary();
}

function resetBatchSummary() {
  batchCounts = { found: 0, closed: 0, errored: 0 };
  ensureBatchSummary();
  renderBatchSummary();
  document.getElementById("batch-summary").style.display = "flex";
}

// Debug mode: one live card per route with its current outcome
const DEBUG_STATES = {
  pending: { label: "in flight...", css: "is-info is-light" },
  found: { label: "Available", css: "is-success" },
  notfound: { label: "Closed", css: "is-light" },
  error: { label: "Errored", css: "is-danger" },
};

function isDebugMode() {
  const checkbox = document.getElementById("debug-mode-checkbox");
  return !!(checkbox && checkbox.checked);
}

// Per-route status cards. Every checked route gets one (in flight's final
// value or an Available/Closed/Errored tag); they are part of the result list
// at all times, but only visible when the "Show detailed log" toggle is on.
// Visibility is a container class, so flipping the toggle is retroactive.
function ensureRouteCards() {
  let container = document.getElementById("route-cards");
  if (!container) {
    const routeList = document.querySelector(".route-list");
    if (!routeList) return null;
    container = document.createElement("div");
    container.id = "route-cards";
    container.className = "route-cards";
    if (isDebugMode()) container.classList.add("show-details");
    routeList.prepend(container);
  }
  return container;
}

function applyStatusToCard(card, state, detail) {
  const badge = card.querySelector(".route-status-badge");
  badge.textContent = DEBUG_STATES[state].label;
  badge.className = "tag route-status-badge";
  DEBUG_STATES[state].css.split(" ").forEach((cls) => badge.classList.add(cls));

  const detailDiv = card.querySelector(".route-status-detail");
  if (detail) {
    detailDiv.textContent = detail;
    detailDiv.style.display = "block";
  } else {
    detailDiv.style.display = "none";
  }
}

function createStatusCard(routeKey, routeLabel) {
  // Matches the flight-item card style, in a smaller type; visibility is
  // controlled by the .route-cards container class, not the card itself
  const card = document.createElement("div");
  card.id = `route-card-${routeKey}`;
  card.className = "route-status-card";
  card.style.padding = "10px";
  card.style.marginBottom = "6px";
  card.style.border = "1px solid var(--wizz-border)";
  card.style.borderRadius = "5px";
  card.style.fontSize = "0.8em";

  const headerRow = document.createElement("div");
  headerRow.style.display = "flex";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.alignItems = "center";

  const routeSpan = document.createElement("span");
  routeSpan.textContent = routeLabel;
  headerRow.appendChild(routeSpan);

  const badge = document.createElement("span");
  badge.className = "tag route-status-badge";
  headerRow.appendChild(badge);
  card.appendChild(headerRow);

  const detailDiv = document.createElement("div");
  detailDiv.className = "route-status-detail";
  detailDiv.style.display = "none";
  detailDiv.style.color = "var(--wizz-muted)";
  detailDiv.style.marginTop = "4px";
  card.appendChild(detailDiv);

  return card;
}

// Live card (kept and updated during a batch, one per route)
function setRouteCard(container, routeKey, routeLabel, state, detail) {
  if (!container) return;
  let card = document.getElementById(`route-card-${routeKey}`);
  if (!card) {
    card = createStatusCard(routeKey, routeLabel);
    container.appendChild(card);
  }
  applyStatusToCard(card, state, detail);
}

// Session check: classify the current Wizz session without a full search
// Session status: colored dot + status text in the header, left of the
// refresh button. Kept the historical function name for the call sites.
let currentSessionState = "unknown";

function updateSessionChip(state) {
  currentSessionState = state || "unknown";
  const dot = document.getElementById("session-dot");
  const text = document.getElementById("session-text");
  if (!dot || !text) return;
  const states = {
    unknown: ["Session unknown", "var(--wizz-muted-light)"],
    checking: ["Checking session...", "var(--wizz-accent)"],
    valid: ["Session valid", "var(--wizz-ok)"],
    expired: ["Session expired", "var(--wizz-danger)"],
    ratelimited: ["Rate limited", "var(--wizz-warn)"],
    error: ["Check failed", "var(--wizz-warn)"],
  };
  const [label, color] = states[state] || states.unknown;
  text.textContent = label;
  dot.style.backgroundColor = color;
  // Flipping to valid should compose the countdown immediately, not wait
  // up to 15 s for the next tick
  if (currentSessionState === "valid" && typeof Android !== "undefined") {
    updateTokenCountdown();
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getTokenInfoSafe() {
  try {
    return JSON.parse(Android.getTokenInfo());
  } catch (e) {
    return null;
  }
}

/**
 * App only, optimistic auto-refresh: the multipass cookie is assumed to
 * outlive the JWT, so reloading the capture webview re-authenticates silently
 * and mints a fresh token. Called when Start sees the token dead or nearly
 * dead; polls until a healthy token is captured (or gives up like before).
 */
async function ensureFreshToken() {
  const info = getTokenInfoSafe();
  if (!info || !info.hasToken) return true; // never logged in: probe will decide
  const remaining = info.expiresAtEpochSeconds * 1000 - Date.now();
  if (remaining >= 60000) return true;

  console.log(
    `Token ${remaining > 0 ? `expires in ${formatRemaining(remaining)}` : "already expired"}: refreshing the capture webview`
  );
  Android.forceReLogin();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !batchAborted) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const fresh = getTokenInfoSafe();
    if (
      fresh &&
      fresh.hasToken &&
      fresh.expiresAtEpochSeconds * 1000 - Date.now() > 60000
    ) {
      console.log("Fresh token captured");
      return true;
    }
  }
  console.warn("Token refresh did not produce a fresh token in 60s");
  return false;
}

/**
 * App only: compose a real countdown into the session header from the JWT
 * `exp` claim of the captured token. Runs every 15 s.
 */
function updateTokenCountdown() {
  if (typeof Android === "undefined") return;
  const dot = document.getElementById("session-dot");
  const text = document.getElementById("session-text");
  if (!dot || !text) return;

  let info;
  try {
    info = JSON.parse(Android.getTokenInfo());
  } catch (e) {
    return;
  }
  if (!info || !info.hasToken) return;


  const remaining = info.expiresAtEpochSeconds * 1000 - Date.now();
  if (remaining <= 0) {
    if (currentSessionState === "valid") {
      text.textContent = "Session token expired — re-login advised";
      dot.style.backgroundColor = "var(--wizz-danger)";
    }
    return;
  }
  // The countdown reflects the JWT's own exp claim — ground truth of the
  // token — so it renders in any probe state (unknown, error, ratelimited);
  // only a definitive "expired" verdict hides it
  if (currentSessionState === "expired") return;

  const minutesLeft = remaining / 60000;
  const color = minutesLeft < 2 ? "var(--wizz-warn)" : "var(--wizz-ok)";
  text.textContent = `Session valid (${formatRemaining(remaining)})`;
  dot.style.backgroundColor = color;
}

function classifySessionStatus(status) {
  if (status === 401 || status === 403) return "expired";
  if (status === 429) return "ratelimited";
  if (status === 0) return "error";
  return "valid";
}

// The session status button doubles as the refresh control. In reload mode
// (extension: content script missing) clicking it reloads the Wizz page first.
function updateSessionButton(reloadMode) {
  const button = document.getElementById("check-session");
  if (!button) return;
  button.dataset.mode = reloadMode ? "reload" : "check";
  if (reloadMode) {
    const text = document.getElementById("session-text");
    if (text) text.textContent = "Session check failed — tap to reload";
  }
}

// Reload the multipass tab, then re-run the session check once it settles
function reloadPageAndCheckSession() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes("multipass.wizzair.com")) {
      updateSessionChip("error");
      return;
    }
    updateSessionChip("checking");
    chrome.tabs.reload(tab.id, {}, () => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        // give the content script and the SPA a moment to initialize
        setTimeout(checkSessionStatus, 2000);
      });
    });
  });
}

async function checkSessionStatus() {
  updateSessionChip("checking");
  try {
    if (typeof Android !== "undefined") {
      const response = await nativeHttpSessionProbe();
      const state = classifySessionStatus(response.status);
      // A 500 carrying error.token.mismatch means the captured JWT no longer
      // pairs with the cookie session — same practical consequence as expiry,
      // so don't let the lenient "any non-401 is valid" rule pass it
      if (String(response.body || "").includes("error.token.mismatch")) {
        console.log("Session check: token.mismatch in body, treating as expired");
        updateSessionChip("expired");
        Android.forceReLogin();
        return "expired";
      }
      console.log(`Session check: status=${response.status} state=${state}`);
      updateSessionChip(state);
      if (state === "expired") {
        Android.forceReLogin();
      }
      return state;
    }

    // Chrome extension: probe from the multipass page via the content script.
    // Any multipass tab will do (the sidebar can be open on any page), not
    // just the currently active one.
    const allTabs = await chrome.tabs.query({});
    const tab = (allTabs || []).find(
      (t) => t.url && t.url.includes("multipass.wizzair.com")
    );
    if (!tab) {
      updateSessionChip("error");
      throw new Error("Open the Wizz Air Multipass page to check the session");
    }
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: "checkSession" }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
        } else {
          resolve(res);
        }
      });
    });
    console.log("checkSession response from content script:", response);
    if (response && typeof response.status === "number") {
      const state = classifySessionStatus(response.status);
      console.log(
        `Session check: status=${response.status} state=${state} body=${(response.body || "").slice(0, 300)}`
      );
      updateSessionChip(state);
      updateSessionButton(false);
      return state;
    } else {
      console.error("Session check: no valid response (content script missing? reload the multipass page)");
      updateSessionChip("error");
      updateSessionButton(true);
    }
  } catch (error) {
    console.error("Session check failed:", error);
    updateSessionChip("error");
  }
  return "error";
}

function loadSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch (e) {
    console.error("Failed to load search history:", e);
    return [];
  }
}

function saveToHistory(searchType, origin, selectedDate, results, outcomes = []) {
  if (!results || results.length === 0) return;
  const history = loadSearchHistory();
  history.unshift({
    id: Date.now(),
    searchType: searchType,
    origin: origin,
    date: selectedDate,
    timestamp: Date.now(),
    results: results,
    outcomes: outcomes,
  });
  while (history.length > HISTORY_LIMIT) {
    history.pop();
  }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function deleteHistoryEntry(id) {
  const history = loadSearchHistory().filter((entry) => entry.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function clearSearchHistory() {
  localStorage.removeItem(HISTORY_KEY);
  showSearchHistory();
}

function showSearchHistory() {
  const history = loadSearchHistory();
  const resultsDiv = document.querySelector(".route-list");
  if (!resultsDiv) return;
  resultsDiv.innerHTML = "";

  // Dashboard and progress bar are live-view furniture: hidden in history
  // (also while a batch is running), restored by the Find Routes tab
  const summary = document.getElementById("batch-summary");
  if (summary) summary.style.display = "none";
  const bar = document.getElementById("batch-bar");
  if (bar) bar.style.display = "none";

  resultsDiv.style.fontFamily = "Arial, sans-serif";
  resultsDiv.style.maxWidth = "600px";
  resultsDiv.style.margin = "0 auto";

  // History mode: Start is out of context here; a same-sized Clear All takes
  // its full-width slot. Soft red (matching the per-row Delete buttons) —
  // the hard red stays reserved for Stop and the error labels.
  const startButton = document.getElementById("search-flights");
  if (startButton) startButton.style.display = "none";
  if (history.length !== 0) {
    document.getElementById("history-clear-all")?.remove();
    const clearAllButton = document.createElement("button");
    clearAllButton.id = "history-clear-all";
    clearAllButton.textContent = "Clear All";
    clearAllButton.classList.add(
      "button",
      "is-danger",
      "is-light",
      "is-fullwidth"
    );
    clearAllButton.style.marginBottom = "12px";
    clearAllButton.addEventListener("click", clearSearchHistory);
    if (startButton && startButton.parentNode) {
      startButton.parentNode.insertBefore(clearAllButton, startButton);
    } else {
      resultsDiv.prepend(clearAllButton);
    }
  }

  if (history.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "No previous searches yet.";
    emptyMessage.style.color = "var(--wizz-text-strong)";
    resultsDiv.appendChild(emptyMessage);
    return;
  }

  history.forEach((entry) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.marginBottom = "5px";

    const viewButton = document.createElement("button");
    viewButton.classList.add("button", "is-small", "is-light");
    const typeLabel = entry.searchType === "arrive" ? "arriving" : "departing";
    viewButton.style.flex = "1";
    viewButton.style.textAlign = "left";
    viewButton.style.justifyContent = "flex-start";
    const chevron = document.createElement("span");
    chevron.className = "history-chevron";
    viewButton.appendChild(chevron);
    viewButton.appendChild(
      document.createTextNode(
        `${entry.origin} (${typeLabel}) on ${entry.date} - ${entry.results.length} flights`
      )
    );

    // Accordion: the results panel sits right below the heading; first
    // click renders it (and re-renders into itself on later visits), and
    // clicking the heading again hides it
    const detail = document.createElement("div");
    detail.className = "history-entry-detail";
    viewButton.addEventListener("click", () => {
      const opening = detail.style.display !== "block";
      chevron.classList.toggle("open", opening);
      if (!opening) {
        detail.style.display = "none";
        return;
      }
      if (!detail.dataset.rendered) {
        displayResults(
          { [entry.date]: entry.results },
          false,
          entry.outcomes || [],
          detail
        );
        detail.dataset.rendered = "true";
      }
      detail.style.display = "block";
    });
    row.appendChild(viewButton);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.classList.add("button", "is-small", "is-danger", "is-light");
    deleteButton.style.marginLeft = "8px";
    deleteButton.addEventListener("click", () => {
      deleteHistoryEntry(entry.id);
      showSearchHistory();
    });
    row.appendChild(deleteButton);

    resultsDiv.appendChild(row);
    resultsDiv.appendChild(detail);
  });
}

/**
 * App only, async native HTTP. The old sync bridge (Android.checkRoute()
 * returning a String) blocked the WebView's JS thread on the HTTP call, so
 * the UI never painted mid-request. Now the native side runs the request on
 * a background executor and delivers via window.__nativeHttpCallback; here
 * we just bridge that into a Promise (with a timeout so a wedged delivery
 * can't hang a batch card forever).
 */
let nativeCallbackSeq = 0;
const nativeHttpWaiters = new Map();

window.__nativeHttpCallback = (id, response) => {
  const waiter = nativeHttpWaiters.get(id);
  if (!waiter) return;
  nativeHttpWaiters.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve(response);
};

function nativeHttpPost(url, payloadJson) {
  return new Promise((resolve) => {
    const id = `cb${++nativeCallbackSeq}`;
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        if (nativeHttpWaiters.delete(id)) {
          resolve({ status: 0, body: "native call timed out", headers: {} });
        }
      }, 45000),
    };
    nativeHttpWaiters.set(id, waiter);
    Android.checkRoute(url, payloadJson, id);
  });
}

function nativeHttpSessionProbe() {
  return new Promise((resolve) => {
    const id = `session${++nativeCallbackSeq}`;
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        if (nativeHttpWaiters.delete(id)) {
          resolve({ status: 0, body: "native call timed out", headers: {} });
        }
      }, 45000),
    };
    nativeHttpWaiters.set(id, waiter);
    Android.checkSession(id);
  });
}

async function checkRoute(origin, destination, date) {
  try {
    // Regular pacing: 1-4 s of jitter per request; the ONLY backoff besides
    // this is reactive (Wizz's Retry-After on 429 — see makeRateLimitError)
    const delay = Math.floor(Math.random() * 3000) + 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    const dynamicUrl = await getDynamicUrl();

    const data = {
      flightType: "OW",
      origin: origin,
      destination: destination,
      departure: date,
      arrival: "",
      intervalSubtype: null,
    };

    let headers = {
      "Content-Type": "application/json",
    };

/**
 * The multipass availability API answers in a couple of envelope shapes
 * (the in-page extension variant answers flat; the native replay sometimes
 * receives the same payload wrapped in a "content" envelope). Returns:
 *   - an array of flights when the shape is understood,
 *   - { closed: true } when Wizz explicitly says "nothing on this route/date"
 *     (error.availability, flat or nested),
 *   - { unknown: snippet } when no known shape matched, so the caller can
 *     surface the raw body instead of quietly reporting zero flights.
 */
function extractAvailabilityFlights(parsed) {
  const snippet = () => JSON.stringify(parsed).slice(0, 140);
  if (!parsed || typeof parsed !== "object") return { unknown: snippet() };
  if (parsed.code === "error.availability") return { closed: true };
  if (Array.isArray(parsed.flightsOutbound)) return parsed.flightsOutbound;
  const inner = parsed.content;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    if (inner.code === "error.availability") return { closed: true };
    if (Array.isArray(inner.flightsOutbound)) return inner.flightsOutbound;
    if (Array.isArray(inner.content)) return inner.content;
  }
  if (Array.isArray(parsed.content)) return parsed.content;
  return { unknown: snippet() };
}

    if (typeof Android !== "undefined") {
      // Route the API call through the native bridge to avoid CORS issues
      const callStart = Date.now();
      const response = await nativeHttpPost(dynamicUrl, JSON.stringify(data));
      logApiCall(
        `${origin}->${destination}`,
        response.status,
        Date.now() - callStart,
        String(response.body),
        response.headers
      );
      if (response.status === 429) {
        console.log("429 response body:", String(response.body).slice(0, 500));
        throw makeRateLimitError(getRetryAfterSeconds(response.headers));
      }
      if (response.status === 401 || response.status === 403) {
        Android.forceReLogin();
        throw new Error("Session expired. Please log in to Wizz Air again.");
      }

      const bodyText = String(response.body);
      if (bodyText.trimStart().startsWith("<")) {
        // Wizz serves the SPA's HTML wrapper (with HTTP 200) when the dynamic
        // URL/session is stale; the batch refreshes the capture and retries
        console.error("Availability endpoint returned HTML instead of JSON — captured session is stale");
        Android.forceReLogin();
        throw makeStaleUrlError("Wizz returned HTML instead of JSON. The captured session is stale; refreshing it and retrying.");
      }

      let responseData;
      try {
        responseData = JSON.parse(bodyText);
      } catch (parseError) {
        if (response.status >= 400) {
          throw makeHttpError(response.status, bodyText);
        }
        throw parseError;
      }
      const extracted = extractAvailabilityFlights(responseData);
      if (extracted.closed) return []; // nothing on this route/date
      if (Array.isArray(extracted)) return extracted;
      if (response.status >= 400) {
        throw makeHttpError(response.status, bodyText);
      }
      throw new Error(`Unexpected response shape: ${extracted.unknown}`);
    }

    // Chrome extension: repeat request headers captured by the content script
    const pageData = JSON.parse(localStorage.getItem("wizz_page_data") || "{}");
    const oneHourInMs = 60 * 60 * 1000;
    if (pageData.headers && Date.now() - pageData.timestamp < oneHourInMs) {
      console.log("Using cached headers");
      headers = { ...headers, ...pageData.headers };
    } else {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: "getHeaders" }, resolve);
      });
      if (response && response.headers) {
        headers = { ...headers, ...response.headers };
      } else {
        console.log("Failed to get headers from the page, using defaults");
      }
    }

    const fetchStart = Date.now();
    const fetchResponse = await fetch(dynamicUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(data),
    });
    const responseText = await fetchResponse.text();

    if (fetchResponse.status === 429) {
      const headerObj = {};
      fetchResponse.headers.forEach((value, name) => {
        headerObj[name] = value;
      });
      console.log("429 response body:", responseText.slice(0, 500));
      logApiCall(
        `${origin}->${destination}`,
        429,
        Date.now() - fetchStart,
        responseText,
        headerObj
      );
      throw makeRateLimitError(getRetryAfterSeconds(headerObj));
    }

    logApiCall(
      `${origin}->${destination}`,
      fetchResponse.status,
      Date.now() - fetchStart,
      responseText
    );

    if (responseText.trimStart().startsWith("<")) {
      // HTML with HTTP 200 means the cached dynamic URL is stale; mark the
      // error retryable — the batch then reloads the Wizz page (the source of
      // the URL) and retries with a fresh capture
      console.error("Availability endpoint returned HTML instead of JSON — cached dynamic URL is stale, dropping it");
      const pageData = JSON.parse(localStorage.getItem("wizz_page_data") || "{}");
      delete pageData.dynamicUrl;
      localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
      throw makeStaleUrlError("Wizz returned HTML instead of JSON (stale search endpoint — refreshing the Wizz page and retrying).");
    }

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (parseError) {
      if (!fetchResponse.ok) {
        throw makeHttpError(fetchResponse.status, responseText);
      }
      throw parseError;
    }
    const extracted = extractAvailabilityFlights(responseData);
    if (extracted.closed) return []; // nothing on this route/date
    if (Array.isArray(extracted)) return extracted;
    if (!fetchResponse.ok) {
      throw makeHttpError(fetchResponse.status, responseText);
    }
    throw new Error(`Unexpected response shape: ${extracted.unknown}`);
  } catch (error) {
    console.error("Error in checkRoute:", error);
    throw error;
  }
}

async function checkAllRoutes() {
  console.log("checkAllRoutes started");

  const originInput = document.getElementById("airport-input");
  const origin =
    resolveAirportInput(originInput.value) || originInput.value.toUpperCase();
  const selectedDate = getSelectedDate();
  const searchType = getSearchType();

  // The same button starts and stops: while a batch runs, clicking it aborts.
  // Stop takes precedence over validation — aborting must never be refused.
  if (batchRunning) {
    console.log("Stop pressed: aborting the batch");
    batchAborted = true;
    return;
  }

  if (!origin) {
    alert("Please enter an airport code.");
    return;
  }

  batchRunning = true;
  batchAborted = false;
  if (typeof Android !== "undefined") Android.batchKeepAlive(true);
  setMainButtonRunning(true);
  ensureBatchBar();
  updateBatchBar("Checking session...", 0);

  let routeListElement = document.querySelector(".route-list");
  const flightsByDate = {};

  try {
    if (!routeListElement) {
      throw new Error(".route-list element not found in the DOM");
    }

    // Optimistic auto-refresh: a dead or nearly-dead token recovers by itself
    // (silent cookie re-auth in the capture webview) instead of failing the
    // batch. No token info at all = never logged in; let the probe decide.
    if (typeof Android !== "undefined") {
      updateBatchBar("Checking session token...", 0);
      const refreshed = await ensureFreshToken();
      if (!refreshed) {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">Token expired and could not be refreshed automatically. Open the Wizz page (top right) and log in again.</p>`;
        return;
      }
    }

    // Probe session/token health first: only a definite "valid" starts a batch
    const sessionState = await checkSessionStatus();
    if (sessionState !== "valid") {
      console.log(`Check Routes aborted: session state is ${sessionState}`);
      if (sessionState === "expired") {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">Session expired. Please log in to Wizz Air and try again.</p>`;
      } else if (sessionState === "ratelimited") {
        document.querySelector("#rate-limited-message").style.display = "block";
      } else {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">Could not verify the session. Tap the session status at the top and try again.</p>`;
        if (typeof Android !== "undefined") {
          Android.openWizzLogin();
        }
      }
      return;
    }

    // Clear previous results
    document.querySelector("#rate-limited-message").style.display = "none";
    routeListElement.innerHTML = "";

    updateBatchBar("Waiting for Wizz Air routes...", 0);
    const destinations = await fetchDestinations(origin, searchType);
    console.log("Fetched destinations:", destinations.length, "routes");
    refreshAirportSuggestions();

    updateBatchBar(`0/${destinations.length}`, 0);
    resetBatchSummary();

    // Live per-route status cards, kept in sync during the batch; the
    // "Show detailed log" toggle only flips this container's visibility
    const cardContainer = ensureRouteCards();

    const results = [];
    const outcomes = [];
    let completedRoutes = 0;
    let isRateLimited = false;
    let staleRefreshes = 0;
    const MAX_STALE_REFRESHES = 3;

    for (const destination of destinations) {
      if (batchAborted) {
        console.log("Batch stopped by user");
        break;
      }
      if (isRateLimited) break;

      const apiOrigin = searchType === "arrive" ? destination : origin;
      const apiDestination = searchType === "arrive" ? origin : destination;
      const routeLabel = `${apiOrigin} to ${apiDestination}`;

      updateBatchBar(
        `Checking ${routeLabel}... ${completedRoutes}/${destinations.length}`,
        completedRoutes / destinations.length
      );

      const routeKey = `${apiOrigin}-${apiDestination}`.replace(/[^A-Za-z0-9-]/g, "_");
      setRouteCard(cardContainer, routeKey, routeLabel, "pending");

      let routeComplete = false;
      let backoffsForRoute = 0;
      while (!routeComplete && !batchAborted && !isRateLimited) {
        try {
          const flights = await checkRoute(apiOrigin, apiDestination, selectedDate);
          routeComplete = true;
          if (flights && flights.length > 0) {
            bumpBatchSummary("found");
            const detail = `${flights.length} flights`;
            setRouteCard(cardContainer, routeKey, routeLabel, "found", detail);
            outcomes.push({ route: routeLabel, status: "available", detail: detail });
            flights.forEach((flight) => {
              const flightInfo = {
                route: `${apiOrigin} (${flight.departureStationText}) to ${apiDestination} (${flight.arrivalStationText}) - ${flight.flightCode}`,
                date: flight.departureDate,
                departure: `${flight.departure} (${flight.departureOffsetText})`,
                arrival: `${flight.arrival} (${flight.arrivalOffsetText})`,
                duration: flight.duration,
              };

              results.push(flightInfo);

              if (!flightsByDate[selectedDate]) {
                flightsByDate[selectedDate] = [];
              }
              flightsByDate[selectedDate].push(flightInfo);
              displayResults(flightsByDate, true);
            });
          } else {
            bumpBatchSummary("closed");
            setRouteCard(cardContainer, routeKey, routeLabel, "notfound");
            outcomes.push({ route: routeLabel, status: "closed", detail: "" });
          }
        } catch (error) {
          console.error(
            `Error processing ${apiOrigin} to ${apiDestination} on ${selectedDate}:`,
            error.message
          );

          // Session-level breakage: the captured JWT no longer pairs with the
          // server's expected session. Retrying routes is pointless — stop.
          if (String(error.message || "").includes("error.token.mismatch")) {
            console.error("Token mismatch — stopping batch");
            if (typeof Android !== "undefined") Android.forceReLogin();
            routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">Wizz rejected the captured token (token.mismatch). Open the Wizz page (top right) and log in again.</p>`;
            return;
          }

          if (error.isRateLimit) {
            backoffsForRoute++;
            if (backoffsForRoute > MAX_BACKOFFS_PER_BATCH) {
              console.error(`Giving up: still rate limited after ${MAX_BACKOFFS_PER_BATCH} backoffs`);
              const detail = `Gave up after ${backoffsForRoute - 1} backoffs (rate limited)`;
              bumpBatchSummary("errored");
              setRouteCard(cardContainer, routeKey, routeLabel, "error", detail);
              outcomes.push({ route: routeLabel, status: "errored", detail: detail });
              isRateLimited = true;
              document.querySelector("#rate-limited-message").style.display =
                "block";
              break;
            }
            // Honor Wizz's requested back-off, then retry the same route
            const wait = error.backoffSeconds || DEFAULT_BACKOFF_SECONDS;
            console.log(`Backing off ${wait}s at Wizz's request (retry ${backoffsForRoute}/${MAX_BACKOFFS_PER_BATCH})`);
            updateBatchBar(
              `Backing off ${wait}s at Wizz's request (${completedRoutes}/${destinations.length})`,
              completedRoutes / destinations.length
            );
            await abortableSleep(wait * 1000, (remaining) => {
              updateBatchBar(
                `Backing off ${Math.ceil(remaining / 1000)}s at Wizz's request (${completedRoutes}/${destinations.length})`,
                completedRoutes / destinations.length
              );
            });
            if (batchAborted) {
              console.log("Batch stopped by user during rate-limit backoff");
              break;
            }
            updateBatchBar(
              `Retrying ${apiOrigin} to ${apiDestination}... ${completedRoutes}/${destinations.length}`,
              completedRoutes / destinations.length
            );
            continue;
          }

          if (error.isStaleUrl) {
            if (staleRefreshes >= MAX_STALE_REFRESHES) {
              console.error(`Giving up: still returning HTML after ${MAX_STALE_REFRESHES} refreshes`);
              const detail = `Gave up after ${MAX_STALE_REFRESHES} refreshes (Wizz keeps returning HTML)`;
              routeComplete = true;
              bumpBatchSummary("errored");
              setRouteCard(cardContainer, routeKey, routeLabel, "error", detail);
              outcomes.push({ route: routeLabel, status: "errored", detail: detail });
            } else {
              staleRefreshes++;
              console.log(`Stale search endpoint: refreshing the Wizz page (refresh ${staleRefreshes}/${MAX_STALE_REFRESHES})`);
              updateBatchBar(
                `Stale URL, reloading Wizz page... (${completedRoutes}/${destinations.length})`,
                completedRoutes / destinations.length
              );
              const refreshed = await refreshDynamicSource();
              if (refreshed) {
                updateBatchBar(
                  `Retrying ${apiOrigin} to ${apiDestination}... ${completedRoutes}/${destinations.length}`,
                  completedRoutes / destinations.length
                );
                continue;
              }
              if (batchAborted) break;
              const detail = "Stale search endpoint and the Wizz page could not be refreshed";
              routeComplete = true;
              bumpBatchSummary("errored");
              setRouteCard(cardContainer, routeKey, routeLabel, "error", detail);
              outcomes.push({ route: routeLabel, status: "errored", detail: detail });
            }
          } else {
            routeComplete = true;
            bumpBatchSummary("errored");
            setRouteCard(cardContainer, routeKey, routeLabel, "error", error.message);
            outcomes.push({ route: routeLabel, status: "errored", detail: error.message });
          }
        }
      }

      if (isRateLimited) break;

      completedRoutes++;
      updateBatchBar(
        `${completedRoutes}/${destinations.length}`,
        completedRoutes / destinations.length
      );
    }

    removeBatchBar();

    if (batchAborted) {
      console.log(`Batch aborted after ${completedRoutes}/${destinations.length}; keeping partial results`);
      if (routeListElement.children.length === 0) {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">Stopped by user. Nothing Available yet.</p>`;
      }
    } else if (!isRateLimited) {
      if (results.length === 0) {
        showBatchNotice(`All routes Closed for ${selectedDate}.`);
      } else {
        // No re-render here: the live-appended date headers, flight cards and
        // status cards already on screen ARE the final view, and wiping them
        // would also wipe the retroactive outcome cards
        saveToHistory(
          searchType,
          origin,
          selectedDate,
          flightsByDate[selectedDate] || [],
          outcomes
        );
      }
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
    if (routeListElement) {
      routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
    }
  } finally {
    batchRunning = false;
    batchAborted = false;
    if (typeof Android !== "undefined") Android.batchKeepAlive(false);
    setMainButtonRunning(false);
    removeBatchBar();
  }
}

function displayResults(
  flightsByDate,
  append = false,
  outcomes = null,
  targetElement = null
) {
  // targetElement: render into a detached container (history accordion
  // panels); default is the live .route-list
  const routeListElement =
    targetElement || document.querySelector(".route-list");
  if (!routeListElement) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  if (!append) {
    routeListElement.innerHTML = "";
  }

  const dates = Object.keys(flightsByDate);
  if (dates.length === 0) {
    const section = document.createElement("div");
    section.classList.add("route-date-header");
    section.textContent = `All routes Closed for ${getSelectedDate()}`;
    routeListElement.appendChild(section);
    return;
  }

  // Outcome cards first (Closed / Errored; visible only with the toggle on),
  // then the date sections with the always-visible flight cards
  if (!append && outcomes && outcomes.length > 0) {
    const container = document.createElement("div");
    container.className = "route-cards";
    if (isDebugMode()) container.classList.add("show-details");
    for (const outcome of outcomes) {
      if (outcome.status === "available") continue;
      // History entries store human statuses; map to DEBUG_STATES keys
      const stateKey = outcome.status === "closed" ? "notfound" : "error";
      const card = createStatusCard(`hist-${container.children.length}`, outcome.route);
      applyStatusToCard(card, stateKey, outcome.detail);
      container.appendChild(card);
    }
    routeListElement.appendChild(container);
  }

  for (const date of dates) {
    let dateHeader = append
      ? routeListElement.querySelector(`h3[data-date="${date}"]`)
      : null;
    let flightList = append
      ? routeListElement.querySelector(`ul[data-date="${date}"]`)
      : null;

    if (!dateHeader) {
      dateHeader = document.createElement("h3");
      dateHeader.setAttribute("data-date", date);
      dateHeader.classList.add("route-date-header");
      dateHeader.style.backgroundColor = "var(--wizz-surface-alt)";
      dateHeader.style.padding = "8px 10px";
      dateHeader.style.borderRadius = "5px";
      dateHeader.style.fontSize = "0.9em";
      dateHeader.style.fontWeight = "bold";
      dateHeader.style.color = "var(--wizz-text-soft)";
      dateHeader.textContent = new Date(date).toLocaleDateString("en-US", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      routeListElement.appendChild(dateHeader);
    }

    if (!flightList) {
      flightList = document.createElement("ul");
      flightList.setAttribute("data-date", date);
      flightList.style.listStyleType = "none";
      flightList.style.padding = "0";
      flightList.style.margin = "0 0 8px";
      routeListElement.appendChild(flightList);
    }

    // In append mode only the newest flight of each date is new; a full
    // (non-append) render lists them all
    const flightsToProcess = append ? [flightsByDate[date][flightsByDate[date].length - 1]] : flightsByDate[date];

    for (const flight of flightsToProcess) {
      const flightItem = document.createElement("li");
      flightItem.style.marginBottom = "15px";
      flightItem.style.padding = "10px";
      flightItem.style.border = "1px solid var(--wizz-border)";
      flightItem.style.borderRadius = "5px";
      flightItem.style.display = "flex";
      flightItem.style.flexDirection = "column";
      flightItem.style.gap = "5px";

      const routeDiv = document.createElement("div");
      routeDiv.textContent = flight.route;
      routeDiv.style.fontWeight = "bold";
      routeDiv.style.marginBottom = "5px";

      const detailsDiv = document.createElement("div");
      detailsDiv.style.display = "flex";
      detailsDiv.style.justifyContent = "space-between";

      const departureDiv = document.createElement("div");
      departureDiv.appendChild(document.createTextNode("✈️ Departure:"));
      departureDiv.appendChild(document.createElement("br"));
      departureDiv.appendChild(document.createTextNode(flight.departure));

      const arrivalDiv = document.createElement("div");
      arrivalDiv.appendChild(document.createTextNode("🛬 Arrival:"));
      arrivalDiv.appendChild(document.createElement("br"));
      arrivalDiv.appendChild(document.createTextNode(flight.arrival));

      const durationDiv = document.createElement("div");
      durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;
      durationDiv.style.fontSize = "0.85em";
      durationDiv.style.color = "var(--wizz-muted)";

      detailsDiv.appendChild(departureDiv);
      detailsDiv.appendChild(arrivalDiv);

      flightItem.appendChild(routeDiv);
      flightItem.appendChild(detailsDiv);
      flightItem.appendChild(durationDiv);

      flightList.appendChild(flightItem);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");
  const checkFlightsButton = document.getElementById("search-flights");
  const routeListElement = document.querySelector(".route-list");
  const airportInput = document.getElementById("airport-input");

  // state used to come from radio inputs; after the conversion to buttons,
  // nothing flipped it.
  document.querySelectorAll("#search-type-tabs .button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#search-type-tabs .button").forEach((b) => {
        const active = b === button;
        b.classList.toggle("is-link", active);
        b.classList.toggle("is-light", !active);
      });
      console.log(`Search type: ${getSearchType()}`);
    });
  });

  if (checkFlightsButton) {
    console.log("Check Flights button found");
    checkFlightsButton.addEventListener("click", () => {
      console.log("Check Flights button clicked");

      checkAllRoutes().catch((error) => {
        console.error("Error in checkAllRoutes:", error);
        if (routeListElement) {
          routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
        }
      });
    });
  } else {
    console.error("Check Flights button not found");
  }

  // Main tabs: Find Routes | Search History — attached buttons, one active
  const tabsRow = document.createElement("div");
  tabsRow.id = "main-tabs";
  tabsRow.classList.add("buttons", "has-addons", "mb-3");
  const findRoutesTab = document.createElement("button");
  findRoutesTab.type = "button";
  findRoutesTab.textContent = "Find Routes";
  findRoutesTab.classList.add("button", "is-link");
  const historyTab = document.createElement("button");
  historyTab.type = "button";
  historyTab.textContent = "Search History";
  historyTab.classList.add("button", "is-light");
  tabsRow.appendChild(findRoutesTab);
  tabsRow.appendChild(historyTab);

  const activateTab = (activeTab) => {
    [findRoutesTab, historyTab].forEach((tab) => {
      tab.classList.toggle("is-link", tab === activeTab);
      tab.classList.toggle("is-light", tab !== activeTab);
    });
  };

  findRoutesTab.addEventListener("click", () => {
    activateTab(findRoutesTab);
    const routeList = document.querySelector(".route-list");
    if (routeList) routeList.innerHTML = "";
    // Undo history mode: Start back in place, promoted Clear All away;
    // dashboard and progress bar return too (they reflect the last batch)
    const startButton = document.getElementById("search-flights");
    if (startButton) startButton.style.display = "";
    document.getElementById("history-clear-all")?.remove();
    const summary = document.getElementById("batch-summary");
    if (summary) summary.style.display = "flex";
    const bar = document.getElementById("batch-bar");
    if (bar) bar.style.display = "flex";
  });
  historyTab.addEventListener("click", () => {
    activateTab(historyTab);
    showSearchHistory();
  });

  // "Show detailed log" toggle: shows/hides the per-route status cards;
  // cards are always built during a batch (and stored in history entries),
  // the switch only flips their visibility — retroactively
  const debugField = document.createElement("div");
  debugField.id = "detailed-log-row";
  debugField.className = "detailed-log-row";
  debugField.innerHTML =
    '<span class="switch-label">Show detailed log</span>' +
    '<label class="wizz-switch"><input type="checkbox" id="debug-mode-checkbox"><span class="slider"></span></label>';
  debugField
    .querySelector("#debug-mode-checkbox")
    .addEventListener("change", (event) => {
      document.querySelectorAll(".route-cards").forEach((container) => {
        container.classList.toggle("show-details", event.target.checked);
      });
    });

  // Session header: the status chip itself is the refresh control (dot + text
  // in a button); actions sit on the right
  const sessionHeader = document.createElement("div");
  sessionHeader.id = "session-header";
  sessionHeader.classList.add("mb-4");
  sessionHeader.style.display = "flex";
  sessionHeader.style.alignItems = "center";
  sessionHeader.style.justifyContent = "space-between";

  const statusButton = document.createElement("button");
  statusButton.id = "check-session";
  statusButton.classList.add("button", "is-small", "is-light");
  statusButton.style.display = "flex";
  statusButton.style.alignItems = "center";
  statusButton.style.gap = "8px";
  statusButton.title = "Refresh session status";

  const sessionDot = document.createElement("span");
  sessionDot.id = "session-dot";
  sessionDot.style.width = "10px";
  sessionDot.style.height = "10px";
  sessionDot.style.borderRadius = "50%";
  sessionDot.style.backgroundColor = "var(--wizz-muted-light)";
  sessionDot.style.flexShrink = "0";
  sessionDot.style.display = "inline-block";

  const sessionText = document.createElement("span");
  sessionText.id = "session-text";
  sessionText.textContent = "Session unknown";
  sessionText.style.fontSize = "0.85em";

  statusButton.appendChild(sessionDot);
  statusButton.appendChild(sessionText);
  statusButton.addEventListener("click", () => {
    if (typeof Android === "undefined" && statusButton.dataset.mode === "reload") {
      reloadPageAndCheckSession();
    } else {
      statusButton.dataset.mode = "check";
      checkSessionStatus();
    }
  });
  sessionHeader.appendChild(statusButton);

  const actionWrap = document.createElement("div");
  actionWrap.style.display = "flex";
  actionWrap.style.gap = "8px";

  // Theme cycle button: single icon button (like the session chip) that
  // walks light -> dark -> auto; the icon shows the active mode
  const themeButton = document.createElement("button");
  themeButton.id = "theme-toggle";
  themeButton.classList.add("button", "is-small", "is-light");
  themeButton.setAttribute("aria-label", "Cycle theme");
  themeButton.title = "Cycle theme";
  const themeIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const themeIcons = {
    light:
      '<span class="icon is-small">' +
      themeIcon +
      '<circle cx="12" cy="12" r="5"/>' +
      '<line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>' +
      '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
      '<line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>' +
      '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>' +
      "</svg></span>",
    dark:
      '<span class="icon is-small">' +
      themeIcon +
      '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' +
      "</svg></span>",
    auto: '<span class="icon is-small">' + themeIcon +
      '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>' +
      '<line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' +
      "</svg></span>",
  };
  const renderThemeButton = () => {
    themeButton.innerHTML = themeIcons[getThemeMode()];
  };
  themeButton.addEventListener("click", () => {
    const order = ["light", "dark", "auto"];
    const next = order[(order.indexOf(getThemeMode()) + 1) % order.length];
    setThemeMode(next);
    renderThemeButton();
  });
  renderThemeButton();
  actionWrap.appendChild(themeButton);

  // Open/switch to the Wizz Air Multipass page: keeps the session's source
  // page around (staying active there keeps the token warm). In the app it
  // shows the capture webview; it closes with its X or the back button.
  const pageButton = document.createElement("button");
  pageButton.id = "wizz-page";
  pageButton.textContent = "Wizz AYCF Page";
  pageButton.classList.add("button", "is-small", "is-info", "is-light");
  pageButton.addEventListener("click", () => {
    if (typeof Android !== "undefined") {
      console.log("Opening Wizz session webview");
      Android.openWizzPage();
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      const existing = tabs.find(
        (t) => t.url && t.url.includes("multipass.wizzair.com")
      );
      if (existing) {
        chrome.tabs.update(existing.id, { active: true });
      } else {
        chrome.tabs.create({
          url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets",
          active: true,
        });
      }
    });
  });
  actionWrap.appendChild(pageButton);

  // No manual Re-login button: the page always re-captures routes/URL on
  // load (app side), and the programmatic forceReLogin() covers expiry and
  // stale-session recovery automatically.

  sessionHeader.appendChild(actionWrap);

  // App-style header bar pinned to the top of the page, above all content
  document.body.insertBefore(sessionHeader, document.body.firstChild);

  if (checkFlightsButton) {
    const parentNode = checkFlightsButton.parentNode;
    parentNode.insertBefore(tabsRow, checkFlightsButton);
    // "Show detailed log" sits just above the Find Routes | Search History tabs
    parentNode.insertBefore(debugField, tabsRow);
  }
  if (routeListElement && routeListElement.parentNode) {
    // keep in DOM even if insertion above failed; harmless fallback
    if (!debugField.parentNode) {
      routeListElement.parentNode.insertBefore(debugField, routeListElement);
    }
  }

  // Live token expiry countdown in the session header (app only)
  if (typeof Android !== "undefined") {
    updateTokenCountdown();
    setInterval(updateTokenCountdown, 15000);
  }

  // The dropdown's data is whatever routes JSON was captured/scraped, never
  // stale. Gate the airport input on that data instead of letting anyone
  // type into an empty-suggestions field.
  const airportGate = () => {
    if (Android.hasWizzData()) {
      airportInput.disabled = false;
      airportInput.placeholder = "Type an airport name...";
      return;
    }
    airportInput.disabled = true;
    airportInput.placeholder = "Loading airport data...";
    setTimeout(airportGate, 1000);
  };
  if (typeof Android !== "undefined") {
    // App: the capture lands when the login webview delivers its data
    const previousReadyHook = window.__onWizzDataReady;
    window.__onWizzDataReady = () => {
      if (typeof previousReadyHook === "function") previousReadyHook();
      refreshAirportSuggestions();
    };
    airportGate();

    // Probe on open too: without it the chip sits at "Session unknown" and
    // the countdown's (former) state gate hid it until the first Start
    checkSessionStatus().catch((e) => console.warn("Auto session check:", e));
  } else {
    // Extension: poll the cache; while nothing is cached, actively scrape
    // the multipass tab. Give up after 10s — enable typing and let Check
    // Routes handle data collection (it opens the multipass page itself).
    let polls = 0;
    let lastScrapePoll = -5;
    const extensionGate = () => {
      polls += 1;
      if (refreshAirportSuggestions()) {
        airportInput.disabled = false;
        airportInput.placeholder = "Type an airport name...";
        return;
      }
      if (polls > 10) {
        airportInput.disabled = false;
        airportInput.placeholder = "Type an airport name...";
        return;
      }
      airportInput.disabled = true;
      airportInput.placeholder = "Loading airport data...";
      if (polls - lastScrapePoll >= 5) {
        lastScrapePoll = polls;
        scrapeRoutesFromMultipassTab();
      }
      setTimeout(extensionGate, 1000);
    };
    extensionGate();

    // Auto-run the session check the moment the popup opens, and grab a
    // fresh routes scrape while the multipass tab is being poked anyway
    checkSessionStatus().catch((e) => console.warn("Auto session check:", e));
    scrapeRoutesFromMultipassTab();
  }

  refreshAirportSuggestions();
  setupAirportDropdown();
});

/** The selected date, from the four calendar-style tab-buttons. */
function getSelectedDate() {
  const active = document.querySelector("#date-tabs .button.is-link");
  return active ? active.getAttribute("data-date") : null;
}

document.addEventListener("DOMContentLoaded", function () {
  const dateTabs = document.getElementById("date-tabs");
  const today = new Date();
  const buttons = [];

  for (let i = 0; i < 4; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("button");
    // Local date, not toISOString: at 00:30 in Bucharest the UTC ISO date is
    // still yesterday, and the chip would say Nov 19 while searching Nov 18
    button.dataset.date =
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0");

    const monthDay = document.createElement("span");
    monthDay.textContent = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    monthDay.classList.add("date-chip-title");

    const weekday = document.createElement("span");
    weekday.textContent = date.toLocaleDateString("en-US", {
      weekday: "long",
    });
    weekday.classList.add("date-chip-caption");

    // Title on top, weekday caption under it
    button.appendChild(monthDay);
    button.appendChild(weekday);

    button.addEventListener("click", () => {
      buttons.forEach((b) => {
        const active = b === button;
        b.classList.toggle("is-link", active);
        b.classList.toggle("is-light", !active);
      });
      console.log(`Selected departure date: ${button.dataset.date}`);
    });

    dateTabs.appendChild(button);
    buttons.push(button);
  }
  // Default: today
  buttons[0].classList.add("is-link");
  for (let i = 1; i < buttons.length; i++) {
    buttons[i].classList.add("is-light");
  }
});
