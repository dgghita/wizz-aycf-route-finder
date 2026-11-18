console.log("content.js loaded (with checkSession support)");

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "getDestinations") {
    setTimeout(() => {
      const routePattern = /"routes":\[(.*?)\].*?"isOneWayFlightsOnly"/gms;
      const bodyPattern = /window\.CVO\.routes\s*=\s*(\[.*?\]);/s;
      const pageContent = document.head.innerHTML;
      const bodyContent = document.body.innerHTML;
      
      let routesJson;
      let headMatch = pageContent.match(routePattern);
      let bodyMatch = bodyContent.match(bodyPattern);

      if (headMatch && headMatch[0]) {
        routesJson = `{"routes":${headMatch[0].split('"routes":')[1].split(',"isOneWayFlightsOnly"')[0]}}`;
      } else if (bodyMatch && bodyMatch[1]) {
        routesJson = `{"routes":${bodyMatch[1]}}`;
      }

      if (routesJson) {
        try {
          const routesData = JSON.parse(routesJson);
          sendResponse({ success: true, routes: routesData.routes });
        } catch (error) {
          console.error("Error parsing routes data:", error);
          sendResponse({ success: false, error: "Failed to parse routes data" });
        }
      } else {
        sendResponse({ success: false, error: "No routes data found" });
      }
    }, 1000);
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getDynamicUrl") {
    setTimeout(() => {
      const pageContent = document.head.innerHTML;
      const bodyContent = document.body.innerHTML;
      
      const headMatch = pageContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
      const bodyMatch = bodyContent.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);

      if (headMatch && headMatch[1]) {
        const uuid = headMatch[1];
        const dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${uuid}`;
        sendResponse({dynamicUrl: dynamicUrl});
      } else if (bodyMatch && bodyMatch[1]) {
        const dynamicUrl = bodyMatch[1];
        sendResponse({dynamicUrl: dynamicUrl});
      } else {
        console.log('Dynamic URL not found in page content');
        sendResponse({error: "Dynamic URL not found"});
      }
    }, 1000);
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getHeaders") {
    const headers = {};
    performance.getEntriesByType("resource").forEach(entry => {
      if (entry.name.includes("multipass.wizzair.com")) {
        entry.serverTiming.forEach(timing => {
          if (timing.name.startsWith("request_header_")) {
            const headerName = timing.name.replace("request_header_", "");
            headers[headerName] = timing.description;
          }
        });
      }
    });
    sendResponse({headers: headers});
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkSession") {
    const pageContent = document.head.innerHTML + document.body.innerHTML;

    const headMatch = pageContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
    const bodyMatch = pageContent.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);
    let dynamicUrl = null;
    if (headMatch && headMatch[1]) {
      dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${headMatch[1]}`;
    } else if (bodyMatch && bodyMatch[1]) {
      dynamicUrl = bodyMatch[1];
    }
    if (!dynamicUrl) {
      console.error("checkSession: dynamic URL not found in page content");
      sendResponse({error: "Dynamic URL not found"});
      return;
    }

    const headers = {"Content-Type": "application/json"};
    performance.getEntriesByType("resource").forEach(entry => {
      if (entry.name.includes("multipass.wizzair.com")) {
        entry.serverTiming.forEach(timing => {
          if (timing.name.startsWith("request_header_")) {
            headers[timing.name.replace("request_header_", "")] = timing.description;
          }
        });
      }
    });
    console.log("checkSession: probing", dynamicUrl, "with", Object.keys(headers).length, "headers:", Object.keys(headers));

    const probePayload = {
      flightType: "OW",
      origin: "AAA",
      destination: "BBB",
      departure: "2030-01-01",
      arrival: "",
      intervalSubtype: null,
    };

    fetch(dynamicUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(probePayload),
      credentials: "include",
    }).then(response => {
      console.log("checkSession: raw status =", response.status);
      return response.text().then(bodyText => {
        console.log("checkSession: body:", bodyText.slice(0, 300));
        sendResponse({status: response.status, body: bodyText.slice(0, 500)});
      });
    }).catch(error => {
      console.error("Session check failed:", error);
      sendResponse({status: 0, body: String(error)});
    });
    return true;
  }
});
