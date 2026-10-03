import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  getExchangeRate,
  getOffsetProgrammeContext,
  getPlaceDescription,
  getWeather,
} from "./travel-context-providers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("gets current conditions and a three-day outlook without treating it as trip-date weather", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.ok(init?.signal);
    assert.match(requestedUrl, /current=temperature_2m%2Cprecipitation%2Cwind_speed_10m%2Cweather_code/);
    assert.match(requestedUrl, /daily=temperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum%2Cweather_code/);
    return json({
      current: {
        time: "2031-04-01T12:00",
        temperature_2m: 17.4,
        precipitation: 0.2,
        wind_speed_10m: 11.6,
        weather_code: 2,
      },
      daily: {
        time: ["2031-04-01", "2031-04-02", "2031-04-03"],
        temperature_2m_max: [19, 20, 18],
        temperature_2m_min: [9, 10, 8],
        precipitation_sum: [1.2, 0, 4.5],
        weather_code: [2, 1, 3],
      },
    });
  };
  const result = await getWeather(52.52, 13.405, "2031-07-20 to 2031-07-25");
  assert.match(requestedUrl, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(requestedUrl, /forecast_days=3/);
  assert.equal(result.status, "available");
  assert.equal(result.source, "Open-Meteo");
  assert.equal(result.date, "2031-04-01");
  assert.equal(result.current?.temperatureC, 17.4);
  assert.equal(result.current?.precipitationMm, 0.2);
  assert.equal(result.current?.windSpeedKmh, 11.6);
  assert.equal(result.outlook.length, 3);
  assert.equal(result.outlook[0]?.precipitationMm, 1.2);
  assert.equal(result.travelDates, "2031-07-20 to 2031-07-25");
  assert.equal(result.forecastAppliesToTravelDates, false);
  assert.match(result.notice, /not a forecast for future travel dates/i);
  assert.match(result.travelAdvice, /not a safety guarantee/i);
});

test("returns explicit weather unavailability for invalid coordinates or malformed provider data", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return json({ current: {}, daily: {} });
  };
  const invalid = await getWeather(91, 0);
  assert.equal(invalid.status, "unavailable");
  assert.equal(fetches, 0);
  const malformed = await getWeather(41.123, 21.456);
  assert.equal(malformed.status, "unavailable");
  assert.deepEqual(malformed.outlook, []);
});

test("fetch timeout or provider outage gives unavailable weather rather than invented values", async () => {
  globalThis.fetch = async () => {
    throw new Error("provider offline");
  };
  const result = await getWeather(-33.876, 151.205);
  assert.equal(result.status, "unavailable");
  assert.equal(result.current, null);
  assert.deepEqual(result.outlook, []);
});

test("first outlook day advice applies cautious rain, cold and heat thresholds", async () => {
  globalThis.fetch = async () => json({
    current: {
      time: "2032-08-10T12:00",
      temperature_2m: 25,
      precipitation: 0,
      wind_speed_10m: 8,
      weather_code: 1,
    },
    daily: {
      time: ["2032-08-10", "2032-08-11", "2032-08-12"],
      temperature_2m_max: [31, 22, 23],
      temperature_2m_min: [4, 12, 13],
      precipitation_sum: [5.1, 0, 0],
      weather_code: [61, 1, 1],
    },
  });
  const result = await getWeather(46.321, 7.654);
  assert.equal(result.status, "available");
  assert.match(result.travelAdvice, /rain protection/);
  assert.match(result.travelAdvice, /warm layers/);
  assert.match(result.travelAdvice, /shade and hydration/);
  assert.match(result.travelAdvice, /check local conditions and advisories/);
  assert.match(result.travelAdvice, /not a safety guarantee/);
});

test("missing or non-finite new weather fields invalidate the provider result", async () => {
  globalThis.fetch = async () => json({
    current: {
      time: "2033-09-01T12:00",
      temperature_2m: 18,
      precipitation: null,
      wind_speed_10m: 5,
      weather_code: 1,
    },
    daily: {
      time: ["2033-09-01", "2033-09-02", "2033-09-03"],
      temperature_2m_max: [20, 21, 22],
      temperature_2m_min: [10, 11, 12],
      precipitation_sum: [0, 0, 0],
      weather_code: [1, 1, 1],
    },
  });
  const result = await getWeather(12.345, 67.89);
  assert.equal(result.status, "unavailable");
  assert.equal(result.current, null);
  assert.deepEqual(result.outlook, []);
});

test("looks up Wikipedia title safely and returns short plain text with attribution", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("User-Agent"), "EcoTravelAdvisor/1.0 (travel context provider)");
    return json({
      query: {
        pages: [{
          pageid: 42,
          title: "New York City",
          extract: "New York City is the most populous city in the United States. <b>Second sentence.</b>",
        }],
      },
    });
  };
  const result = await getPlaceDescription("en:New_York_City");
  assert.match(requestedUrl, /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?/);
  assert.equal(result.status, "available");
  assert.equal(result.extract, "New York City is the most populous city in the United States. Second sentence.");
  assert.equal(result.sourceUrl, "https://en.wikipedia.org/wiki/New_York_City");
  assert.match(result.attribution ?? "", /Wikipedia/);
});

test("rejects arbitrary URLs and non-English tags without making a request", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return json({});
  };
  assert.equal((await getPlaceDescription("https://127.0.0.1/private")).status, "unavailable");
  assert.equal((await getPlaceDescription("fr:Paris")).status, "unavailable");
  assert.equal(fetches, 0);
});

test("Wikipedia provider errors and malformed pages are explicit unavailable results", async () => {
  globalThis.fetch = async () => json({ query: { pages: [{ missing: true }] } });
  const result = await getPlaceDescription("Unlisted place 318");
  assert.deepEqual(result, {
    status: "unavailable",
    extract: null,
    sourceUrl: null,
    attribution: null,
  });
});

test("normalizes and validates Frankfurter rates and caches successful lookups", async () => {
  let fetches = 0;
  globalThis.fetch = async (input, init) => {
    fetches++;
    assert.match(String(input), /^https:\/\/api\.frankfurter\.dev\/v1\/latest\?/);
    assert.ok(init?.signal);
    return json({ base: "EUR", date: "2031-03-31", rates: { USD: 1.08 } });
  };
  const first = await getExchangeRate(" eur ", "usd");
  const second = await getExchangeRate("EUR", "USD");
  assert.deepEqual(first, {
    status: "available",
    base: "EUR",
    target: "USD",
    rate: 1.08,
    date: "2031-03-31",
    source: "Frankfurter",
  });
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
});

test("same currency returns identity and invalid/malformed rates are unavailable", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return json({ base: "CHF", date: "2031-03-31", rates: { PLN: -1 } });
  };
  const identity = await getExchangeRate("gbp", "GBP");
  assert.equal(identity.status, "available");
  assert.equal(identity.rate, 1);
  assert.equal(identity.base, "GBP");
  assert.equal(identity.target, "GBP");
  assert.match(identity.source, /Identity/);
  assert.equal((await getExchangeRate("US1", "EUR")).status, "unavailable");
  assert.equal((await getExchangeRate("CHF", "PLN")).status, "unavailable");
  assert.equal(fetches, 1);
});

test("Frankfurter outage returns unavailable without exposing errors", async () => {
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  const result = await getExchangeRate("CAD", "JPY");
  assert.equal(result.status, "unavailable");
  assert.equal(result.rate, null);
  assert.equal(result.date, null);
  assert.equal(result.source, "Frankfurter");
});

test("offset programme links are sourced official directories, explicitly static and not live offers", () => {
  const result = getOffsetProgrammeContext();
  assert.equal(result.status, "curated-demo");
  assert.equal(result.checkedAt, null);
  assert.equal(result.programmes.length, 3);
  assert.ok(result.programmes.every((programme) =>
    programme.evidenceType === "official programme directory" &&
    programme.checkedAt === null &&
    programme.sourceUrl.startsWith("https://"),
  ));
  assert.match(result.notice, /not live offers/);
  assert.match(result.notice, /a claim that offsets neutralise travel emissions/);
});