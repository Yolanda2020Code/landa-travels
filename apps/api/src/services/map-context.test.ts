import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { getNearbyMapContext, loadMapContext, normalizeMapDestinationSlug } from "./map-context";

const validCache = {
  schemaVersion: 1,
  destination: {
    slug: "paris",
    label: "Paris, France",
    latitude: 48.8566,
    longitude: 2.3522,
    osmObjectId: "relation/7444",
    sourceUrl: "https://www.openstreetmap.org/relation/7444",
    checkedAt: "2030-01-01T00:00:00Z",
  },
  checkedAt: "2030-01-01T00:00:00Z",
  records: [{
    category: "attraction",
    name: "Example museum",
    latitude: 48.86,
    longitude: 2.35,
    osmObjectId: "way/123",
    sourceUrl: "https://www.openstreetmap.org/way/123",
    checkedAt: "2030-01-01T00:00:00Z",
    wikipedia: "en:Example",
  }],
  attribution: "© OpenStreetMap contributors",
};

async function withCacheFile(slug: string, callback: (filePath: string, cacheDirectory: string) => Promise<void>): Promise<void> {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "map-context-test-"));
  const filePath = path.join(cacheDirectory, `${slug}.json`);
  await mkdir(cacheDirectory, { recursive: true });
  try {
    await callback(filePath, cacheDirectory);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

test("normalizes guided destination names and IATA aliases to canonical slugs", () => {
  assert.equal(normalizeMapDestinationSlug("Paris (PAR)"), "paris");
  assert.equal(normalizeMapDestinationSlug("paris-PAR"), "paris");
  assert.equal(normalizeMapDestinationSlug("BER"), "berlin");
  assert.equal(normalizeMapDestinationSlug("Lisbon (LIS)"), "lisbon");
  assert.equal(normalizeMapDestinationSlug("San José (SJO)"), "san-jose");
  assert.equal(normalizeMapDestinationSlug("san-jose-SJO"), "san-jose");
  assert.equal(normalizeMapDestinationSlug("../../secret"), null);
});

test("returns a clear cache miss and never uses arbitrary destination paths", async () => {
  await withCacheFile("unused", async (_filePath, cacheDirectory) => {
    const miss = await loadMapContext("map-context-test-missing", { cacheDirectory });
    assert.equal(miss.status, "cache-miss");
    if (miss.status === "cache-miss") assert.equal(miss.reason, "not-found");

    const traversal = await loadMapContext("../secret", { cacheDirectory });
    assert.equal(traversal.status, "cache-miss");
    if (traversal.status === "cache-miss") assert.equal(traversal.reason, "invalid");
  });
});

test("validates cache JSON, canonical Paris alias, and returns normalized records", async () => {
  await withCacheFile("paris", async (filePath, cacheDirectory) => {
    await writeFile(filePath, JSON.stringify(validCache));
    const result = await loadMapContext("Paris (PAR)", {
      now: new Date("2030-01-02T00:00:00Z"),
      cacheDirectory,
    });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.data.destination.slug, "paris");
      assert.equal(result.data.records[0]?.wikipedia, "en:Example");
    }

    await writeFile(filePath, "{not json");
    const malformed = await loadMapContext("paris", { cacheDirectory });
    assert.equal(malformed.status, "cache-miss");
    if (malformed.status === "cache-miss") assert.equal(malformed.reason, "invalid");
  });
});

test("labels old validated caches stale instead of silently treating them as current", async () => {
  await withCacheFile("paris", async (filePath, cacheDirectory) => {
    await writeFile(filePath, JSON.stringify(validCache));
    const result = await loadMapContext("paris", {
      now: new Date("2030-02-15T00:00:00Z"),
      maxAgeMs: 1_000,
      cacheDirectory,
    });
    assert.equal(result.status, "stale");
    if (result.status === "stale") {
      assert.equal(result.stale, true);
      assert.ok(result.ageMs > 1_000);
    }
  });
});

test("rejects unsafe OSM source URLs and malformed records", async () => {
  await withCacheFile("paris", async (filePath, cacheDirectory) => {
    const malformed = structuredClone(validCache);
    malformed.records[0].sourceUrl = "https://example.org/fake";
    await writeFile(filePath, JSON.stringify(malformed));
    const result = await loadMapContext("paris", { cacheDirectory });
    assert.equal(result.status, "cache-miss");
    if (result.status === "cache-miss") assert.equal(result.reason, "invalid");
  });
});

test("skip performs no map lookup and discloses that device location was not requested", async () => {
  const result = await getNearbyMapContext({ mode: "skip" }, { cacheDirectory: "/missing-map-context" });
  assert.equal(result.status, "skipped");
  assert.equal(result.mode, "skip");
  assert.deepEqual(result.hotels, []);
  assert.match(result.notice, /No device location was requested/);
});

test("manual city and rounded GPS tailor offline mapped places with approximate distances and no coordinate echo", async () => {
  await withCacheFile("paris", async (filePath, cacheDirectory) => {
    const parisCache = structuredClone(validCache);
    parisCache.records = [
      { ...parisCache.records[0]!, category: "hotel", name: "Map hotel", latitude: 48.86, longitude: 2.35 },
      { ...parisCache.records[0]!, category: "transit", name: "Map station", latitude: 48.87, longitude: 2.36, osmObjectId: "node/124", sourceUrl: "https://www.openstreetmap.org/node/124" },
    ];
    await writeFile(filePath, JSON.stringify(parisCache));

    const manual = await getNearbyMapContext({ mode: "manual", city: "Paris" }, {
      cacheDirectory,
      now: new Date("2030-01-02T00:00:00Z"),
    });
    assert.equal(manual.status, "available");
    assert.equal(manual.label, "Approximate city: Paris");
    assert.equal(manual.hotels[0]?.name, "Map hotel");
    assert.equal(manual.attractions.length, 0);
    assert.match(manual.notice, /not live hotel inventory, transit timetables/);

    const gps = await getNearbyMapContext({ mode: "gps", latitude: 48.86, longitude: 2.35 }, {
      cacheDirectory,
      now: new Date("2030-01-02T00:00:00Z"),
    });
    assert.equal(gps.status, "available");
    assert.match(gps.label ?? "", /Approximate GPS area near Paris/);
    assert.equal(gps.hotels[0]?.distanceKm, 0);
    assert.ok(gps.transit[0]!.distanceKm > 0);
    assert.equal("latitude" in gps, false);
    assert.equal("longitude" in gps, false);
    assert.equal("latitude" in gps.hotels[0]!, false);
    assert.equal("longitude" in gps.hotels[0]!, false);

    const movedGps = await getNearbyMapContext({ mode: "gps", latitude: 48.87, longitude: 2.36 }, {
      cacheDirectory,
      now: new Date("2030-01-02T00:00:00Z"),
    });
    assert.equal(movedGps.transit[0]?.distanceKm, 0);
    assert.notEqual(gps.transit[0]?.distanceKm, movedGps.transit[0]?.distanceKm);
  });
});

test("manual city outside the offline supported set and GPS outside coverage remain unavailable", async () => {
  const manual = await getNearbyMapContext({ mode: "manual", city: "Somewhere" });
  assert.equal(manual.status, "unavailable");
  assert.match(manual.notice, /No offline OpenStreetMap snapshot/);

  const gps = await getNearbyMapContext({ mode: "gps", latitude: 0, longitude: 0 });
  assert.equal(gps.status, "unavailable");
  assert.match(gps.notice, /No supported offline map snapshot covers/);
});