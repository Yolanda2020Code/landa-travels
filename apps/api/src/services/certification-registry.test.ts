import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCertifiedStaysToRecommendations,
  EU_ECOLABEL_API_URL,
  getCertifiedStaysFeed,
  normalizeOfficialRecord,
  refreshCertificationRegistry,
  registryUrlForLicence,
  type RegistrySnapshot,
} from "./certification-registry";
import type { Recommendation } from "@workspace/api-zod";

const now = new Date("2030-06-01T12:00:00.000Z");

function officialRecord(overrides: Record<string, unknown> = {}) {
  return {
    licence_number: "FR/051/103",
    expiration_date: "2030-12-31T00:00:00",
    group_name: "Tourist accommodation",
    service_name: "Solar Hotel",
    service_type: "Hotel",
    service_street: "22 rue Boulard",
    service_city: "PARIS",
    service_country: "France",
    service_website: "https://example.fr/hotel",
    coordinates: "ignored",
    ...overrides,
  };
}

function snapshot(records: Array<Record<string, unknown>>, checkedAt = "2030-06-01T10:00:00.000Z"): RegistrySnapshot {
  return {
    schemaVersion: 1,
    checkedAt,
    records: records.flatMap((record) => {
      const normalized = normalizeOfficialRecord(record, now);
      return normalized ? [normalized] : [];
    }),
  };
}

test("normalizes only the permitted official fields and rejects malformed hotel URLs", () => {
  const record = normalizeOfficialRecord(officialRecord({
    service_website: "https://http://www.solarhotel.fr",
  }), now);
  assert.deepEqual(record, {
    licenceNumber: "FR/051/103",
    expirationDate: "2030-12-31",
    name: "Solar Hotel",
    serviceType: "Hotel",
    groupName: "Tourist accommodation",
    street: "22 rue Boulard",
    city: "PARIS",
    country: "France",
    website: null,
  });
  assert.equal(normalizeOfficialRecord(officialRecord({ service_website: "javascript:alert(1)" }), now)?.website, null);
  assert.equal(normalizeOfficialRecord(officialRecord({ service_website: "https://hotel.example.fr/" }), now)?.website, "https://hotel.example.fr/");
});

test("rejects non-hotels, missing licences, expired records, and mismatched city/country", () => {
  assert.equal(normalizeOfficialRecord(officialRecord({ service_type: "Guest house" }), now), null);
  assert.equal(normalizeOfficialRecord(officialRecord({ group_name: "Camping sites" }), now), null);
  assert.equal(normalizeOfficialRecord(officialRecord({ licence_number: "" }), now), null);
  assert.equal(normalizeOfficialRecord(officialRecord({ licence_number: "fake licence" }), now), null);
  assert.equal(normalizeOfficialRecord(officialRecord({ expiration_date: "2030-06-01T00:00:00" }), now), null);
  const feed = getCertifiedStaysFeed("Paris", "2030-06-10 to 2030-06-12", now, snapshot([
    officialRecord(),
    officialRecord({ licence_number: "DE/051/2", service_city: "Berlin" }),
    officialRecord({ licence_number: "FR/051/3", service_city: "Paris", service_country: "Germany" }),
  ]));
  assert.equal(feed.stays.length, 1);
  assert.equal(feed.stays[0]?.name, "Solar Hotel");
});

test("requires certification to remain valid through trip end and declines invalid trip dates", () => {
  const feed = getCertifiedStaysFeed("Paris", "2030-06-10 to 2030-06-12", now, snapshot([
    officialRecord({ expiration_date: "2030-06-12T00:00:00" }),
    officialRecord({ licence_number: "FR/051/104", expiration_date: "2030-06-11T00:00:00" }),
  ]));
  assert.equal(feed.stays.length, 1);
  assert.equal(feed.stays[0]?.certificationEvidence.validUntil, "2030-06-12");
  const invalidDates = getCertifiedStaysFeed("Paris", "June sometime", now, snapshot([officialRecord()]));
  assert.deepEqual(invalidDates.stays, []);
  assert.match(invalidDates.notice, /travel dates could not be validated/);
  const missingDates = getCertifiedStaysFeed("Paris", undefined, now, snapshot([officialRecord()]));
  assert.deepEqual(missingDates.stays, []);
  assert.match(missingDates.notice, /travel dates could not be validated/);
  const flexibleDates = getCertifiedStaysFeed("Paris", "2030-06-10 to Flexible return", now, snapshot([officialRecord()]));
  assert.deepEqual(flexibleDates.stays, []);
  assert.match(flexibleDates.notice, /travel dates could not be validated/);
  const crossedMidnight = snapshot([officialRecord()]);
  crossedMidnight.records[0]!.expirationDate = "2030-06-01";
  crossedMidnight.checkedAt = "2030-05-31T23:00:00.000Z";
  assert.deepEqual(getCertifiedStaysFeed("Paris", "2030-05-28 to 2030-05-30", now, crossedMidnight).stays, []);
});

test("stale snapshots become explicitly unavailable and unsupported destinations remain not covered", () => {
  const stale = getCertifiedStaysFeed("Paris", undefined, now, snapshot([officialRecord()], "2030-05-30T11:59:59.000Z"));
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.stays.length, 0);
  assert.match(stale.notice, /older than 24 hours/);
  const unsupported = getCertifiedStaysFeed("Prague", undefined, now, snapshot([officialRecord()]));
  assert.equal(unsupported.status, "not-covered");
  assert.deepEqual(unsupported.stays, []);
});

test("provider refresh failure leaves the previous bundled snapshot untouched", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eu-ecolabel-refresh-test-"));
  const existingSnapshot = JSON.stringify({ schemaVersion: 1, marker: "previous snapshot" });
  const snapshotPath = path.join(directory, "snapshot.json");
  await writeFile(snapshotPath, existingSnapshot, "utf8");
  try {
    await assert.rejects(
      () => refreshCertificationRegistry({
        fetcher: async () => { throw new Error("provider offline"); },
        now,
        snapshotPath,
      }),
      /provider offline/,
    );
    assert.equal(await readFile(snapshotPath, "utf8"), existingSnapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("licence verification links use a query parameter and URL encoding, not a slash path", () => {
  const url = new URL(registryUrlForLicence("FR/051/103"));
  assert.equal(url.origin + url.pathname, EU_ECOLABEL_API_URL);
  assert.equal(url.searchParams.get("licence_number"), "FR/051/103");
  assert.match(url.search, /FR%2F051%2F103/);
});

test("does not create hotel recommendations before Rasa returns accommodation options", () => {
  const result = applyCertifiedStaysToRecommendations(
    [], "Paris", "2030-06-10 to 2030-06-12", now, snapshot([officialRecord()]),
  );
  assert.deepEqual(result.recommendations, []);
  assert.equal(result.notice, null);
});

test("removes unsupported certification claims and substitutes direct certified registry recommendations", () => {
  const legacy: Recommendation = {
    id: "demo-stay",
    type: "stay",
    name: "Illustrative Green Hotel",
    location: "Paris, France",
    description: "An eco-certified property with a sustainability award.",
    price: "from €99",
    carbonKg: 0,
    carbonLabel: "low",
    score: 90,
    certification: "Illustrative certification",
    source: "Demo catalogue",
    verifiedAt: "2030-06-01",
    tags: ["eco-certified", "nice"],
  };
  const result = applyCertifiedStaysToRecommendations(
    [legacy],
    "Paris",
    "2030-06-10 to 2030-06-12",
    now,
    snapshot([officialRecord()]),
  );
  assert.equal(result.recommendations.length, 1);
  const recommendation = result.recommendations[0]!;
  assert.equal(recommendation.name, "Solar Hotel");
  assert.equal(recommendation.certification, "EU Ecolabel");
  assert.equal(recommendation.certificationEvidence?.licenceNumber, "FR/051/103");
  assert.equal(recommendation.price, "Not provided by the official registry");
  assert.equal(recommendation.carbonKg, null);
  assert.ok(!recommendation.tags.includes("eco-certified"));
  assert.match(result.notice ?? "", /not a property-specific measurement/);

  const noRegistryMatch = applyCertifiedStaysToRecommendations(
    [legacy],
    "Paris",
    "2030-06-10 to 2030-06-12",
    now,
    snapshot([]),
  );
  assert.equal(noRegistryMatch.recommendations[0]?.certification, null);
  assert.ok(!noRegistryMatch.recommendations[0]?.tags.some((tag) => /certif/i.test(tag)));
  assert.doesNotMatch(noRegistryMatch.recommendations[0]?.description ?? "", /eco-certified/i);

  const invalidTrip = applyCertifiedStaysToRecommendations(
    [legacy],
    "Paris",
    "next summer",
    now,
    snapshot([officialRecord()]),
  );
  assert.equal(invalidTrip.recommendations[0]?.certification, null);
  assert.notEqual(invalidTrip.recommendations[0]?.name, "Solar Hotel");
});