import assert from "node:assert/strict";
import test from "node:test";
import type { Recommendation, TripContext } from "@workspace/api-zod";
import { rankTripRecommendations } from "./trip-ranking";

const context: TripContext = {
  origin: "Berlin", destination: "Paris", currentLocation: null, stopovers: [],
  dateRange: "2030-06-10 to 2030-06-14", travellerCount: 1, budget: "Under €100",
  transportPreferences: ["rail"], accessibilityNeeds: ["none"],
  sustainabilityPriority: "balanced", accommodationNeeds: ["none"],
  locationConsentMode: "skipped", reviewConfirmation: true, handoverRequested: false,
};

function option(id: string, price: string, carbonKg: number): Recommendation {
  return {
    id, type: "transport", name: id, location: "Berlin → Paris",
    description: "Illustrative comparison", price, carbonKg,
    carbonLabel: carbonKg > 150 ? "high" : "low", score: 1,
    certification: null, source: "Test", verifiedAt: "2030-06-01",
    tags: [id.includes("flight") ? "flight" : "rail"],
  };
}

test("honours climate, preference and known EUR budget instead of fixed provider score", () => {
  const items = [option("flight", "EUR 500", 300), option("rail", "€80 indicative", 35)];
  const ranked = rankTripRecommendations(items, context);
  assert.equal(ranked[0]?.id, "rail");
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("does not compare foreign-currency quote with EUR budget without an exchange rate", () => {
  const items = [option("flight", "GBP 110", 100), option("rail", "€80", 100)];
  const result = rankTripRecommendations(items, { ...context, transportPreferences: ["flexible"] });
  assert.ok(result.every((item) => item.score >= 0 && item.score <= 100));
  assert.equal(result.find((item) => item.id === "flight")?.score, 50);
});

test("mode preference changes ranking when price and carbon match", () => {
  const items = [option("flight", "€80", 80), option("rail", "€80", 80)];
  assert.equal(rankTripRecommendations(items, { ...context, budget: "Flexible", transportPreferences: ["flight"] })[0]?.id, "flight");
  assert.equal(rankTripRecommendations(items, { ...context, budget: "Flexible", transportPreferences: ["rail"] })[0]?.id, "rail");
});

test("a per-traveller demo estimate is compared to a total-party budget", () => {
  const rail = option("rail", "€80 per traveller · indicative", 35);
  const single = rankTripRecommendations([rail], context)[0]!.score;
  const party = rankTripRecommendations([rail], { ...context, travellerCount: 2 })[0]!.score;
  assert.ok(party < single);
});

test("provider time and transfers distinguish equally priced/emitting options", () => {
  const direct = { ...option("rail-direct", "€80", 80), durationMinutes: 180, connectionCount: 0 };
  const slow = { ...option("rail-slow", "€80", 80), durationMinutes: 480, connectionCount: 3 };
  const ranked = rankTripRecommendations([slow, direct], { ...context, budget: "Flexible", sustainabilityPriority: "comfort-first" });
  assert.equal(ranked[0]?.id, "rail-direct");
  assert.ok(ranked[0]!.score > ranked[1]!.score);
  assert.match(ranked[0]!.rankingExplanation!, /180 minutes, 0 connections/);
});

test("unknown convenience and accommodation prices do not become invented guarantees", () => {
  const unknown = { ...option("rail", "Price unavailable", 80), durationMinutes: undefined, connectionCount: undefined };
  const ranked = rankTripRecommendations([unknown], context)[0]!;
  assert.match(ranked.rankingExplanation!, /Journey time unknown/);
  assert.match(ranked.rankingExplanation!, /Price unknown; not treated as free/);
  assert.equal(ranked.durationMinutes, undefined);
});