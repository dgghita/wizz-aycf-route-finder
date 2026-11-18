console.log("popup.js loaded");

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

async function fetchDestinations(origin) {
  if (typeof Android !== "undefined") {
    Android.openWizzLogin();

    const routes = await waitForWizzData();
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
    throw new Error(`No routes found from ${origin}`);
  }

  // Chrome extension: use cached page data or the content script
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.routes) {
      console.log("Using cached routes data");
      const routesFromOrigin = data.routes.find(
        (route) => route.departureStation.id === origin
      );
      if (routesFromOrigin && routesFromOrigin.arrivalStations) {
        const destinationIds = routesFromOrigin.arrivalStations.map(
          (station) => station.id
        );
        console.log(`Routes from ${origin}:`, destinationIds);
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

              const routesFromOrigin = response.routes.find(
                (route) => route.departureStation.id === origin
              );
              if (routesFromOrigin && routesFromOrigin.arrivalStations) {
                const destinationIds = routesFromOrigin.arrivalStations.map(
                  (station) => station.id
                );
                console.log(`Routes from ${origin}:`, destinationIds);
                resolve(destinationIds);
              } else {
                reject(new Error(`No routes found from ${origin}`));
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

const HISTORY_KEY = "wizz_search_history";
const HISTORY_LIMIT = 20;

function loadSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch (e) {
    console.error("Failed to load search history:", e);
    return [];
  }
}

function saveToHistory(searchType, origin, selectedDate, results) {
  if (!results || results.length === 0) return;
  const history = loadSearchHistory();
  history.unshift({
    id: Date.now(),
    searchType: searchType,
    origin: origin,
    date: selectedDate,
    timestamp: Date.now(),
    results: results,
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

  resultsDiv.style.fontFamily = "Arial, sans-serif";
  resultsDiv.style.maxWidth = "600px";
  resultsDiv.style.margin = "0 auto";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.marginBottom = "10px";

  const title = document.createElement("h2");
  title.textContent = "Search History";
  header.appendChild(title);

  if (history.length !== 0) {
    const clearAllButton = document.createElement("button");
    clearAllButton.textContent = "Clear All";
    clearAllButton.classList.add("button", "is-small", "is-danger", "is-light");
    clearAllButton.addEventListener("click", clearSearchHistory);
    header.appendChild(clearAllButton);
  }

  resultsDiv.appendChild(header);

  if (history.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "No previous searches yet.";
    emptyMessage.style.color = "#0f0f0f";
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
    viewButton.textContent = `${entry.origin} (${typeLabel}) on ${entry.date} - ${entry.results.length} flights`;
    viewButton.addEventListener("click", () => {
      displayResults({ [entry.date]: entry.results });
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
  });
}

async function checkRoute(origin, destination, date) {
  try {
    const delay = Math.floor(Math.random() * (1000 - 500 + 1)) + 1000;
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

    if (typeof Android !== "undefined") {
      // Route the API call through the native bridge to avoid CORS issues
      const responseJson = Android.checkRoute(dynamicUrl, JSON.stringify(data));
      const response = JSON.parse(responseJson);

      if (response.status === 429) {
        document.querySelector("#rate-limited-message").style.display = "block";
        throw new Error("429 Rate limited");
      }
      if (response.status === 401 || response.status === 403) {
        Android.forceReLogin();
        throw new Error("Session expired. Please log in to Wizz Air again.");
      }
      if (response.status >= 400) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const responseData = JSON.parse(response.body);
      return responseData.flightsOutbound || [];
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

    const fetchResponse = await fetch(dynamicUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(data),
    });

    if (!fetchResponse.ok) {
      throw new Error(`HTTP error! status: ${fetchResponse.status}`);
    }

    const responseData = await fetchResponse.json();
    return responseData.flightsOutbound || [];
  } catch (error) {
    console.error("Error in checkRoute:", error);
    if (error.message.includes("429")) {
      document.querySelector("#rate-limited-message").style.display = "block";
    }
    throw error;
  }
}

async function checkAllRoutes() {
  console.log("checkAllRoutes started");

  const audioCheckbox = document.getElementById("play-audio-checkbox");
  const audioPlayer = document.getElementById("background-music");
  if (audioCheckbox.checked && audioPlayer) {
    audioPlayer.play();
  }

  const originInput = document.getElementById("airport-input");
  const dateSelect = document.getElementById("date-select");
  const origin = originInput.value.toUpperCase();
  const selectedDate = dateSelect.value;
  const searchType = document.querySelector('input[name="searchType"]:checked').value;

  if (!origin) {
    alert("Please enter an airport code.");
    return;
  }

  // Clear previous results
  let routeListElement = document.querySelector(".route-list");
  document.querySelector("#rate-limited-message").style.display = "none";
  routeListElement.innerHTML = "";

  const flightsByDate = {};

  if (!routeListElement) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  try {
    const destinations = await fetchDestinations(origin);
    console.log("Fetched destinations:", destinations);

    const progressElement = document.createElement("div");
    progressElement.id = "progress";
    progressElement.style.marginBottom = "10px";
    routeListElement.insertBefore(progressElement, routeListElement.firstChild);

    const results = [];
    let completedRoutes = 0;
    let isRateLimited = false;

    for (const destination of destinations) {
      if (isRateLimited) break;

      if (completedRoutes > 0 && completedRoutes % 25 === 0) {
        progressElement.textContent = `Taking a 15 second break to avoid rate limiting...`;
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }

      const apiOrigin = searchType === "arrive" ? destination : origin;
      const apiDestination = searchType === "arrive" ? origin : destination;

      const updateProgress = () => {
        progressElement.textContent = `Checking ${apiOrigin} to ${apiDestination}... ${completedRoutes}/${destinations.length}`;
      };
      try {
        const flights = await checkRoute(apiOrigin, apiDestination, selectedDate);
        if (flights && flights.length > 0) {
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
        }
      } catch (error) {
        console.error(
          `Error processing ${origin} to ${destination} on ${selectedDate}:`,
          error.message
        );

        if (
          error.message.includes("429") ||
          error.message.includes("Rate limited")
        ) {
          isRateLimited = true;
          document.querySelector("#rate-limited-message").style.display =
            "block";
          break;
        }
      }

      completedRoutes++;
      updateProgress();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    progressElement.remove();

    if (!isRateLimited) {
      if (results.length === 0) {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">No flights available for ${selectedDate}.</p>`;
      } else {
        await displayResults(flightsByDate);
        saveToHistory(searchType, origin, selectedDate, flightsByDate[selectedDate]);
      }

      const audioPlayer = document.getElementById("background-music");
      if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.remove();
      }
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
    routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;

    const audioPlayer = document.getElementById("background-music");
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.remove();
    }
  }
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayResults(flightsByDate, append = false) {
  const resultsDiv = document.querySelector(".route-list");
  if (!resultsDiv) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  if (!append) {
    resultsDiv.innerHTML = "";
  }

  resultsDiv.style.fontFamily = "Arial, sans-serif";
  resultsDiv.style.maxWidth = "600px";
  resultsDiv.style.margin = "0 auto";

  for (const [date, flights] of Object.entries(flightsByDate)) {
    if (flights.length > 0) {
      let dateHeader = append
        ? resultsDiv.querySelector(`h3[data-date="${date}"]`)
        : null;
      let flightList = append
        ? resultsDiv.querySelector(`ul[data-date="${date}"]`)
        : null;

      if (!dateHeader) {
        dateHeader = document.createElement("h3");
        dateHeader.setAttribute("data-date", date);
        dateHeader.style.display = "flex";
        dateHeader.style.justifyContent = "space-between";
        dateHeader.style.alignItems = "center";
        dateHeader.style.backgroundColor = "#f0f0f0";
        dateHeader.style.padding = "10px";
        dateHeader.style.borderRadius = "5px";

        const dateText = document.createElement("span");
        dateText.textContent = new Date(date).toLocaleDateString("en-US", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
        dateHeader.appendChild(dateText);
        resultsDiv.appendChild(dateHeader);
      }

      if (!flightList) {
        flightList = document.createElement("ul");
        flightList.setAttribute("data-date", date);
        flightList.style.listStyleType = "none";
        flightList.style.padding = "0";
        resultsDiv.appendChild(flightList);
      }

      const flightsToProcess = append ? [flights[flights.length - 1]] : flights;

      for (const flight of flightsToProcess) {
        const flightItem = document.createElement("li");
        flightItem.style.marginBottom = "15px";
        flightItem.style.padding = "10px";
        flightItem.style.border = "1px solid #ddd";
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
        departureDiv.textContent = `✈️ Departure: ${flight.departure}`;

        const arrivalDiv = document.createElement("div");
        arrivalDiv.textContent = `🛬 Arrival: ${flight.arrival}`;

        const durationDiv = document.createElement("div");
        durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;

        detailsDiv.appendChild(departureDiv);
        detailsDiv.appendChild(arrivalDiv);
        detailsDiv.appendChild(durationDiv);

        flightItem.appendChild(routeDiv);
        flightItem.appendChild(detailsDiv);

        const searchType = document.querySelector('input[name="searchType"]:checked').value;

        if (searchType !== "arrive") {
          const findReturnButton = document.createElement("button");
          findReturnButton.textContent = "Find Return";
          findReturnButton.style.width = "100px";
          findReturnButton.classList.add(
            "button",
            "is-small",
            "is-primary",
            "mt-2",
            "has-text-white",
            "has-text-weight-bold",
            "is-size-7"
          );
          findReturnButton.addEventListener("click", () => {
            flight.element = flightItem;
            findReturnFlight(flight);
            findReturnButton.remove();
          });
          flightItem.appendChild(findReturnButton);
        }

        flightList.appendChild(flightItem);
        flight.element = flightItem;
      }
    }
  }
}

async function findReturnFlight(outboundFlight) {
  const origin = outboundFlight.route.split(" to ")[1].split(" (")[0];
  const destination = outboundFlight.route.split(" to ")[0].split(" (")[0];
  const outboundDate = new Date(outboundFlight.date);
  const outboundArrivalTime = outboundFlight.arrival.split(" (")[0];

  const returnDates = [];
  for (let i = 0; i < 4; i++) {
    const date = new Date(outboundDate);
    date.setDate(outboundDate.getDate() + i);
    returnDates.push(formatDate(date));
  }

  const returnFlights = [];

  const progressElement = document.createElement("div");
  progressElement.classList.add("return-flight-progress");
  progressElement.style.marginTop = "10px";
  progressElement.style.fontSize = "0.9em";
  progressElement.style.color = "#000";
  outboundFlight.element.appendChild(progressElement);

  let checkedDates = 0;
  const updateProgress = () => {
    progressElement.textContent = `Checking return flights: ${checkedDates} of ${returnDates.length} dates checked...`;
  };

  updateProgress();

  for (const returnDate of returnDates) {
    console.log(`Checking return flights for ${returnDate}`);
    try {
      const flights = await checkRoute(origin, destination, returnDate);
      if (Array.isArray(flights)) {
        const validReturnFlights = flights.filter((flight) => {
          const [flightHours, flightMinutes] = flight.departure
            .split(" (")[0]
            .split(":");
          const flightDate = new Date(returnDate);
          flightDate.setHours(
            parseInt(flightHours, 10),
            parseInt(flightMinutes, 10),
            0,
            0
          );

          const [outboundHours, outboundMinutes] =
            outboundArrivalTime.split(":");
          const outboundArrival = new Date(outboundDate);
          outboundArrival.setHours(
            parseInt(outboundHours, 10),
            parseInt(outboundMinutes, 10),
            0,
            0
          );
          return flightDate > outboundArrival;
        });
        console.log(
          `Found ${validReturnFlights.length} valid return flights for ${returnDate}`
        );
        returnFlights.push(...validReturnFlights);
      } else {
        console.error(`Unexpected response format for ${returnDate}:`, flights);
      }
    } catch (error) {
      console.error(`Error checking return flight for ${returnDate}:`, error);
    }
    checkedDates++;
    updateProgress();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  progressElement.remove();

  console.log(`Total return flights found: ${returnFlights.length}`);
  displayReturnFlights(outboundFlight, returnFlights);

  return returnFlights;
}

function calculateTimeAtDestination(outboundFlight, returnFlight) {
  const outboundArrival = new Date(
    `${outboundFlight.date} ${outboundFlight.arrival.split(" (")[0]}`
  );
  const returnDeparture = new Date(
    `${returnFlight.departureDate} ${returnFlight.departure.split(" (")[0]}`
  );

  const timeDiff = returnDeparture - outboundArrival;
  const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );

  return `${days} days and ${hours} hours`;
}

function displayReturnFlights(outboundFlight, returnFlights) {
  const flightItem = outboundFlight.element;
  if (!flightItem) {
    console.error("Flight item element not found");
    return;
  }

  const existingReturnFlights = flightItem.querySelector(".return-flights");
  if (existingReturnFlights) {
    existingReturnFlights.remove();
  }

  const returnFlightsDiv = document.createElement("div");
  returnFlightsDiv.classList.add("return-flights");
  returnFlightsDiv.style.marginTop = "15px";
  returnFlightsDiv.style.borderTop = "2px solid #ddd";
  returnFlightsDiv.style.paddingTop = "15px";

  const validReturnFlights = returnFlights.filter((flight) => {
    const timeAtDestination = calculateTimeAtDestination(
      outboundFlight,
      flight
    );
    const [days, hours] = timeAtDestination.split(" and ");
    return parseInt(days) > 0 || parseInt(hours) >= 1;
  });

  const header = document.createElement("h4");
  header.textContent = `Return Flights (${validReturnFlights.length} found)`;
  header.style.marginBottom = "15px";
  header.style.fontWeight = "bold";
  returnFlightsDiv.appendChild(header);

  if (validReturnFlights.length === 0) {
    const noFlightsMsg = document.createElement("p");
    noFlightsMsg.textContent =
      "No valid (>1h until return) flights found within the next 3 days.";
    noFlightsMsg.style.fontStyle = "italic";
    returnFlightsDiv.appendChild(noFlightsMsg);
  } else {
    const flightList = document.createElement("ul");
    flightList.style.listStyleType = "none";
    flightList.style.padding = "0";

    validReturnFlights.forEach((flight) => {
      const returnFlightItem = document.createElement("li");
      returnFlightItem.style.marginBottom = "15px";
      returnFlightItem.style.padding = "10px";
      returnFlightItem.style.border = "1px solid #ddd";
      returnFlightItem.style.borderRadius = "5px";

      const routeDiv = document.createElement("div");
      routeDiv.textContent = `${
        flight.departureStationText || flight.departureStation
      } to ${flight.arrivalStationText || flight.arrivalStation} - ${
        flight.flightCode
      }`;
      routeDiv.style.fontWeight = "bold";
      routeDiv.style.marginBottom = "5px";

      const dateDiv = document.createElement("div");
      dateDiv.textContent = `Date: ${new Date(
        flight.departureDate
      ).toLocaleDateString()}`;
      dateDiv.style.fontSize = "0.9rem";
      dateDiv.style.color = "#4a4a4a";
      dateDiv.style.marginBottom = "5px";

      const detailsDiv = document.createElement("div");
      detailsDiv.style.display = "flex";
      detailsDiv.style.justifyContent = "space-between";
      detailsDiv.style.fontSize = "0.9em";

      const departureDiv = document.createElement("div");
      departureDiv.textContent = `✈️ Departure: ${flight.departure} (${
        flight.departureOffsetText || ""
      })`;

      const arrivalDiv = document.createElement("div");
      arrivalDiv.textContent = `🛬 Arrival: ${flight.arrival} (${
        flight.arrivalOffsetText || ""
      })`;

      const durationDiv = document.createElement("div");
      durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;

      const timeAtDestinationDiv = document.createElement("div");
      const timeAtDestination = calculateTimeAtDestination(
        outboundFlight,
        flight
      );
      timeAtDestinationDiv.textContent = `🕒 Time until return: ${timeAtDestination}`;
      timeAtDestinationDiv.style.fontSize = "0.9em";
      timeAtDestinationDiv.style.color = "#4a4a4a";
      timeAtDestinationDiv.style.marginTop = "5px";

      detailsDiv.appendChild(departureDiv);
      detailsDiv.appendChild(arrivalDiv);
      detailsDiv.appendChild(durationDiv);

      returnFlightItem.appendChild(routeDiv);
      returnFlightItem.appendChild(dateDiv);
      returnFlightItem.appendChild(detailsDiv);
      returnFlightItem.appendChild(timeAtDestinationDiv);
      flightList.appendChild(returnFlightItem);
    });

    returnFlightsDiv.appendChild(flightList);
  }

  flightItem.appendChild(returnFlightsDiv);
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");
  const checkFlightsButton = document.getElementById("search-flights");
  const routeListElement = document.querySelector(".route-list");
  const airportInput = document.getElementById("airport-input");
  const audioCheckbox = document.getElementById("play-audio-checkbox");

  audioCheckbox.addEventListener("change", () => {
    const existingPlayer = document.getElementById("background-music");
    if (existingPlayer) {
      existingPlayer.remove();
    }
  });

  const lastAirport = localStorage.getItem("lastAirport");
  if (lastAirport) {
    airportInput.value = lastAirport;
  }

  airportInput.addEventListener("input", () => {
    localStorage.setItem("lastAirport", airportInput.value.toUpperCase());
  });

  if (!routeListElement) {
    console.error("Error: .route-list element not found in the DOM");
  }

  if (checkFlightsButton) {
    console.log("Check Flights button found");
    checkFlightsButton.addEventListener("click", () => {
      console.log("Check Flights button clicked");

      if (audioCheckbox.checked) {
        const existingPlayer = document.getElementById("background-music");
        if (!existingPlayer) {
          const audioPlayer = document.createElement("audio");
          audioPlayer.id = "background-music";
          audioPlayer.controls = true;
          audioPlayer.loop = true;
          audioPlayer.style.position = "fixed";
          audioPlayer.style.bottom = "10px";
          audioPlayer.style.right = "10px";
          audioPlayer.style.transform = "none";
          audioPlayer.style.zIndex = "1000";
          audioPlayer.style.width = "150px";
          audioPlayer.style.height = "30px";
          audioPlayer.controlsList =
            "nodownload noplaybackrate nofullscreen noremoteplayback";
          audioPlayer.style.webkitMediaControls = "play current-time";

          const source = document.createElement("source");
          source.src = "assets/background-music.mp3";
          source.type = "audio/mpeg";

          audioPlayer.appendChild(source);
          document.body.appendChild(audioPlayer);
          audioPlayer.play();
        }
      }

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

  const historyButton = document.createElement("button");
  historyButton.id = "show-history";
  historyButton.textContent = "Search History";
  historyButton.classList.add("button", "is-light", "mb-4");
  if (checkFlightsButton) {
    checkFlightsButton.parentNode.insertBefore(
      historyButton,
      checkFlightsButton.nextSibling
    );
  }
  historyButton.addEventListener("click", showSearchHistory);
});

document.addEventListener("DOMContentLoaded", function () {
  const dateSelect = document.getElementById("date-select");
  const today = new Date();

  for (let i = 0; i < 4; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const option = document.createElement("option");
    option.value = date.toISOString().split("T")[0];
    option.textContent = date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

    dateSelect.appendChild(option);
  }
});
