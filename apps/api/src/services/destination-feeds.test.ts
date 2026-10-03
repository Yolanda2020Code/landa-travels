import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { GetTravelContextResponse } from "@workspace/api-zod";
import { clearDestinationFeedCache, getDestinationFeedContext } from "./destination-feeds";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearDestinationFeedCache();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fixedNow = new Date("2030-06-10T12:00:00.000Z");

test("uses Entur's no-key GraphQL departure board only for the fixed central Oslo reference", async () => {
  let requestedUrl = "";
  let requestHeaders: Headers | undefined;
  let query = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    query = JSON.parse(String(init?.body)).query;
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    return json({
      data: {
        stopPlace: {
          name: "Jernbanetorget",
          estimatedCalls: [
            {
              aimedDepartureTime: "2030-06-10T14:00:00+02:00",
              expectedDepartureTime: "2030-06-10T14:02:00+02:00",
              destinationDisplay: { frontText: "Majorstuen" },
              serviceJourney: { journeyPattern: { line: { publicCode: "1", name: "Line 1" } } },
            },
            {
              aimedDepartureTime: "2030-06-10T14:10:00+02:00",
              expectedDepartureTime: null,
              destinationDisplay: { frontText: "Bergkrystallen" },
              serviceJourney: { journeyPattern: { line: { publicCode: "4", name: "Line 4" } } },
            },
            {
              aimedDepartureTime: "2030-06-10T09:00:00+02:00",
              expectedDepartureTime: null,
              destinationDisplay: { frontText: "Expired departure" },
              serviceJourney: { journeyPattern: { line: { publicCode: "5", name: "Line 5" } } },
            },
          ],
        },
      },
    });
  };

  const { transitFeed, culturalEvents } = await getDestinationFeedContext("Oslo", undefined, fixedNow);
  assert.equal(requestedUrl, "https://api.entur.io/journey-planner/v3/graphql");
  assert.equal(requestHeaders?.get("ET-Client-Name"), "EcoTravelAdvisor-context");
  assert.equal(requestHeaders?.get("Content-Type"), "application/json");
  assert.match(query, /stopPlace\(id: "NSR:StopPlace:58366"\)/);
  assert.match(query, /estimatedCalls\(timeRange: 3600, numberOfDepartures: 3\)/);
  assert.equal(transitFeed.status, "available");
  assert.equal(transitFeed.departures.length, 2);
  assert.equal(transitFeed.departures[0]?.stop, "Jernbanetorget (central Oslo reference)");
  assert.equal(transitFeed.departures[0]?.timing, "real-time");
  assert.equal(transitFeed.departures[1]?.timing, "scheduled");
  assert.match(transitFeed.notice, /not the traveller's nearest stop/);
  assert.ok(transitFeed.checkedAt);
  assert.equal(transitFeed.attribution?.includes("NLOD"), true);
  GetTravelContextResponse.shape.transitFeed.parse(transitFeed);
  assert.equal(culturalEvents.status, "not-covered");
});

test("filters official Paris events by a bounded date window and excludes invalid, expired, unsafe, and virtual-only records", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.ok(init?.signal);
    const url = new URL(requestedUrl);
    assert.equal(url.origin, "https://opendata.paris.fr");
    assert.equal(url.searchParams.get("limit"), "60");
    const where = url.searchParams.get("where") ?? "";
    assert.match(where, /date_start <= '2030-06-14T21:59:59\.999Z'/);
    assert.match(where, /date_end >= '2030-06-09T22:00:00\.000Z'/);
    assert.match(where, /address_city = 'Paris'/);
    assert.match(url.searchParams.get("select") ?? "", /occurrences/);
    return json({
      results: [
        {
          title: "Photo exhibition",
          url: "https://www.paris.fr/evenements/photo-exhibition",
          date_start: "2030-06-10T10:00:00+02:00",
          date_end: "2030-08-01T18:00:00+02:00",
          occurrences: "2030-06-11T14:00:00+02:00_2030-06-11T17:00:00+02:00;2030-06-12T14:00:00+02:00_2030-06-12T17:00:00+02:00",
          address_city: "Paris",
          address_name: "City Gallery",
          qfap_tags: "Exhibition",
          locations: [{
            address_city: "Paris",
            address_street: "10 rue Example",
            address_zipCode: "75001",
            address_name: "City Gallery",
            address_lat_lon: "48.86,2.35",
          }],
        },
        {
          title: "Dated event",
          url: "https://www.paris.fr/evenements/dated-event",
          date_start: "2030-06-13T10:00:00+02:00",
          date_end: "2030-06-13T12:00:00+02:00",
          occurrences: null,
          address_city: "Paris",
          address_name: "Town Hall",
          qfap_tags: null,
          locations: [{
            address_city: "Paris",
            address_street: "2 place Example",
            address_zipCode: "75004",
            address_name: "Town Hall",
            address_lat_lon: "48.85,2.35",
          }],
        },
        {
          title: "Expired",
          url: "https://www.paris.fr/evenements/expired",
          date_start: "2030-06-10T10:00:00+02:00",
          date_end: "2030-06-10T11:00:00+02:00",
          occurrences: "2030-06-10T10:00:00+02:00_2030-06-10T11:00:00+02:00",
          address_city: "Paris",
          address_name: "Past Place",
          locations: [{
            address_city: "Paris",
            address_street: "3 rue Example",
            address_zipCode: "75005",
            address_lat_lon: "48.85,2.35",
          }],
        },
        {
          title: "Virtual only",
          url: "https://www.paris.fr/evenements/virtual-only",
          date_start: "2030-06-12T10:00:00+02:00",
          date_end: "2030-06-12T11:00:00+02:00",
          occurrences: null,
          address_city: "Paris",
          address_name: "Online",
          address_url: "https://example.org/virtual",
          locations: [{
            address_city: "Paris",
            address_name: "Online",
            address_lat_lon: "0.0,0.0",
          }],
        },
        {
          title: "Unsafe source",
          url: "http://attacker.example/event",
          date_start: "2030-06-12T10:00:00+02:00",
          date_end: "2030-06-12T11:00:00+02:00",
          occurrences: null,
          address_city: "Paris",
          address_name: "Physical Venue",
          address_street: "4 rue Example",
          address_zipcode: "75006",
          locations: [{
            address_city: "Paris",
            address_street: "4 rue Example",
            address_zipCode: "75006",
            address_name: "Physical Venue",
            address_lat_lon: "48.85,2.35",
          }],
        },
      ],
    });
  };

  const { culturalEvents, transitFeed } = await getDestinationFeedContext(
    "Paris",
    "2030-06-10 to 2030-06-14",
    fixedNow,
  );
  assert.match(requestedUrl, /^https:\/\/opendata\.paris\.fr\/api\/explore\/v2\.1\/catalog\/datasets\/que-faire-a-paris-\/records\?/);
  assert.equal(culturalEvents.status, "available");
  assert.equal(culturalEvents.events.length, 2);
  assert.deepEqual(culturalEvents.events.map((event) => event.title), ["Photo exhibition", "Dated event"]);
  assert.equal(culturalEvents.events[0]?.startAt, "2030-06-11T12:00:00.000Z");
  assert.equal(culturalEvents.events[0]?.category, "Exhibition");
  assert.equal(culturalEvents.events[0]?.venue, "City Gallery");
  assert.ok(culturalEvents.checkedAt);
  assert.match(culturalEvents.attribution ?? "", /ODbL/);
  GetTravelContextResponse.shape.culturalEvents.parse(culturalEvents);
  assert.equal(transitFeed.status, "not-covered");
});

test("uses a Paris upcoming window when no trip dates are supplied", async () => {
  let query = "";
  globalThis.fetch = async (input) => {
    query = new URL(String(input)).searchParams.get("where") ?? "";
    return json({ results: [] });
  };
  const result = await getDestinationFeedContext("Paris", undefined, fixedNow);
  assert.match(query, /2030-06-09T22:00:00\.000Z/);
  assert.match(query, /2030-07-10T21:59:59\.999Z/);
  assert.equal(result.culturalEvents.status, "available");
  assert.deepEqual(result.culturalEvents.events, []);
  assert.equal(result.culturalEvents.checkedAt !== null, true);
});

test("reports source failures as unavailable, invalid event dates without a request, and other cities not covered", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("simulated provider outage");
  };
  const oslo = await getDestinationFeedContext("OSL", undefined, fixedNow);
  assert.equal(oslo.transitFeed.status, "unavailable");
  assert.equal(oslo.transitFeed.checkedAt, null);
  const paris = await getDestinationFeedContext("Paris", "next summer", fixedNow);
  assert.equal(paris.culturalEvents.status, "unavailable");
  assert.match(paris.culturalEvents.notice, /travel dates could not be read/);
  const barcelona = await getDestinationFeedContext("Barcelona", undefined, fixedNow);
  assert.equal(barcelona.transitFeed.status, "not-covered");
  assert.equal(barcelona.culturalEvents.status, "not-covered");
  assert.equal(fetches, 1);
});

test("caches successful official-feed lookups briefly to bound repeat off-chat provider calls", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return json({
      data: { stopPlace: { name: "Jernbanetorget", estimatedCalls: [] } },
    });
  };
  const first = await getDestinationFeedContext("Oslo", undefined, fixedNow);
  const second = await getDestinationFeedContext("Oslo", undefined, fixedNow);
  assert.equal(first.transitFeed.status, "available");
  assert.deepEqual(second.transitFeed, first.transitFeed);
  assert.equal(fetches, 1);
});