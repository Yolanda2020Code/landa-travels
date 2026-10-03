import test from "node:test";
import assert from "node:assert/strict";
import {
  boundAndRedactTranscript,
  buildHandoverSummary,
  createRecommendationSnapshot,
  minimizeHandoverContext,
  nextClarificationFailureCount,
  notifyAdvisorInbox,
  recommendComplexCaseHandover,
  recommendationSnapshotMatchesContext,
  safePlanningDateRange,
} from "./advisor-handover";
import type { Recommendation, TripContext } from "@workspace/api-zod";

const context: TripContext = {
  origin: "Berlin",
  destination: "Lisbon",
  currentLocation: "52.52,13.40",
  stopovers: ["Porto"],
  dateRange: "2026-08-01 to 2026-08-08",
  travellerCount: 2,
  budget: "€1000–€3000",
  transportPreferences: ["rail"],
  accessibilityNeeds: ["wheelchair access"],
  sustainabilityPriority: "Climate-first",
  accommodationNeeds: ["hotel"],
  locationConsentMode: "gps",
  reviewConfirmation: true,
  handoverRequested: true,
};
const completeContext: TripContext = {
  ...context,
  currentLocation: null,
  stopovers: [],
  accessibilityNeeds: ["none"],
  locationConsentMode: "skipped",
};
const recommendation = (type: Recommendation["type"], id: string = String(type)): Recommendation => ({
  id,
  type,
  name: `${type} option`,
  location: "Lisbon",
  description: "Provider option",
  price: "€100",
  carbonKg: 20,
  carbonLabel: "low",
  score: 75,
  certification: null,
  source: "https://example.test/source",
  verifiedAt: "2026-06-15T12:00:00.000Z",
  tags: [],
});

test("handover minimisation preserves curated functional needs without sharing location or free text", () => {
  const minimised = minimizeHandoverContext(context);
  assert.equal("currentLocation" in minimised, false);
  assert.deepEqual(minimised.accessibilityNeeds, ["Wheelchair access"]);
  assert.equal(minimised.destination, "Lisbon");
  assert.deepEqual(minimised.recommendationOptions, []);
  assert.deepEqual(minimised.selectedRecommendationIds, []);
  assert.equal(minimised.recommendationSelectionStatus, "no_explicit_selection");
});

test("handover summary contains trip information without GPS", () => {
  const summary = buildHandoverSummary(context, 4);
  assert.match(summary, /Berlin/);
  assert.match(summary, /Lisbon/);
  assert.doesNotMatch(summary, /52\.52/);
});

test("recommendation snapshot retains provider convenience and ranking fields", () => {
  const snapshot = createRecommendationSnapshot([{
    ...recommendation("transport", "rail-1"),
    durationMinutes: 245,
    connectionCount: 1,
    rankingExplanation: "Carbon 40%, price 20%; journey time is indicative.",
  }], "live", "2026-06-15T12:00:00.000Z", completeContext);
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.recommendations[0].durationMinutes, 245);
  assert.equal(snapshot.recommendations[0].connectionCount, 1);
  assert.match(snapshot.recommendations[0].rankingExplanation ?? "", /Carbon 40%/);
  assert.match(snapshot.unknowns.join(" "), /availability and final prices/i);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, completeContext), true);
  for (const changedContext of [
    { ...completeContext, destination: "Oslo" },
    { ...completeContext, dateRange: "2030-07-01 to 2030-07-05" },
    { ...completeContext, travellerCount: 3 },
    { ...completeContext, transportPreferences: ["flight"] },
    { ...completeContext, accommodationNeeds: ["hostel"] },
    { ...completeContext, activityPreferences: ["museum"] },
    { ...completeContext, sustainabilityPriority: "comfort-first" },
  ]) {
    assert.equal(recommendationSnapshotMatchesContext(snapshot, changedContext), false);
  }
});

test("validated ISO planning dates survive redaction and privacy-safe fingerprinting", () => {
  const dates = "2030-06-10 to 2030-06-14";
  assert.equal(safePlanningDateRange(dates), dates);
  const datedContext = { ...completeContext, dateRange: dates };
  const snapshot = createRecommendationSnapshot([recommendation("stay")], "demo", "2030-01-01", datedContext);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, datedContext), true);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, { ...datedContext, dateRange: "2030-06-11 to 2030-06-14" }), false);
  assert.equal(minimizeHandoverContext(datedContext).dateRange, dates);
  assert.match(buildHandoverSummary(datedContext, 0), /Dates: 2030-06-10 to 2030-06-14/);
});

test("manual city and specific accessibility needs affect fingerprints without being disclosed", () => {
  const privateContext = {
    ...completeContext,
    currentLocation: "Porto city centre",
    locationConsentMode: "manual" as const,
    accessibilityNeeds: ["wheelchair access"],
  };
  const snapshot = createRecommendationSnapshot([recommendation("stay")], "demo", "2030-01-01", privateContext);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, privateContext), true);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, { ...privateContext, currentLocation: "Lisbon" }), false);
  assert.equal(recommendationSnapshotMatchesContext(snapshot, { ...privateContext, accessibilityNeeds: ["hearing loop"] }), false);
  const minimized = minimizeHandoverContext(privateContext, snapshot);
  assert.equal("currentLocation" in minimized, false);
  assert.deepEqual(minimized.accessibilityNeeds, ["Wheelchair access"]);
  assert.doesNotMatch(JSON.stringify(minimized), /Porto city centre/i);
  assert.match(JSON.stringify(minimized), /Wheelchair access/);
});

test("handover preserves curated functional selections, suppresses none, and generalises unknown sensitive text", () => {
  const selectedContext = {
    ...completeContext,
    accessibilityNeeds: ["none", "wheelchair", "step-free", "limited walking", "hearing support", "visual support"],
  };
  assert.deepEqual(minimizeHandoverContext(selectedContext).accessibilityNeeds, [
    "Wheelchair access (step-free required)",
    "Step-free access",
    "Limited walking / minimise stairs",
    "Hearing support",
    "Visual support",
  ]);
  assert.deepEqual(minimizeHandoverContext({
    ...completeContext,
    accessibilityNeeds: ["none"],
  }).accessibilityNeeds, []);
  const unknownText = "I have a private neurological diagnosis and need extra help.";
  const unknownContext = { ...completeContext, accessibilityNeeds: [unknownText] };
  const minimisedUnknown = minimizeHandoverContext(unknownContext);
  assert.deepEqual(minimisedUnknown.accessibilityNeeds, ["Additional requirement—confirm with traveller"]);
  assert.doesNotMatch(JSON.stringify(minimisedUnknown), /neurological diagnosis|extra help/i);
});

test("inventory and accessibility escalation is final-review gated", () => {
  const rail = recommendation("transport", "rail");
  const stay = recommendation("stay", "stay");
  const inventoryStay: Recommendation = {
    ...recommendation("stay", "duffel-stay-room-1"),
    description: "Duffel TEST MODE stay availability; wheelchair-accessible room.",
    price: "EUR 100.00",
    source: "Duffel TEST MODE stay availability",
    tags: ["live test offer"],
  };
  const inventoryFlight: Recommendation = {
    ...recommendation("transport", "duffel-flight-offer-1"),
    name: "Duffel flight offer",
    description: "Duffel TEST MODE return offer.",
    price: "EUR 200.00",
    source: "Duffel TEST MODE flight availability",
    tags: ["flight", "live test offer"],
  };
  assert.deepEqual(
    recommendComplexCaseHandover({ ...completeContext, destination: null }, [rail, stay], 0),
    { recommended: false, reason: null, message: null },
  );
  assert.equal(recommendComplexCaseHandover({
    ...completeContext, stopovers: ["Paris", "Porto"],
  }, [rail, stay], 0).reason, "multiple_stopovers");
  assert.equal(recommendComplexCaseHandover({
    ...completeContext, accessibilityNeeds: ["wheelchair access"],
  }, [rail, stay], 0).reason, "unmet_accessibility");
  assert.equal(recommendComplexCaseHandover(completeContext, [stay], 0).reason, "required_inventory_unavailable");
  const completeFlightContext = { ...completeContext, transportPreferences: ["flight"] };
  assert.equal(recommendComplexCaseHandover(completeFlightContext, [inventoryFlight, inventoryStay], 2).reason, "repeated_failed_clarification");
  assert.equal(recommendComplexCaseHandover(completeFlightContext, [inventoryFlight, inventoryStay], 1).recommended, false);
  assert.equal(recommendComplexCaseHandover({
    ...completeContext,
    destination: null,
    reviewConfirmation: false,
  }, [], 2).reason, "repeated_failed_clarification");
  assert.equal(recommendComplexCaseHandover({
    ...completeContext,
    destination: null,
    reviewConfirmation: false,
  }, [], 1).recommended, false);
  assert.equal(recommendComplexCaseHandover({
    ...completeFlightContext,
    accessibilityNeeds: ["wheelchair access"],
  }, [{
    ...recommendation("stay"),
    description: "Wheelchair access information is unknown.",
  }, inventoryFlight], 0).reason, "unmet_accessibility");
  assert.equal(recommendComplexCaseHandover({
    ...completeFlightContext,
    accessibilityNeeds: ["wheelchair access"],
  }, [{
    ...inventoryStay,
    description: "Wheelchair-accessible room; wheelchair access is not guaranteed.",
  }, inventoryFlight], 0).reason, "unmet_accessibility");
  assert.equal(recommendComplexCaseHandover({
    ...completeFlightContext,
    accessibilityNeeds: ["wheelchair access"],
  }, [inventoryStay, inventoryFlight], 0).recommended, false);
  for (const description of [
    "Step-free access must be confirmed.",
    "Step-free access requires confirmation.",
    "Step-free access needs confirmation.",
    "Step-free access; check with provider.",
    "Contact the provider to confirm step-free access.",
    "Step-free access can be requested but is not guaranteed.",
  ]) {
    assert.equal(recommendComplexCaseHandover({
      ...completeFlightContext,
      accessibilityNeeds: ["step-free"],
    }, [{ ...inventoryStay, description }, inventoryFlight], 0).reason, "unmet_accessibility", description);
  }
  assert.equal(recommendComplexCaseHandover({
    ...completeFlightContext,
    accessibilityNeeds: ["step-free"],
  }, [{ ...inventoryStay, description: "Step-free access is available." }, inventoryFlight], 0).recommended, false);
  assert.equal(recommendComplexCaseHandover(completeFlightContext, [
    inventoryFlight,
    { ...inventoryStay, id: "curated-stay", source: "EU Ecolabel registry", tags: ["hotel"] },
  ], 0).reason, "required_inventory_unavailable");
});

test("clarification escalation is consecutive, resets after resolution, and ignores help explanations", () => {
  const failedPrompt = "I’m not certain what you meant. Could you say that a different way?";
  assert.equal(nextClarificationFailureCount(0, [failedPrompt], false), 1);
  assert.equal(nextClarificationFailureCount(1, [failedPrompt], false), 2);
  assert.equal(nextClarificationFailureCount(2, ["Carbon values are planning estimates based on distance and mode."], false), 2);
  assert.equal(nextClarificationFailureCount(2, ["What is your destination?"], true), 0);
  assert.equal(nextClarificationFailureCount(0, ["Carbon values are planning estimates based on distance and mode."], false), 0);
});

test("handover transcript is redacted and bounded by turns and total text", () => {
  const redacted = boundAndRedactTranscript([
    { role: "user", content: "Email me at person@example.test or call +1 555 123 4567; password=hunter2." },
    { role: "assistant", content: "Coordinates: 40.71,-74.00. I noted your allergy." },
  ]);
  const text = JSON.stringify(redacted);
  assert.doesNotMatch(text, /person@example\.test|555 123 4567|hunter2|40\.71|-74\.00|allergy/i);
  assert.match(text, /REDACTED EMAIL/);
  assert.match(text, /REDACTED LOCATION/);
  assert.match(text, /REDACTED CREDENTIAL/);
  assert.equal(boundAndRedactTranscript(Array.from({ length: 40 }, (_, index) => ({
    role: "user" as const, content: `Turn ${index}`,
  }))).length, 30);
  const bounded = boundAndRedactTranscript(Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: "x".repeat(1600),
  })));
  assert.ok(bounded.every((turn) => turn.content.length <= 1600));
  assert.ok(bounded.reduce((sum, turn) => sum + turn.content.length, 0) <= 12000);
});

test("notification reports provider acceptance without claiming webhook confirmation", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousInbox = process.env.RECRUITMENT_EMAIL;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.RECRUITMENT_EMAIL = "staff@example.test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email-test" }), { status: 200 })) as typeof fetch;
  const result = await notifyAdvisorInbox("LANDA-TEST", "Destination: Lisbon");
  assert.equal(result.status, "accepted");
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey;
  if (previousInbox === undefined) delete process.env.RECRUITMENT_EMAIL; else process.env.RECRUITMENT_EMAIL = previousInbox;
});

test("notification reports provider failures honestly", async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousInbox = process.env.RECRUITMENT_EMAIL;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "test-key";
  process.env.RECRUITMENT_EMAIL = "staff@example.test";
  globalThis.fetch = (async () => new Response("failed", { status: 503 })) as typeof fetch;
  const result = await notifyAdvisorInbox("LANDA-TEST", "Destination: Lisbon");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "provider_http_503");
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey;
  if (previousInbox === undefined) delete process.env.RECRUITMENT_EMAIL; else process.env.RECRUITMENT_EMAIL = previousInbox;
});