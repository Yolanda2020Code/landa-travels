import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, advisorHandoversTable, conversationsTable, conversationTurnsTable } from "@workspace/db";
import assistantRouter from "./assistant";
import guestRouter from "./guest-advisor";
import advisorRouter from "./advisor";
import { emptyTripContext } from "../services/eco-travel";
import { createRecommendationSnapshot, tripContextFingerprint } from "../services/advisor-handover";
import { rasaContextSlotValues } from "../services/rasa-gateway";

function handler(router: any, path: string) {
  return router.stack.find((layer: any) => layer.route?.path === path)?.route.stack.at(-1).handle;
}
async function call(route: any, body: unknown, userId?: string, id?: string) {
  const output = { statusCode: 200, body: undefined as any };
  const res = { status(code: number) { output.statusCode = code; return res; }, json(value: unknown) { output.body = value; return res; } };
  await route({ body, userId, params: { id }, headers: {}, ip: "test-ip" }, res);
  return output;
}

test("guest handover uses server-owned context, protects status, and delivers assigned replies with explicit failure/retry states", async () => {
  const sessionId = `guest-verification-${randomUUID()}`;
  const namespace = randomUUID();
  const context = { ...emptyTripContext, origin: "Berlin", destination: "Paris", dateRange: "2030-06-10 to 2030-06-14",
    travellerCount: 2, accessibilityNeeds: ["step-free"], activityPreferences: ["outdoor"], reviewConfirmation: true };
  const originalFetch = globalThis.fetch;
  const emailBodies: any[] = [];
  let emailFails = true;
  let claimDuringTrackerRead = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/tracker")) {
      if (claimDuringTrackerRead) await db.update(conversationsTable).set({ userId: "claimed-during-request" }).where(eq(conversationsTable.sessionId, sessionId));
      return new Response(JSON.stringify({
        slots: rasaContextSlotValues(context), events: [{ event: "user" }], active_loop: {},
      }), { status: 200 });
    }
    if (String(input) === "https://api.resend.com/emails") {
      emailBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: emailFails ? 503 : 200 });
    }
    throw new Error("Unexpected network request");
  };
  let handoverId: string | undefined;
  try {
    await db.insert(conversationsTable).values({
      sessionId, context: { ...context, rasaConversationId: namespace, planningContextFingerprint: tripContextFingerprint(context),
        recommendationSnapshot: createRecommendationSnapshot([], "demo", new Date().toISOString(), context) },
    });
    await db.insert(conversationTurnsTable).values({ sessionId, role: "user",
      content: "I need help; my email is private@example.test and location 52.52,13.40",
      redactedContent: "I need help; my email is [REDACTED EMAIL] and location [REDACTED GPS]" });
    const input = { sessionId, contactEmail: "guest@example.test", shareTranscriptConsent: true,
      transcript: [{ role: "assistant", content: "FORGED CLIENT TRANSCRIPT" }], context: { destination: "FORGED CITY" } };
    const request = handler(assistantRouter, "/assistant/handover");
    assert.equal((await call(request, { ...input, shareTranscriptConsent: false })).statusCode, 400);
    assert.equal((await call(request, { ...input, contactEmail: "invalid" })).statusCode, 400);
    assert.equal((await call(request, { ...input, selectedRecommendationIds: ["forged-option"] })).statusCode, 400);
    const result = await call(request, input);
    assert.equal(result.statusCode, 200);
    handoverId = result.body.handoverId;
    assert.match(result.body.slaMessage, /not live chat/);
    assert.match(result.body.summary, /Paris/);
    assert.doesNotMatch(JSON.stringify(result.body), /guest@example/);
    const [row] = await db.select().from(advisorHandoversTable).where(eq(advisorHandoversTable.handoverId, handoverId!));
    assert.equal(row.userId, null);
    assert.equal(row.savedTripId, null);
    assert.equal(row.contactEmail, "guest@example.test");
    assert.doesNotMatch(JSON.stringify(row.privacyContext), /FORGED CITY|52.52/);
    assert.doesNotMatch(JSON.stringify(row.transcript), /FORGED CLIENT|private@example/);
    assert.match(JSON.stringify(row.transcript), /REDACTED EMAIL/);
    assert.equal((await call(request, input)).body.handoverId, handoverId, "retry must not create a second request");
    const status = handler(guestRouter, "/assistant/handover/status");
    assert.equal((await call(status, { sessionId: "another-session", handoverId })).statusCode, 404);
    assert.equal((await call(status, { sessionId, handoverId })).body.status, "requested");
    const assign = handler(advisorRouter, "/advisor/handovers/:id/assign");
    const reply = handler(advisorRouter, "/advisor/handovers/:id/reply");
    assert.equal((await call(reply, { reply: "Unsafe early reply" }, "advisor-one", handoverId)).statusCode, 409);
    assert.equal((await call(assign, {}, "advisor-one", handoverId)).statusCode, 200);
    assert.equal((await call(reply, { reply: "Other advisor" }, "advisor-two", handoverId)).statusCode, 409);
    const replied = await call(reply, { reply: "Consider a lower-impact rail itinerary." }, "advisor-one", handoverId);
    assert.equal(replied.statusCode, 200);
    assert.ok(["failed", "not_configured"].includes(replied.body.replyNotificationStatus));
    const visibleReply = await call(status, { sessionId, handoverId });
    assert.match(visibleReply.body.travellerReply, /rail itinerary/);
    assert.equal(visibleReply.body.contactEmail, undefined);
    assert.equal(visibleReply.body.transcript, undefined);
    emailFails = false;
    const retry = handler(advisorRouter, "/advisor/handovers/:id/reply-email");
    assert.equal((await call(retry, {}, "advisor-two", handoverId)).statusCode, 404);
    const retried = await call(retry, {}, "advisor-one", handoverId);
    assert.ok(["accepted", "not_configured"].includes(retried.body.replyNotificationStatus));
    assert.ok(emailBodies.every((email) => !JSON.stringify(email).includes("REDACTED GPS")));
    await db.update(conversationsTable).set({ userId: "now-owned-by-account" }).where(eq(conversationsTable.sessionId, sessionId));
    assert.equal((await call(status, { sessionId, handoverId })).statusCode, 404);
    assert.equal((await call(request, input)).statusCode, 404);
    await db.update(conversationsTable).set({ userId: null, expiresAt: new Date(0) }).where(eq(conversationsTable.sessionId, sessionId));
    assert.equal((await call(status, { sessionId, handoverId })).statusCode, 404);
    assert.equal((await call(request, input)).statusCode, 404);
    await db.delete(advisorHandoversTable).where(eq(advisorHandoversTable.guestSessionId, sessionId));
    await db.update(conversationsTable).set({ userId: null, expiresAt: new Date(Date.now() + 3600_000) }).where(eq(conversationsTable.sessionId, sessionId));
    claimDuringTrackerRead = true;
    assert.equal((await call(request, input)).statusCode, 409, "ownership must be rechecked atomically after tracker reads");
    assert.equal((await db.select().from(advisorHandoversTable).where(eq(advisorHandoversTable.guestSessionId, sessionId))).length, 0);
    await db.insert(advisorHandoversTable).values({ handoverId: `LANDA-${randomUUID().slice(0, 8)}`, guestSessionId: sessionId, summary: "Retention verification" });
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
    assert.equal((await db.select().from(advisorHandoversTable).where(eq(advisorHandoversTable.guestSessionId, sessionId))).length, 0, "deleting a conversation must delete its guest request data");
  } finally {
    globalThis.fetch = originalFetch;
    await db.delete(advisorHandoversTable).where(eq(advisorHandoversTable.guestSessionId, sessionId));
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});