import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { TripContext } from "@workspace/api-zod";
import { flightConvenience, getLiveTravelRecommendations } from "./live-travel-providers";

const SECRET_DUFFEL = "duffel-test-secret";
const SECRET_CLIMATIQ = "climatiq-test-secret";

const context: TripContext = {
  origin: "Berlin",
  destination: "Lisbon",
  currentLocation: null,
  stopovers: [],
  dateRange: "2030-06-10 to 2030-06-14",
  travellerCount: 2,
  budget: "Flexible",
  transportPreferences: ["flight"],
  accessibilityNeeds: ["none"],
  sustainabilityPriority: "balanced",
  accommodationNeeds: ["hotel"],
  locationConsentMode: "skipped",
  reviewConfirmation: true,
  handoverRequested: false,
};

const originalFetch = globalThis.fetch;
const originalDuffel = process.env.DUFFEL_ACCESS_TOKEN;
const originalClimatiq = process.env.CLIMATIQ_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDuffel === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
  else process.env.DUFFEL_ACCESS_TOKEN = originalDuffel;
  if (originalClimatiq === undefined) delete process.env.CLIMATIQ_API_KEY;
  else process.env.CLIMATIQ_API_KEY = originalClimatiq;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function place(name: string, code: string, country: string, latitude: number, longitude: number) {
  return {
    data: [{
      type: "city",
      name,
      iata_code: code,
      iata_country_code: country,
      geographic_coordinates: { latitude, longitude },
    }],
  };
}

test("uses only complete provider slice timings and connection counts for convenience", () => {
  assert.deepEqual(flightConvenience({ slices: [
    { duration: "PT2H30M", segments: [{}, {}] },
    { duration: "PT2H15M", segments: [{}] },
  ] }), { durationMinutes: 285, connectionCount: 1 });
  assert.deepEqual(flightConvenience({ slices: [{ duration: "unknown", segments: [] }] }), {});
  assert.deepEqual(flightConvenience({ slices: [
    { duration: "PT2H", segments: [{}] }, { segments: [{}] },
  ] }), { connectionCount: 0 });
  assert.deepEqual(flightConvenience({ slices: [] }), {});
});

test("returns a clear demo result without provider secrets", async () => {
  delete process.env.DUFFEL_ACCESS_TOKEN;
  delete process.env.CLIMATIQ_API_KEY;
  const result = await getLiveTravelRecommendations(context);
  assert.equal(result.source, "demo");
  assert.deepEqual(result.recommendations, []);
  assert.match(result.notice, /credentials/i);
});

test("normalizes valid Duffel test flight offers with Climatiq emissions", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${url.includes("climatiq") ? SECRET_CLIMATIQ : SECRET_DUFFEL}`);
    if (url.includes("/places/suggestions")) {
      return json(url.includes("Berlin") ? place("Berlin", "BER", "DE", 52.52, 13.4) : place("Lisbon", "LIS", "PT", 38.72, -9.14));
    }
    if (url.includes("/air/offer_requests")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.data.cabin_class, "economy");
      assert.equal(body.data.return_offers, false);
      assert.equal(body.data.max_connections, 0);
      assert.equal(body.data.passengers.length, 2);
      assert.equal(body.data.slices.length, 2);
      assert.equal(body.data.slices[1].origin, "LIS");
      assert.equal(body.data.slices[1].destination, "BER");
      return json({ data: { offers: [{ id: "off_123", total_amount: "118.00", total_currency: "EUR", owner: { name: "Test Airways" } }] } });
    }
    if (url.includes("/data/v1/estimate")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.parameters.passengers, 2);
      assert.equal(body.parameters.distance_unit, "km");
      assert.equal(body.emission_factor.data_version, "37");
      return json({ co2e: 410, co2e_unit: "kg" });
    }
    if (url.includes("/stays/search")) return json({ data: { results: [] } });
    return json({}, 404);
  };

  const result = await getLiveTravelRecommendations(context);
  assert.equal(result.source, "live");
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0]?.carbonKg, 820);
  assert.match(result.recommendations[0]?.source ?? "", /TEST MODE/);
  assert.match(result.notice, /not bookings/i);
});

test("rejects malformed provider shapes instead of inventing a recommendation", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/places/suggestions")) return json({ data: [{ type: "city", name: "Berlin" }] });
    return json({ data: { offers: [{ id: "missing-carbon-and-price" }] } });
  };
  const result = await getLiveTravelRecommendations(context);
  assert.equal(result.source, "demo");
  assert.deepEqual(result.recommendations, []);
  assert.match(result.notice, /resolve|validation|estimated carbon|live offer/i);
});

test("handles provider outage without throwing or exposing credentials", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async () => {
    throw new Error("upstream outage");
  };
  const result = await getLiveTravelRecommendations(context);
  const serialized = JSON.stringify(result);
  assert.equal(result.source, "demo");
  assert.deepEqual(result.recommendations, []);
  assert.match(result.notice, /unavailable|resolve|offer|live/i);
  assert.equal(serialized.includes(SECRET_DUFFEL), false);
  assert.equal(serialized.includes(SECRET_CLIMATIQ), false);
});

test("does not leak tokens in successful responses", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/places/suggestions")) return json(place("Berlin", "BER", "DE", 52.52, 13.4));
    if (url.includes("/air/offer_requests")) return json({ data: { offers: [] } });
    if (url.includes("/stays/search")) return json({ data: { results: [] } });
    return json({ co2e: 100, co2e_unit: "kg" });
  };
  const result = await getLiveTravelRecommendations(context);
  assert.equal(JSON.stringify(result).includes(SECRET_DUFFEL), false);
  assert.equal(JSON.stringify(result).includes(SECRET_CLIMATIQ), false);
});

test("does not search stays if traveller requested no accommodation", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/places/suggestions")) {
      return json(url.includes("Berlin") ? place("Berlin", "BER", "DE", 52.52, 13.4) : place("Lisbon", "LIS", "PT", 38.72, -9.14));
    }
    if (url.includes("/stays/search")) throw new Error("Stays must not be queried");
    if (url.includes("/air/offer_requests")) return json({ data: { offers: [] } });
    return json({}, 404);
  };
  const result = await getLiveTravelRecommendations({ ...context, accommodationNeeds: ["none"] });
  assert.deepEqual(result.recommendations, []);
});

test("fetches a bounded offer page when Duffel omits inline offers", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  let pages = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/places/suggestions")) {
      return json(url.includes("Berlin") ? place("Berlin", "BER", "DE", 52.52, 13.4) : place("Lisbon", "LIS", "PT", 38.72, -9.14));
    }
    if (url.includes("/air/offer_requests")) return json({ data: { id: "or_123", offers: [] } });
    if (url.includes("/air/offers?")) {
      pages++;
      assert.match(url, /offer_request_id=or_123&limit=3/);
      return json({ data: [{ id: "off_abc", total_amount: "85.00", total_currency: "EUR", owner: { name: "Test Airways" } }] });
    }
    if (url.includes("/data/v1/estimate")) return json({ co2e: 50, co2e_unit: "kg" });
    return json({}, 404);
  };
  const result = await getLiveTravelRecommendations({ ...context, accommodationNeeds: ["none"] });
  assert.equal(pages, 1);
  assert.equal(result.recommendations[0]?.price, "EUR 85.00");
  assert.equal(result.recommendations[0]?.carbonKg, 100);
});

test("starts route emissions estimates in parallel with flight offer retrieval", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  let carbonStarted = false;
  let notifyCarbonStarted!: () => void;
  const carbonStartedSignal = new Promise<void>((resolve) => { notifyCarbonStarted = resolve; });
  let offerSearchOverlappedCarbon = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/places/suggestions")) {
      return json(url.includes("Berlin") ? place("Berlin", "BER", "DE", 52.52, 13.4) : place("Lisbon", "LIS", "PT", 38.72, -9.14));
    }
    if (url.includes("/air/offer_requests")) {
      await Promise.race([
        carbonStartedSignal,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
      offerSearchOverlappedCarbon = carbonStarted;
      return json({ data: { offers: [] } });
    }
    if (url.includes("/data/v1/estimate")) {
      carbonStarted = true;
      notifyCarbonStarted();
      return json({ co2e: 100, co2e_unit: "kg" });
    }
    return json({}, 404);
  };

  const result = await getLiveTravelRecommendations({ ...context, accommodationNeeds: ["none"] });
  assert.equal(offerSearchOverlappedCarbon, true);
  assert.deepEqual(result.recommendations, []);
});

test("provider deadline aborts pending reads and explicitly discloses that no live data was validated", async () => {
  process.env.DUFFEL_ACCESS_TOKEN = SECRET_DUFFEL;
  process.env.CLIMATIQ_API_KEY = SECRET_CLIMATIQ;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("Provider requests must be abortable"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Aborted by response budget")), { once: true });
  });

  const startedAt = performance.now();
  const result = await getLiveTravelRecommendations(context);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 2_300, `provider deadline should resolve near 1.7s, got ${elapsedMs.toFixed(0)}ms`);
  assert.deepEqual(result.recommendations, []);
  assert.match(result.notice, /1\.7-second response budget/i);
});