import assert from "node:assert/strict";
import test from "node:test";
import { isCertificationEvidenceFresh } from "./certification-evidence";

const now = Date.parse("2026-06-10T12:00:00.000Z");

test("accepts evidence checked within 24 hours and before the licence expiry", () => {
  assert.equal(isCertificationEvidenceFresh("2027-12-31", "2026-06-09T13:00:00.000Z", now), true);
  assert.equal(isCertificationEvidenceFresh("2026-06-10", "2026-06-10T11:59:00.000Z", now), true);
});

test("rejects evidence older than the 24-hour registry snapshot TTL", () => {
  assert.equal(isCertificationEvidenceFresh("2027-12-31", "2026-06-09T11:59:59.999Z", now), false);
});

test("rejects future checked timestamps", () => {
  assert.equal(isCertificationEvidenceFresh("2027-12-31", "2026-06-10T12:00:00.001Z", now), false);
});

test("rejects expired licences", () => {
  assert.equal(isCertificationEvidenceFresh("2026-06-09", "2026-06-10T11:00:00.000Z", now), false);
});

test("rejects invalid check and expiry timestamps", () => {
  assert.equal(isCertificationEvidenceFresh("not-a-date", "2026-06-10T11:00:00.000Z", now), false);
  assert.equal(isCertificationEvidenceFresh("2027-12-31", "not-a-timestamp", now), false);
});