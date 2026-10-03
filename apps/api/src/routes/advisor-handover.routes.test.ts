import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, advisorHandoversTable, conversationsTable, savedTripsTable } from "@workspace/db";
import assistantRouter from "./assistant";
import travellerRouter from "./traveller";
import advisorRouter from "./advisor";
import { tripContextFingerprint } from "../services/advisor-handover";

type ResponseStub = { statusCode: number; body: unknown; status: (code: number) => ResponseStub; json: (body: unknown) => ResponseStub };
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
function handler(router: any, path: string, method: string) {
  const layer = router.stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}
async function call(route: any, request: Record<string, unknown>) {
  const res = response();
  await route(request, res);
  return res;
}
const ids: string[] = [];
const tripIds: number[] = [];
const conversationIds: string[] = [];

function authRequest(userId: string, body: unknown = {}, params: Record<string, string> = {}) {
  return { userId, body, params, headers: {} };
}

test("handover route only accepts an owned saved trip and traveller list is isolated", async () => {
  const owner = `route-owner-${Date.now()}`;
  const other = `route-other-${Date.now()}`;
  const sessionId = `route-handover-${Date.now()}`;
  conversationIds.push(sessionId);
  const recommendations = [
    {
      id: "trusted-rail-option",
      type: "transport",
      name: "Lower-impact train",
      location: "Berlin to Lisbon",
      description: "Illustrative rail itinerary",
      price: "€180 indicative",
      carbonKg: 20,
      carbonLabel: "low",
      score: 85,
      certification: null,
      source: "https://provider.example.test/rail",
      verifiedAt: "2026-06-15T12:00:00.000Z",
      tags: ["rail"],
      durationMinutes: 305,
      connectionCount: 2,
      rankingExplanation: "Carbon and preference weighting; provider duration is indicative.",
    },
    ...Array.from({ length: 62 }, (_, index) => ({
      id: `mixed-option-${index}`,
      type: (["stay", "transport", "experience", "offset"] as const)[index % 4],
      name: `Mixed category option ${index}`,
      location: "Lisbon",
      description: "Illustrative recommendation",
      price: "€120 indicative",
      carbonKg: 12,
      carbonLabel: "low",
      score: 70,
      certification: null,
      source: "Curated illustration",
      verifiedAt: "2026-06-15T12:00:00.000Z",
      tags: [],
    })),
    {
      id: "last-flight-option",
      type: "transport",
      name: "Last displayed flight",
      location: "Berlin to Lisbon",
      description: "Illustrative flight option",
      price: "€240 indicative",
      carbonKg: 40,
      carbonLabel: "moderate",
      score: 65,
      certification: null,
      source: "Curated illustration",
      verifiedAt: "2026-06-15T12:00:00.000Z",
      tags: ["flight"],
    },
  ];
  await db.insert(conversationsTable).values({
    sessionId,
    userId: owner,
    context: {
      origin: "Berlin",
      destination: "Lisbon",
      activityPreferences: ["museum"],
      recommendationSnapshot: {
        confirmedAt: "2026-06-15T12:00:00.000Z",
        source: "live",
        recommendations,
        unknowns: ["Availability and final prices must be confirmed with the provider before booking."],
        contextFingerprint: tripContextFingerprint({
          origin: null,
          destination: "Lisbon",
        dateRange: "2030-06-10 to 2030-06-14",
          travellerCount: null,
          budget: null,
          transportPreferences: [],
          accommodationNeeds: [],
          activityPreferences: ["museum"],
          sustainabilityPriority: null,
          stopovers: [],
          accessibilityNeeds: [],
          locationConsentMode: null,
        }),
      },
    },
  });
  const [ownerTrip] = await db.insert(savedTripsTable).values({
    userId: owner,
    title: "Owned route trip",
    destination: "Lisbon",
    dateRange: "2030-06-10 to 2030-06-14",
    conversationSessionId: sessionId,
    context: {
      destination: "attacker value",
      activityPreferences: ["museum"],
      recommendationSnapshot: { source: "demo", recommendations: [{ id: "attacker-option" }] },
    },
  }).returning();
  const [foreignTrip] = await db.insert(savedTripsTable).values({ userId: other, title: "Foreign route trip", destination: "Oslo" }).returning();
  tripIds.push(ownerTrip.id, foreignTrip.id);

  const post = handler(assistantRouter, "/assistant/handover", "post");
  const requestContext = {
    origin: null, destination: "Paris", currentLocation: null, stopovers: [], dateRange: null,
    travellerCount: null, budget: null, transportPreferences: [], accessibilityNeeds: [],
    sustainabilityPriority: null, accommodationNeeds: [], locationConsentMode: null,
    reviewConfirmation: true, handoverRequested: true,
  };
  const transcript = [
    { role: "user", content: "I need to reach me at traveller@example.test, 52.52,13.40, or 123 Main Street. I need wheelchair access." },
    { role: "assistant", content: "I can help compare saved trip options." },
  ];
  const success = await call(post, authRequest(owner, {
    savedTripId: ownerTrip.id,
    shareTranscriptConsent: true,
    transcript,
    selectedRecommendationIds: ["trusted-rail-option", "last-flight-option"],
    sessionId: "untrusted-client-session",
    context: requestContext,
  }));
  assert.equal(success.statusCode, 200);
  const handoverId = (success.body as { handoverId: string }).handoverId;
  ids.push(handoverId);
  assert.match((success.body as { summary: string }).summary, /Lisbon/);
  assert.doesNotMatch((success.body as { summary: string }).summary, /Paris/);
  assert.match((success.body as { summary: string }).summary, /Dates: 2030-06-10 to 2030-06-14/);
  assert.match((success.body as { summary: string }).summary, /Confirmed options: 64/);
  assert.match((success.body as { summary: string }).summary, /Traveller-selected options: 2/);
  const [created] = await db.select().from(advisorHandoversTable).where(eq(advisorHandoversTable.handoverId, handoverId)).limit(1);
  assert.ok(Array.isArray(created.transcript));
  assert.equal((created.transcript as Array<{ role: string; content: string }>).length, 2);
  assert.match(JSON.stringify(created.transcript), /REDACTED EMAIL/);
  assert.match(JSON.stringify(created.transcript), /REDACTED LOCATION/);
  assert.match(JSON.stringify(created.transcript), /REDACTED ADDRESS/);
  assert.match(JSON.stringify(created.transcript), /REDACTED ACCESSIBILITY NEED/);
  assert.doesNotMatch(JSON.stringify(created.transcript), /traveller@example.test|52\.52|Main Street|wheelchair/i);
  const persistedContext = created.privacyContext as {
    recommendationOptions: Array<{ id: string; durationMinutes?: number; connectionCount?: number; rankingExplanation?: string }>;
    selectedRecommendationIds: string[];
    recommendationSource: string;
    recommendationUnknowns: string[];
    activityPreferences: string[];
  };
  assert.equal(persistedContext.recommendationOptions[0].id, "trusted-rail-option");
  assert.equal(persistedContext.recommendationOptions[0].durationMinutes, 305);
  assert.equal(persistedContext.recommendationOptions[0].connectionCount, 2);
  assert.match(persistedContext.recommendationOptions[0].rankingExplanation ?? "", /Carbon and preference/);
  assert.equal(persistedContext.recommendationOptions.length, 64);
  assert.equal(persistedContext.recommendationOptions.at(-1)?.id, "last-flight-option");
  assert.deepEqual(persistedContext.selectedRecommendationIds, ["trusted-rail-option", "last-flight-option"]);
  assert.equal(persistedContext.recommendationSource, "live");
  assert.deepEqual(persistedContext.activityPreferences, ["museum"]);
  assert.ok(persistedContext.recommendationUnknowns.length > 0);
  const [tripAfterHandover] = await db.select().from(savedTripsTable).where(eq(savedTripsTable.id, ownerTrip.id)).limit(1);
  assert.equal((tripAfterHandover.context as any).recommendationSnapshot.recommendations.length, 64);
  assert.equal((tripAfterHandover.context as any).recommendationSnapshot.recommendations.at(-1).id, "last-flight-option");

  const foreign = await call(post, authRequest(owner, { savedTripId: foreignTrip.id, shareTranscriptConsent: true, transcript: [] }));
  assert.equal(foreign.statusCode, 404);
  const invalidSelection = await call(post, authRequest(owner, {
    savedTripId: ownerTrip.id,
    shareTranscriptConsent: true,
    transcript: [],
    selectedRecommendationIds: ["attacker-option"],
  }));
  assert.equal(invalidSelection.statusCode, 400);
  const noConsent = await call(post, authRequest(owner, { savedTripId: ownerTrip.id, shareTranscriptConsent: false, transcript: [] }));
  assert.equal(noConsent.statusCode, 400);
  const list = handler(travellerRouter, "/me/handovers", "get");
  const ownerRows = await call(list, authRequest(owner));
  const otherRows = await call(list, authRequest(other));
  assert.equal((ownerRows.body as unknown[]).length, 1);
  assert.equal((otherRows.body as unknown[]).length, 0);

  const detail = handler(advisorRouter, "/advisor/handovers/:id", "get");
  const notAssigned = await call(detail, authRequest(owner, {}, { id: handoverId }));
  assert.equal(notAssigned.statusCode, 404);
  const assign = handler(advisorRouter, "/advisor/handovers/:id/assign", "post");
  const assigned = await call(assign, authRequest(owner, {}, { id: handoverId }));
  assert.equal(assigned.statusCode, 200);
  const cannotReassign = await call(assign, authRequest(other, {}, { id: handoverId }));
  assert.equal(cannotReassign.statusCode, 409);
  const privateDetail = await call(detail, authRequest(owner, {}, { id: handoverId }));
  assert.equal(privateDetail.statusCode, 200);
  assert.equal((privateDetail.body as any).context.destination, "Lisbon");
  assert.equal((privateDetail.body as any).transcript.length, 2);
  assert.equal((privateDetail.body as any).context.recommendationOptions[0].id, "trusted-rail-option");
  assert.equal((privateDetail.body as any).context.recommendationSelectionStatus, "explicit_selection");
  const otherAdvisorDetail = await call(detail, authRequest(other, {}, { id: handoverId }));
  assert.equal(otherAdvisorDetail.statusCode, 404);
});

test("advisor lifecycle uses atomic transitions, assignee enforcement, and 404/409 distinction", async () => {
  const advisor = `route-advisor-${Date.now()}`;
  const wrongAdvisor = `${advisor}-wrong`;
  const [trip] = await db.insert(savedTripsTable).values({ userId: advisor, title: "Lifecycle route trip", destination: "Porto" }).returning();
  tripIds.push(trip.id);
  const handoverId = `route-lifecycle-${Date.now()}`;
  ids.push(handoverId);
  await db.insert(advisorHandoversTable).values({ handoverId, userId: advisor, savedTripId: trip.id, status: "requested", summary: "Porto", privacyContext: {}, notificationStatus: "pending" });
  const assign = handler(advisorRouter, "/advisor/handovers/:id/assign", "post");
  const reply = handler(advisorRouter, "/advisor/handovers/:id/reply", "post");
  const close = handler(advisorRouter, "/advisor/handovers/:id/close", "post");
  const assigned = await call(assign, authRequest(advisor, { advisorName: "Advisor" }, { id: handoverId }));
  assert.equal(assigned.statusCode, 200);
  const wrongReply = await call(reply, authRequest(wrongAdvisor, { reply: "Hello" }, { id: handoverId }));
  assert.equal(wrongReply.statusCode, 409);
  const replied = await call(reply, authRequest(advisor, { reply: "Hello" }, { id: handoverId }));
  assert.equal(replied.statusCode, 200);
  const repeatedReply = await call(reply, authRequest(advisor, { reply: "Again" }, { id: handoverId }));
  assert.equal(repeatedReply.statusCode, 409);
  const closed = await call(close, authRequest(advisor, {}, { id: handoverId }));
  assert.equal(closed.statusCode, 200);
  const repeatedClose = await call(close, authRequest(advisor, {}, { id: handoverId }));
  assert.equal(repeatedClose.statusCode, 409);
  const missing = await call(close, authRequest(advisor, {}, { id: "does-not-exist" }));
  assert.equal(missing.statusCode, 404);
});

test("advisor lifecycle routes retain mandatory RBAC middleware", () => {
  for (const path of ["/advisor/handovers", "/advisor/handovers/:id", "/advisor/handovers/:id/assign", "/advisor/handovers/:id/reply", "/advisor/handovers/:id/close"]) {
    const layer = (advisorRouter as any).stack.find((item: any) => item.route?.path === path);
    assert.ok(layer, `route ${path} exists`);
    assert.equal(layer.route.stack[0].name, "requireAdvisor");
  }
});

after(async () => {
  if (ids.length) await db.delete(advisorHandoversTable).where(inArray(advisorHandoversTable.handoverId, ids));
  if (tripIds.length) await db.delete(savedTripsTable).where(inArray(savedTripsTable.id, tripIds));
  if (conversationIds.length) await db.delete(conversationsTable).where(inArray(conversationsTable.sessionId, conversationIds));
});