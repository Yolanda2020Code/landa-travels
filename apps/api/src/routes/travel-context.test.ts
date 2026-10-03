import assert from "node:assert/strict";
import test from "node:test";
import { GetTravelContextResponse } from "@workspace/api-zod";
import travelContextRouter, { getWikipediaStatus } from "./travel-context";

type ResponseStub = {
  statusCode: number;
  body: unknown;
  status: (code: number) => ResponseStub;
  json: (body: unknown) => ResponseStub;
};

function response(): ResponseStub {
  const output = { statusCode: 200, body: undefined as unknown };
  const result = {
    get statusCode() { return output.statusCode; },
    get body() { return output.body; },
    status(code: number) { output.statusCode = code; return result; },
    json(body: unknown) { output.body = body; return result; },
  };
  return result;
}

function travelContextHandler() {
  const routeLayer = (travelContextRouter as any).stack.find(
    (item: any) => item.route?.path === "/travel-context" && item.route.methods.get,
  );
  assert.ok(routeLayer, "GET /travel-context exists");
  return routeLayer.route.stack.at(-1).handle;
}

test("returns an explicit map cache miss and still resolves the requested EUR exchange context", async () => {
  const previousFetch = globalThis.fetch;
  let requestedFx = false;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /^https:\/\/api\.frankfurter\.dev\/v1\/latest\?/);
    requestedFx = true;
    return new Response(JSON.stringify({
      base: "EUR",
      date: "2031-03-31",
      rates: { GBP: 0.85 },
    }), { status: 200 });
  };
  try {
    const res = response();
    await travelContextHandler()({
      query: { destination: "route-test-no-map-cache-79f2", currency: "GBP" },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(requestedFx, true);
    const body = res.body as {
      destination: string;
      map: {
        status: string;
        checkedAt: Date | null;
        wikipediaStatus: string;
        hotels: unknown[];
        transit: unknown[];
        attractions: unknown[];
      };
      transitFeed: { status: string; checkedAt: string | null; departures: unknown[]; notice: string };
      culturalEvents: { status: string; checkedAt: string | null; events: unknown[]; notice: string };
      certifiedStays: { status: string; checkedAt: string | null; stays: unknown[]; notice: string };
      nearbyContext: { status: string; mode: string; hotels: unknown[]; notice: string };
      offsetProgrammes: { status: string; checkedAt: null; programmes: unknown[]; notice: string };
      exchange: { status: string; base: string; target: string; rate: number | null };
      weather: { status: string; current: unknown; travelAdvice: string };
    };
    assert.equal(body.destination, "route-test-no-map-cache-79f2");
    assert.deepEqual(body.map, {
      status: "cache-miss",
      checkedAt: null,
      attribution: "© OpenStreetMap contributors",
      wikipediaStatus: "no-map",
      hotels: [],
      transit: [],
      attractions: [],
    });
    assert.equal(body.transitFeed.status, "not-covered");
    assert.equal(body.transitFeed.checkedAt, null);
    assert.deepEqual(body.transitFeed.departures, []);
    assert.match(body.transitFeed.notice, /OpenStreetMap stops are location references only/);
    assert.equal(body.culturalEvents.status, "not-covered");
    assert.equal(body.culturalEvents.checkedAt, null);
    assert.deepEqual(body.culturalEvents.events, []);
    assert.match(body.culturalEvents.notice, /not current event listings/);
    assert.equal(body.certifiedStays.status, "not-covered");
    assert.equal(body.certifiedStays.checkedAt, null);
    assert.deepEqual(body.certifiedStays.stays, []);
    assert.match(body.certifiedStays.notice, /not covered/);
    assert.equal(body.nearbyContext.status, "skipped");
    assert.equal(body.nearbyContext.mode, "skip");
    assert.deepEqual(body.nearbyContext.hotels, []);
    assert.match(body.nearbyContext.notice, /No device location was requested/);
    assert.equal(body.offsetProgrammes.status, "curated-demo");
    assert.equal(body.offsetProgrammes.checkedAt, null);
    assert.equal(body.offsetProgrammes.programmes.length, 3);
    assert.match(body.offsetProgrammes.notice, /not live offers/);
    assert.equal(body.exchange.status, "available");
    assert.equal(body.exchange.base, "EUR");
    assert.equal(body.exchange.target, "GBP");
    assert.equal(body.exchange.rate, 0.85);
    assert.equal(body.weather.status, "unavailable");
    assert.equal(body.weather.current, null);
    assert.match(body.weather.travelAdvice, /unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("classifies Wikipedia lookup status without implying every attraction has an article", () => {
  assert.equal(getWikipediaStatus(false, 0, 0), "no-map");
  assert.equal(getWikipediaStatus(true, 0, 0), "no-english-tag");
  assert.equal(getWikipediaStatus(true, 2, 0), "lookup-unavailable");
  assert.equal(getWikipediaStatus(true, 2, 1), "available");
});

test("preserves date-only weather and exchange values through response validation and JSON serialization", () => {
  const response = GetTravelContextResponse.parse({
    destination: "Test destination",
    map: {
      status: "cache-miss",
      checkedAt: null,
      attribution: "© OpenStreetMap contributors",
      wikipediaStatus: "no-map",
      hotels: [],
      transit: [],
      attractions: [],
    },
    weather: {
      status: "available",
      source: "Open-Meteo",
      date: "2026-09-29",
      current: null,
      outlook: [{
        date: "2026-09-30",
        temperatureMaxC: 18,
        temperatureMinC: 11,
        precipitationMm: 0,
        weatherCode: 1,
      }],
      travelAdvice: "Check the forecast before departure.",
      travelDates: null,
      forecastAppliesToTravelDates: false,
      notice: "Sample provider-result shape for schema serialization test.",
    },
    exchange: {
      status: "available",
      base: "EUR",
      target: "GBP",
      rate: 0.85,
      date: "2026-09-29",
      source: "Frankfurter",
    },
    transitFeed: {
      status: "not-covered",
      checkedAt: null,
      source: null,
      sourceUrl: null,
      attribution: null,
      departures: [],
      notice: "No verified public feed is integrated.",
    },
    culturalEvents: {
      status: "not-covered",
      checkedAt: null,
      source: null,
      sourceUrl: null,
      attribution: null,
      events: [],
      notice: "No verified events feed is integrated.",
    },
    certifiedStays: {
      status: "available",
      checkedAt: "2026-09-29T12:00:00.000Z",
      source: "EU Ecolabel — European Commission",
      sourceUrl: "https://environment.ec.europa.eu/app/ecolabel-product-catalogue",
      attribution: "European Commission, EU Ecolabel; normalized subset.",
      notice: "Registry evidence only.",
      stays: [{
        id: "eu-ecolabel-FR/051/103",
        name: "Solar Hotel",
        city: "PARIS",
        country: "France",
        address: "22 rue Boulard",
        certificationEvidence: {
          scheme: "EU Ecolabel",
          licenceNumber: "FR/051/103",
          validUntil: "2027-12-31",
          checkedAt: "2026-09-29T12:00:00.000Z",
          registryUrl: "https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/services?licence_number=FR%2F051%2F103",
          hotelUrl: null,
          address: "22 rue Boulard",
        },
      }],
    },
    nearbyContext: {
      status: "skipped",
      mode: "skip",
      label: null,
      checkedAt: null,
      stale: false,
      attribution: null,
      hotels: [],
      transit: [],
      attractions: [],
      notice: "Location tailoring was skipped. No device location was requested.",
    },
    offsetProgrammes: {
      status: "curated-demo",
      source: "Curated static programme directories",
      checkedAt: null,
      notice: "Curated directory references only; these are not live offers or a claim that offsets neutralise travel emissions.",
      programmes: [{
        id: "gold-standard-marketplace",
        name: "Gold Standard Marketplace",
        organization: "Gold Standard",
        sourceUrl: "https://marketplace.goldstandard.org/collections/projects",
        evidenceType: "official programme directory",
        checkedAt: null,
        limitations: "No project, price, quantity, or availability was checked.",
      }],
    },
  });
  const serialized = JSON.parse(JSON.stringify(response)) as {
    weather: { date: string; outlook: Array<{ date: string }> };
    exchange: { date: string };
  };
  assert.equal(serialized.weather.date, "2026-09-29");
  assert.equal(serialized.weather.outlook[0]?.date, "2026-09-30");
  assert.equal(serialized.exchange.date, "2026-09-29");
});

test("rejects missing, oversized, or unsupported query values", async () => {
  let fetches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    return new Response("{}", { status: 200 });
  };
  try {
    for (const query of [
      {},
      { destination: "x".repeat(121) },
      { destination: "Paris", currency: "CAD" },
      { destination: "Paris", travelDates: "x".repeat(81) },
      { destination: "Paris", locationMode: "unknown" },
      { destination: "Paris", locationMode: "gps", locationLat: "48.861", locationLon: "2.35" },
      { destination: "Paris", locationMode: "gps", locationLat: "48.86" },
      { destination: "Paris", locationMode: "skip", locationLat: "48.86", locationLon: "2.35" },
      { destination: "Paris", locationMode: "manual", locationCity: "   " },
    ]) {
      const res = response();
      await travelContextHandler()({ query }, res);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("GPS tailoring uses rounded request coordinates for offline matches without sending or returning them", async () => {
  let outgoingRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    outgoingRequests++;
    return new Response("{}", { status: 200 });
  };
  try {
    const res = response();
    await travelContextHandler()({
      query: {
        destination: "no-map-destination",
        currency: "EUR",
        locationMode: "gps",
        locationLat: "48.86",
        locationLon: "2.35",
      },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(outgoingRequests, 0, "location coordinates must not go to an external provider");
    const body = res.body as {
      nearbyContext: {
        status: string;
        mode: string;
        hotels: Array<{ name: string; distanceKm: number }>;
        transit: Array<{ name: string; distanceKm: number }>;
      };
    };
    assert.equal(body.nearbyContext.status, "available");
    assert.equal(body.nearbyContext.mode, "gps");
    assert.ok(body.nearbyContext.hotels.length > 0);
    assert.ok(body.nearbyContext.transit.length > 0);
    assert.equal(typeof body.nearbyContext.hotels[0]?.distanceKm, "number");
    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /48\.86|2\.35/);
    assert.doesNotMatch(serialized, /"latitude"|"longitude"/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});