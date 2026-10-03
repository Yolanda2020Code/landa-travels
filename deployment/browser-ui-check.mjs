#!/usr/bin/env node
/**
 * Anonymous, real-DOM planner smoke run using Chrome's built-in CDP and Node's
 * built-in WebSocket. Run only when backend/UI testing has been authorized:
 *   node deployment/browser-ui-check.mjs --url http://localhost:5000
 *
 * No app state is injected: inputs, buttons, quick replies, and review actions
 * are operated through the rendered DOM. Network evidence intentionally keeps
 * only assistant request timings/statuses, never headers, payloads, or bodies.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CHROME =
  (process.env.CHROME_BIN || "chromium");
const OUTPUT_DIR = path.resolve("deployment/browser-evidence");
const MAX_WAIT_MS = 600_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  const baseUrl =
    (urlIndex >= 0 ? args[urlIndex + 1] : process.env.BROWSER_TEST_URL) ??
    "http://localhost:5000";
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Provide --url with an http(s) URL for the running app.");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, "") };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class CDP {
  nextId = 0;
  pending = new Map();
  listeners = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      const packet = JSON.parse(data);
      if (packet.id && this.pending.has(packet.id)) {
        const { resolve, reject } = this.pending.get(packet.id);
        this.pending.delete(packet.id);
        if (packet.error) reject(new Error(packet.error.message));
        else resolve(packet.result);
        return;
      }
      for (const listener of this.listeners.get(packet.method) ?? []) {
        listener(packet.params);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDP(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitUntil(predicate, description, timeoutMs = MAX_WAIT_MS) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const safeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

async function main() {
  const { baseUrl } = parseArgs();
  const profile = await mkdtemp(path.join(os.tmpdir(), "landa-cdp-profile-"));
  const port = await getFreePort();
  let chrome;
  let cdp;
  const requests = new Map();
  const timings = [];
  const errors = [];
  let gpsTravelContextRequests = 0;
  const startTime = new Date().toISOString();

  try {
    chrome = spawn(
      CHROME,
      [
        "--no-sandbox",
        "--headless=new",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--window-size=1280,1000",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    chrome.once("error", (error) => errors.push(`Chrome spawn: ${error.message}`));

    let version;
    await waitUntil(async () => {
      if (chrome.exitCode !== null) {
        throw new Error(`Chrome exited before CDP startup (${chrome.exitCode}).`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!response.ok) return false;
        version = await response.json();
        return true;
      } catch {
        return false;
      }
    }, "Chrome DevTools endpoint", 20_000);

    const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await targetsResponse.json();
    const page = targets.find((target) => target.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("Chrome page target unavailable.");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on("Network.requestWillBeSent", (event) => {
      if (
        new URL(event.request.url).pathname === "/api/travel-context" &&
        new URL(event.request.url).searchParams.get("locationMode") === "gps"
      ) {
        gpsTravelContextRequests++;
      }
      if (
        event.request.method === "POST" &&
        new URL(event.request.url).pathname === "/api/assistant/message"
      ) {
        requests.set(event.requestId, { startedAt: performance.now() });
      }
    });
    cdp.on("Network.responseReceived", (event) => {
      const request = requests.get(event.requestId);
      if (!request) return;
      request.status = event.response.status;
    });
    cdp.on("Network.loadingFinished", (event) => {
      const request = requests.get(event.requestId);
      if (!request) return;
      timings.push({
        status: request.status ?? null,
        durationMs: Math.round(performance.now() - request.startedAt),
      });
      requests.delete(event.requestId);
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (!requests.has(event.requestId)) return;
      timings.push({
        status: null,
        durationMs: Math.round(
          performance.now() - requests.get(event.requestId).startedAt,
        ),
      });
      requests.delete(event.requestId);
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      errors.push(
        safeText(event.exceptionDetails?.exception?.description ??
          event.exceptionDetails?.text).slice(0, 300),
      );
    });

    await cdp.send("Page.navigate", { url: `${baseUrl}/planner` });
    await waitUntil(
      () =>
        cdp.evaluate(
          `document.readyState === "complete" && Boolean(document.querySelector("textarea"))`,
        ),
      "anonymous planner page",
      60_000,
    );
    const authGate = await cdp.evaluate(
      `({url:location.pathname, signInVisible:[...document.querySelectorAll("a,button")].some(e=>/sign in/i.test(e.innerText||e.getAttribute("aria-label")||"")), title:document.title})`,
    );
    if (authGate.url !== "/planner") {
      throw new Error(`Planner redirected to ${authGate.url}; anonymous flow cannot proceed.`);
    }

    // Wait for and then operate only the visible guided question card. No
    // React internals, app-state hooks, direct API requests, or mocked results.
    const readPanel = () =>
      cdp.evaluate(`(() => {
        const visible = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
        const headings = [...document.querySelectorAll("h4")].filter(visible);
        const guided = /^(Where will you travel from\\?|Where would you like to go\\?|Choose your travel dates|How many travellers are going\\?|What total budget should I work within\\?|How do you prefer to travel\\?|Where would you like to stay\\?|Any accessibility requirements\\?|How important is minimizing carbon impact\\?|What activities would you enjoy\\?|Location preferences|Which approximate city or region\\?|Are you happy with these details\\?)/i;
        const heading = headings.find(e => guided.test((e.innerText||"").trim()) && e.closest(".rounded-2xl") && e.closest(".rounded-2xl").querySelector("button"));
        const panel = heading?.closest(".rounded-2xl");
        return panel ? {
          title: (heading.innerText||"").trim(),
          text: (panel.innerText||"").trim(),
          buttons: [...panel.querySelectorAll("button")].filter(visible).map(b => (b.innerText||b.getAttribute("aria-label")||"").trim())
        } : null;
      })()`);

    const clickPanelButton = async (pattern) =>
      cdp.evaluate(`(() => {
        const visible = e => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
        const guided = /^(Where will you travel from\\?|Where would you like to go\\?|Choose your travel dates|How many travellers are going\\?|What total budget should I work within\\?|How do you prefer to travel\\?|Where would you like to stay\\?|Any accessibility requirements\\?|How important is minimizing carbon impact\\?|What activities would you enjoy\\?|Location preferences|Which approximate city or region\\?|Are you happy with these details\\?)/i;
        const heading = [...document.querySelectorAll("h4")].filter(visible).find(e => guided.test((e.innerText||"").trim()) && e.closest(".rounded-2xl") && e.closest(".rounded-2xl").querySelector("button"));
        const panel = heading?.closest(".rounded-2xl");
        const button = [...(panel?.querySelectorAll("button")||[])].find(b => visible(b) && (${pattern}).test((b.innerText||b.getAttribute("aria-label")||"").trim()));
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`);

    const enterInput = async (selector, value) =>
      cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input || input.disabled) return false;
        input.focus();
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new InputEvent("input", {bubbles:true, inputType:"insertText", data:${JSON.stringify(value)}}));
        input.dispatchEvent(new Event("change", {bubbles:true}));
        return true;
      })()`);

    const choosePlace = async (city) => {
      await waitUntil(
        () =>
          cdp.evaluate(`(() => [...document.querySelectorAll("button")].some(b =>
            (b.innerText||"").includes(${JSON.stringify(city)}) &&
            (b.innerText||"").includes(${JSON.stringify(city === "Berlin" ? "BER" : city === "Paris" ? "PAR" : "LIS")})))()`),
        `${city} place suggestion`,
        5_000,
      );
      const point = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll("button")].find(b =>
          (b.innerText||"").includes(${JSON.stringify(city)}) &&
          (b.innerText||"").includes(${JSON.stringify(city === "Berlin" ? "BER" : city === "Paris" ? "PAR" : "LIS")}));
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
      })()`);
      if (!point) return false;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await delay(100);
      return true;
    };

    const guidedQuestions = [];
    let reviewConfirmedAt = null;
    let cardVisibleAt = null;
    let destinationCorrection = false;
    const stepBudget = 24;
    for (let step = 0; step < stepBudget; step++) {
      const panel = await waitUntil(
        async () => {
          const hasCards = await cdp.evaluate(
            `document.querySelectorAll('[data-testid^="card-recommendation-"]').length > 0`,
          );
          if (hasCards) return { title: "__results__", text: "", buttons: [] };
          const current = await readPanel();
          if (current) return current;
          return false;
        },
        "next guided input or recommendations",
        180_000,
      );

      if (panel.title === "__results__") {
        cardVisibleAt = performance.now();
        break;
      }

      if (!/happy with these details/i.test(panel.title)) {
        guidedQuestions.push(panel.title);
      }
      if (/where will you travel from/i.test(panel.title)) {
        if (!(await enterInput("#place-origin", "Berlin"))) throw new Error("Origin field unavailable.");
        await choosePlace("Berlin");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Origin Continue unavailable.");
      } else if (/where would you like to go/i.test(panel.title)) {
        const city = destinationCorrection ? "Lisbon" : "Paris";
        if (!(await enterInput("#place-destination", city))) throw new Error("Destination field unavailable.");
        await choosePlace(city);
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Destination Continue unavailable.");
      } else if (/choose your travel dates/i.test(panel.title)) {
        if (!(await enterInput("#departure-date", "2026-10-15"))) throw new Error("Departure field unavailable.");
        if (!(await enterInput("#return-date", "2026-10-19"))) throw new Error("Return field unavailable.");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Dates Continue unavailable.");
      } else if (/how many travellers/i.test(panel.title)) {
        const control = await cdp.evaluate(`(() => {
          const button = [...document.querySelectorAll('button[aria-label="Increase Adults"]')].find(b => b.offsetWidth || b.offsetHeight || b.getClientRects().length);
          if (!button) return {foundButton:false};
          if (button.disabled) return {foundButton:true,disabled:true};
          button.click(); return {foundButton:true,disabled:false};
        })()`);
        if (!control.foundButton || control.disabled) {
          throw new Error(`Adult stepper was not available: ${JSON.stringify({control, panel})}`);
        }
        await waitUntil(
          () => cdp.evaluate(`(() => {
            const decrease = [...document.querySelectorAll('button[aria-label="Decrease Adults"]')].find(b => b.offsetWidth || b.offsetHeight || b.getClientRects().length);
            return Boolean(decrease && !decrease.disabled);
          })()`),
          "two-adult stepper value",
          5_000,
        ).catch(async (error) => {
          throw new Error(`${error.message} Current step: ${JSON.stringify(await readPanel())}`);
        });
        if (!(await clickPanelButton("/^Continue$/"))) {
          throw new Error(`Traveller Continue button unavailable: ${JSON.stringify(await readPanel())}`);
        }
      } else if (/total budget/i.test(panel.title)) {
        await clickPanelButton("/^Under €1,000$/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Budget Continue unavailable.");
      } else if (/prefer to travel/i.test(panel.title)) {
        await clickPanelButton("/^Train/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Transport Continue unavailable.");
      } else if (/where would you like to stay/i.test(panel.title)) {
        await clickPanelButton("/^Eco-certified Hotel/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Accommodation Continue unavailable.");
      } else if (/accessibility requirements/i.test(panel.title)) {
        await clickPanelButton("/^No specific needs/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Accessibility Continue unavailable.");
      } else if (/minimizing carbon impact/i.test(panel.title)) {
        await clickPanelButton("/^Balanced/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Sustainability Continue unavailable.");
      } else if (/activities would you enjoy/i.test(panel.title)) {
        await clickPanelButton("/^Cultural experiences/");
        if (!(await clickPanelButton("/^Continue$/"))) throw new Error("Activities Continue unavailable.");
      } else if (/location preferences/i.test(panel.title)) {
        await clickPanelButton("/^Enter an approximate city$/");
      } else if (/approximate city or region/i.test(panel.title)) {
        if (!(await enterInput("#place-approximate-city-or-region", "Berlin"))) {
          throw new Error("Manual approximate-city field unavailable.");
        }
        await choosePlace("Berlin");
        if (!(await clickPanelButton("/^Continue with approximate city$/"))) {
          throw new Error("Manual location Continue unavailable.");
        }
      } else if (/happy with these details/i.test(panel.title)) {
        reviewConfirmedAt = performance.now();
        if (!(await clickPanelButton("/^Yes, show my results$/"))) throw new Error("Review confirmation unavailable.");
      } else {
        throw new Error(`Unrecognized guided step: ${panel.title}`);
      }

      await delay(350);
      const current = await readPanel();
      if (current?.title === panel.title) {
        const pending = await cdp.evaluate(
          `document.querySelector('[aria-busy="true"]') !== null`,
        );
        if (pending) {
          await waitUntil(
            () => cdp.evaluate(`document.querySelector('[aria-busy="true"]') === null`),
            "assistant reply",
            180_000,
          );
        }
      }
      const currentAfter = await readPanel();
      if (reviewConfirmedAt && (await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="card-recommendation-"]').length > 0`,
      ))) {
        cardVisibleAt = performance.now();
        break;
      }
      // The correction phase is intentionally started only after the real
      // recommendations are visible; the first results/timing are retained.
      if (!destinationCorrection && cardVisibleAt) destinationCorrection = true;
      if (currentAfter?.title === "__results__") {
        cardVisibleAt = performance.now();
        break;
      }
    }

    if (!cardVisibleAt) {
      cardVisibleAt = performance.now();
      if (!(await cdp.evaluate(
        `document.querySelectorAll('[data-testid^="card-recommendation-"]').length > 0`,
      ))) throw new Error("Recommendations did not become visible.");
    }

    await delay(500);
    const planningRequestCount = timings.length;
    if (guidedQuestions.length !== 12) {
      throw new Error(
        `Expected 12 genuine guided UI questions; observed ${guidedQuestions.length}.`,
      );
    }
    // The real flow has one greeting request before the 12 guided answers and
    // one user-confirmed review request that returns recommendations.
    const expectedPlanningRequests = guidedQuestions.length + 2;
    if (planningRequestCount !== expectedPlanningRequests) {
      throw new Error(
        `Expected ${expectedPlanningRequests} planning assistant requests for 12 guided questions; observed ${planningRequestCount}.`,
      );
    }
    if (timings.slice(0, planningRequestCount).some((request) => request.status !== 200)) {
      throw new Error("At least one planning assistant request did not return HTTP 200.");
    }
    if (gpsTravelContextRequests !== 0) {
      throw new Error("A GPS nearby-options query occurred despite selecting manual location.");
    }

    // Verify rendered card count and visible trip summary before one mobile
    // viewport/a11y/overflow pass. Results themselves are never fabricated.
    const desktopEvidence = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid^="card-recommendation-"]')];
      const summary = [...document.querySelectorAll("h3")].find(e => (e.innerText||"").trim()==="Trip Summary")?.parentElement?.parentElement;
      return {
        recommendationCards: cards.length,
        visibleCardNames: cards.map(card => (card.querySelector("h3")?.innerText||"").trim()).filter(Boolean),
        summaryText: (summary?.innerText||"").trim(),
        displayedTripText: document.body.innerText.includes("Berlin") && document.body.innerText.includes("Paris"),
        summaryValues: {
          initialRoute: (summary?.innerText||"").includes("Paris") && (summary?.innerText||"").includes("Berlin"),
          dates: (summary?.innerText||"").includes("2026-10-15") && (summary?.innerText||"").includes("2026-10-19"),
          travellers: /2 total/.test(summary?.innerText||""),
          budget: (summary?.innerText||"").includes("Under €1,000"),
          rail: /rail|Train/i.test(summary?.innerText||""),
          hotel: /eco-hotel|Eco-certified Hotel/i.test(summary?.innerText||""),
          accessibility: /No specific needs|none/i.test(summary?.innerText||""),
          activity: /cultural/i.test(summary?.innerText||""),
          sustainability: /balanced/i.test(summary?.innerText||""),
          manualBerlin: /Approximate city: Berlin/i.test(summary?.innerText||"")
        }
      };
    })()`);
    if (desktopEvidence.recommendationCards < 1) {
      throw new Error("No actual recommendation cards were rendered.");
    }
    if (Object.values(desktopEvidence.summaryValues).some((value) => !value)) {
      throw new Error(
        `Trip summary did not match the guided scenario: ${JSON.stringify(desktopEvidence.summaryValues)}`,
      );
    }
    const resultScreenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    const mobileEvidence = await cdp.evaluate(`(() => {
      const track = document.querySelector(".stay-carousel-track");
      const active = document.activeElement;
      return {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        tabFocus: active ? { tag: active.tagName, role: active.getAttribute("role"), label: active.getAttribute("aria-label") || active.innerText?.trim().slice(0,80) || "" } : null,
        stayCarousel: track ? { clientWidth: track.clientWidth, scrollWidth: track.scrollWidth, horizontallyScrollable: track.scrollWidth > track.clientWidth } : null
      };
    })()`);
    const mobileResultScreenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Exercise route correction through the visible Trip Summary control, then
    // ensure previously entered dates/preferences remain present in that UI.
    const editRoute = await cdp.evaluate(`(() => {
      const summary = [...document.querySelectorAll("button")].find(e => (e.innerText||"").includes("Route") && (e.innerText||"").includes("Berlin"));
      if (!summary) return false;
      summary.click(); return true;
    })()`);
    if (editRoute) {
      destinationCorrection = true;
      await waitUntil(
        async () => {
          const panel = await readPanel();
          return panel && /where will you travel from/i.test(panel.title) ? panel : false;
        },
        "route edit origin question",
        15_000,
      );
      if (!(await enterInput("#place-origin", "Berlin"))) throw new Error("Edited origin field unavailable.");
      await choosePlace("Berlin");
      await clickPanelButton("/^Continue$/");
      await waitUntil(
        async () => {
          const panel = await readPanel();
          return panel && /where would you like to go/i.test(panel.title) ? panel : false;
        },
        "route edit destination question",
        180_000,
      );
      if (!(await enterInput("#place-destination", "Lisbon"))) throw new Error("Edited destination field unavailable.");
      await choosePlace("Lisbon");
      await clickPanelButton("/^Continue$/");
      const preserved = await waitUntil(
        async () => {
          const state = await cdp.evaluate(`(() => {
            const text = document.body.innerText;
            return {
              dates: text.includes("2026-10-15") && text.includes("2026-10-19"),
              travellers: /2 total/.test(text),
              budget: text.includes("Under €1,000"),
              rail: /Train|rail/i.test(text),
              hotel: /eco-hotel|Eco-certified Hotel/i.test(text),
              activity: /cultural/i.test(text),
              sustainability: /balanced/i.test(text),
              destination: text.includes("Lisbon")
            };
          })()`);
          return Object.values(state).every(Boolean) ? state : false;
        },
        "corrected route and retained planner choices",
        180_000,
      );
      if (Object.values(preserved).some((value) => !value)) {
        throw new Error(`Route correction did not preserve all expected choices: ${JSON.stringify(preserved)}`);
      }
      desktopEvidence.routeCorrection = preserved;
      const guestDraftEvidence = await cdp.evaluate(`(() => {
        const draft = localStorage.getItem("landa-planner-draft:guest") || "";
        return {
          guestDraftPresent: Boolean(draft),
          containsMockGpsCoordinates: /52\\.52|13\\.40/.test(draft),
          containsGpsConsentMode: /"locationConsentMode"\\s*:\\s*"gps"/.test(draft),
          manualCityPersisted: /"currentLocation"\\s*:\\s*"Berlin/.test(draft),
          noGpsNearbyRefetchAfterManualLocation: ${gpsTravelContextRequests === 0}
        };
      })()`);
      if (
        guestDraftEvidence.containsMockGpsCoordinates ||
        guestDraftEvidence.containsGpsConsentMode
      ) {
        throw new Error("Guest draft storage did not preserve manual-only location privacy.");
      }
      desktopEvidence.locationPrivacy = guestDraftEvidence;
    } else {
      desktopEvidence.routeCorrection = { skipped: "Route summary control not visible." };
      desktopEvidence.locationPrivacy = {
        noGpsNearbyRefetchAfterManualLocation: gpsTravelContextRequests === 0,
      };
    }

    // Anonymous handover UI is inspected but never submitted. No auth/signup
    // flow or email is entered, and no success state is synthesized.
    const advisorGate = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="button-speak-to-advisor"]');
      if (!button) return { visible:false };
      button.click();
      return { visible:true };
    })()`);
    if (advisorGate.visible) {
      await delay(200);
      desktopEvidence.advisorGate = await cdp.evaluate(`(() => ({
        signInRequirement: [...document.querySelectorAll("p")].some(p => /sign in and wait until this trip is saved/i.test(p.innerText||"")),
        submitDisabled: document.querySelector('[data-testid="button-submit-advisor-handover"]')?.disabled ?? null,
        consentAvailable: Boolean(document.querySelector('[data-testid="checkbox-share-transcript-consent"]'))
      }))()`);
    }

    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await mkdir(OUTPUT_DIR, { recursive: true });
    const screenshotPath = path.join(OUTPUT_DIR, "anonymous-planner.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const resultsScreenshotPath = path.join(OUTPUT_DIR, "anonymous-recommendations.png");
    await writeFile(
      resultsScreenshotPath,
      Buffer.from(resultScreenshot.data, "base64"),
    );
    const mobileScreenshotPath = path.join(OUTPUT_DIR, "anonymous-mobile-results.png");
    await writeFile(
      mobileScreenshotPath,
      Buffer.from(mobileResultScreenshot.data, "base64"),
    );

    const evidence = {
      runStartedAt: startTime,
      baseUrl,
      browser: { userAgent: version?.Browser ?? "Chrome", isolatedAnonymousProfile: true },
      authentication: { anonymousPlannerLoaded: true, signInLinkInitiallyVisible: authGate.signInVisible },
      scenario: {
        routeInitially: "Berlin to Paris",
        dates: ["2026-10-15", "2026-10-19"],
        adults: 2,
        budget: "Under €1,000",
        transport: "Train",
        accommodation: "Eco-certified Hotel",
        accessibility: "No specific needs",
        sustainability: "Balanced",
        activity: "Cultural experiences",
        approximateCity: "Berlin",
        locationMode: "manual",
      },
      visibleGuidedQuestions: guidedQuestions,
      assistantRequests: timings,
      assistantRequestCount: timings.length,
      planningAssistantRequestCount: planningRequestCount,
      expectedPlanningAssistantRequestCount: expectedPlanningRequests,
      guidedQuestionCount: guidedQuestions.length,
      gpsTravelContextRequestCount: gpsTravelContextRequests,
      visibleRecommendationCount: desktopEvidence.recommendationCards,
      visibleRecommendationNames: desktopEvidence.visibleCardNames,
      confirmationToCardsMs:
        reviewConfirmedAt !== null && cardVisibleAt !== null
          ? Math.round(cardVisibleAt - reviewConfirmedAt)
          : null,
      rendered: desktopEvidence,
      mobile: mobileEvidence,
      browserErrors: errors,
      screenshot: path.relative(process.cwd(), screenshotPath),
      recommendationScreenshot: path.relative(process.cwd(), resultsScreenshotPath),
      mobileRecommendationScreenshot: path.relative(process.cwd(), mobileScreenshotPath),
      privacy: {
        authCookiesRead: false,
        authHeadersOrTokensRead: false,
        requestBodiesStored: false,
        realGpsUsed: false,
        personalEmailEntered: false,
      },
    };
    await writeFile(
      path.join(OUTPUT_DIR, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence, null, 2));
    if (mobileEvidence.horizontalOverflow) {
      throw new Error("The 390px mobile planner has horizontal document overflow.");
    }
    if (!mobileEvidence.stayCarousel?.clientWidth) {
      throw new Error("The mobile hotel carousel did not receive a measurable layout.");
    }
    if (
      desktopEvidence.advisorGate &&
      (!desktopEvidence.advisorGate.signInRequirement ||
        desktopEvidence.advisorGate.submitDisabled !== true)
    ) {
      throw new Error("Anonymous advisor handover was not correctly gated.");
    }
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => chrome.once("exit", resolve)),
        delay(3_000),
      ]);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
    }
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Anonymous browser check failed: ${error.message}`);
  process.exitCode = 1;
});