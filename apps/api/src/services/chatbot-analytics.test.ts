import test from "node:test";
import assert from "node:assert/strict";
import { rate, sampleState } from "./chatbot-aggregate";
import { derivedOutcome, retentionCutoffs, safeEventPayload } from "./chatbot-retention-helpers";
import { CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS, createChatbotRetentionMaintenanceRunner } from "./chatbot-retention";
import { canUseConversationCorrelation } from "./conversation-correlation";
import { db, chatbotEventsTable, conversationsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { aggregateChatbotFailures, aggregateChatbotOverview } from "./chatbot-admin-aggregates";

test("aggregate metrics expose insufficient sample state", () => {
  assert.equal(sampleState(4), "insufficient_sample");
  assert.equal(sampleState(5), "ready");
  assert.deepEqual(rate(2, 4), { value: 0.5, numerator: 2, denominator: 4, sampleSize: 4, state: "insufficient_sample" });
});

test("conversion denominators and privacy projection preserve dashboard semantics", () => {
  assert.equal(rate(2, 4).denominator, 4);
  assert.equal(derivedOutcome("completion"), "completion");
  assert.equal(derivedOutcome("error"), undefined);
  assert.deepEqual(safeEventPayload({ intent: "inform", token: "secret", message: "private" }), { intent: "inform" });
});

test("retention cutoffs are 30 days for telemetry and 90 for audits", () => {
  const now = new Date("2025-01-31T00:00:00.000Z");
  const cutoffs = retentionCutoffs(now);
  assert.equal(cutoffs.telemetry.toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(cutoffs.audit.toISOString(), "2024-11-02T00:00:00.000Z");
});

test("retention maintenance coalesces, observes its TTL, and logs failures before retrying", async () => {
  let now = 100;
  let cleanupCalls = 0;
  let shouldFail = false;
  const loggedFailures: unknown[] = [];
  const run = createChatbotRetentionMaintenanceRunner(
    async () => {
      cleanupCalls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error("maintenance failed");
      }
    },
    (error) => loggedFailures.push(error),
    () => now,
    CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS,
  );

  const firstRun = run();
  const overlappingRun = run();
  assert.equal(firstRun, overlappingRun);
  await Promise.all([firstRun, overlappingRun]);
  assert.equal(cleanupCalls, 1);

  now += CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS - 1;
  await run();
  assert.equal(cleanupCalls, 1);

  now += 1;
  shouldFail = true;
  await run();
  assert.equal(cleanupCalls, 2);
  assert.equal(loggedFailures.length, 1);

  await run();
  assert.equal(cleanupCalls, 3, "a failed cleanup does not advance the success TTL");
  await run();
  assert.equal(cleanupCalls, 3);
});

test("conversation correlation stays isolated across users and journeys", () => {
  assert.equal(canUseConversationCorrelation({ userId: null }, "traveller-a"), true);
  assert.equal(canUseConversationCorrelation({ userId: "traveller-a" }, "traveller-a"), true);
  assert.equal(canUseConversationCorrelation({ userId: "traveller-a" }, "traveller-b"), false);
  assert.equal(canUseConversationCorrelation(undefined, "traveller-a"), false);
});

test("database telemetry aggregates preserve session denominators and supported cohorts", async () => {
  const suffix = `integration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sessions = [`${suffix}-complete`, `${suffix}-failure`];
  const eventIds = [`${suffix}-completion`, `${suffix}-fallback`, `${suffix}-repeat`, `${suffix}-confusion`];
  try {
    await db.insert(conversationsTable).values(sessions.map((sessionId) => ({
      sessionId,
      context: {},
      updatedAt: new Date(),
    })));
    await db.insert(chatbotEventsTable).values([
      { eventId: eventIds[0], sessionId: sessions[0], eventType: "completion", source: "demo", payload: {} },
      { eventId: eventIds[1], sessionId: sessions[1], eventType: "fallback", source: "demo", payload: {} },
      { eventId: eventIds[2], sessionId: sessions[1], eventType: "repeated_prompt", source: "demo", payload: { evidence: "consecutive_identical_assistant_prompt" } },
      { eventId: eventIds[3], sessionId: sessions[1], eventType: "source_destination_confusion", source: "demo", payload: { evidence: "normalized_source_equals_destination" } },
    ]);
    const overview = await aggregateChatbotOverview(undefined, undefined, sessions);
    assert.equal(Number(overview.sessions), 2);
    assert.equal(Number(overview.completed), 1);
    assert.equal(Number(overview.fallback), 1);
    const cohorts = await aggregateChatbotFailures(undefined, undefined, sessions);
    assert.deepEqual(
      new Map(cohorts.map((cohort) => [cohort.cohort, Number(cohort.count)])),
      new Map([["high-fallback", 1], ["repeated-prompt", 1], ["source-destination-confusion", 1]]),
    );
  } finally {
    await db.delete(chatbotEventsTable).where(inArray(chatbotEventsTable.eventId, eventIds));
    await db.delete(conversationsTable).where(inArray(conversationsTable.sessionId, sessions));
  }
});