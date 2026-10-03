import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import {
  advisorHandoversTable,
  bookingRecordsTable,
  db,
  conversationsTable,
  rewardEventsTable,
  savedTripsTable,
  travellerProfilesTable,
} from "@workspace/db";
import travellerRouter from "./traveller";
import assistantRouter from "./assistant";
import { tripContextFingerprint } from "../services/advisor-handover";

type ResponseStub = {
  statusCode: number;
  body: unknown;
  status: (code: number) => ResponseStub;
  json: (body: unknown) => ResponseStub;
};

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

function routeLayer(path: string, method: string) {
  const layer = (travellerRouter as any).stack.find(
    (item: any) => item.route?.path === path && item.route.methods[method],
  );
  assert.ok(layer, `route ${method.toUpperCase()} ${path} exists`);
  return layer.route;
}

function handler(path: string, method: string) {
  return routeLayer(path, method).stack.at(-1).handle;
}

async function call(
  route: any,
  userId: string,
  body: unknown = {},
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const res = response();
  await route({ userId, body, params, headers }, res);
  return res;
}

const userIds = [
  `clerk-test-user-a-${Date.now()}`,
  `clerk-test-user-b-${Date.now()}`,
];
const tripIds: number[] = [];
const bookingIds: number[] = [];
const conversationIds: string[] = [];
const handoverIds: string[] = [];

test("two Clerk users can only create, list, update, archive, and book their own trips", async () => {
  const createTrip = handler("/trips", "post");
  const listTrips = handler("/trips", "get");
  const updateTrip = handler("/trips/:id", "patch");
  const createBooking = handler("/bookings", "post");
  const listBookings = handler("/bookings", "get");

  const created = await Promise.all(userIds.map((userId, index) =>
    call(createTrip, userId, {
      title: `Private trip ${index + 1}`,
      destination: index === 0 ? "Lisbon" : "Oslo",
    }),
  ));
  for (const result of created) {
    assert.equal(result.statusCode, 201);
    tripIds.push((result.body as { id: number }).id);
  }

  for (let index = 0; index < userIds.length; index += 1) {
    const ownTrips = await call(listTrips, userIds[index]);
    assert.deepEqual(
      (ownTrips.body as Array<{ id: number }>).map(({ id }) => id),
      [tripIds[index]],
    );

    const updated = await call(
      updateTrip,
      userIds[index],
      { title: `Updated private trip ${index + 1}`, status: "ready" },
      { id: String(tripIds[index]) },
    );
    assert.equal(updated.statusCode, 200);
    assert.equal((updated.body as { status: string }).status, "ready");

    const archived = await call(
      updateTrip,
      userIds[index],
      { title: `Updated private trip ${index + 1}`, status: "archived" },
      { id: String(tripIds[index]) },
    );
    assert.equal(archived.statusCode, 200);
    assert.equal((archived.body as { status: string }).status, "archived");

    const booking = await call(createBooking, userIds[index], {
      tripId: tripIds[index],
      label: `Private booking ${index + 1}`,
      bookingType: "stay",
    });
    assert.equal(booking.statusCode, 201);
    bookingIds.push((booking.body as { id: number }).id);

    const ownBookings = await call(listBookings, userIds[index]);
    assert.deepEqual(
      (ownBookings.body as Array<{ id: number }>).map(({ id }) => id),
      [bookingIds[index]],
    );
  }

  const crossUserUpdate = await call(
    updateTrip,
    userIds[0],
    { title: "Unauthorized change", status: "ready" },
    { id: String(tripIds[1]) },
  );
  assert.equal(crossUserUpdate.statusCode, 404);

  const crossUserBooking = await call(createBooking, userIds[0], {
    tripId: tripIds[1],
    label: "Unauthorized booking",
    bookingType: "transport",
  });
  assert.equal(crossUserBooking.statusCode, 404);
});

test("trip save binds conversation ownership and copies only server-generated recommendation metadata", async () => {
  const sessionId = `trusted-snapshot-${Date.now()}`;
  conversationIds.push(sessionId);
  const serverRecommendation = {
    id: "server-generated-option",
    type: "transport",
    name: "Train",
    location: "Berlin to Lisbon",
    description: "Current option",
    price: "€120 indicative",
    carbonKg: 18,
    carbonLabel: "low",
    score: 90,
    certification: null,
    source: "provider",
    verifiedAt: "2026-06-15T12:00:00.000Z",
    tags: ["rail"],
    durationMinutes: 300,
    connectionCount: 1,
    rankingExplanation: "Best overall balance.",
  };
  await db.insert(conversationsTable).values({
    sessionId,
    userId: null,
    context: {
      destination: "Lisbon",
      activityPreferences: ["museum"],
      recommendationSnapshot: {
        confirmedAt: "2026-06-15T12:00:00.000Z",
        source: "live",
        recommendations: [serverRecommendation],
        unknowns: ["Availability is unconfirmed."],
        contextFingerprint: tripContextFingerprint({
          origin: null,
          destination: "Lisbon",
          dateRange: null,
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
  const createTrip = handler("/trips", "post");
  const saved = await call(createTrip, userIds[0], {
    title: "Trusted recommendation trip",
    destination: "Lisbon",
    context: {
      activityPreferences: ["museum"],
      recommendationSnapshot: { source: "demo", recommendations: [{ id: "forged" }] },
    },
  }, {}, { "x-conversation-session": sessionId });
  assert.equal(saved.statusCode, 201);
  const savedTrip = saved.body as { id: number; context: Record<string, any>; conversationSessionId?: string };
  tripIds.push(savedTrip.id);
  assert.equal(savedTrip.context.recommendationSnapshot.recommendations[0].id, "server-generated-option");
  assert.equal(savedTrip.context.recommendationSnapshot.recommendations[0].durationMinutes, 300);
  assert.equal(savedTrip.context.recommendationSnapshot.recommendations[0].connectionCount, 1);
  assert.deepEqual(savedTrip.context.activityPreferences, ["museum"]);
  const [boundConversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.sessionId, sessionId)).limit(1);
  assert.equal(boundConversation.userId, userIds[0]);
  const updateTrip = handler("/trips/:id", "patch");
  const changedPlan = await call(updateTrip, userIds[0], {
    title: "Changed destination",
    destination: "Oslo",
    context: { destination: "Oslo" },
  }, { id: String(savedTrip.id) });
  assert.equal(changedPlan.statusCode, 200);
  assert.equal("recommendationSnapshot" in ((changedPlan.body as { context: Record<string, unknown> }).context), false);

  const foreignAttempt = await call(createTrip, userIds[1], {
    title: "Attempt to reuse another traveller's session",
    context: {
      recommendationSnapshot: { source: "live", recommendations: [{ id: "forged-by-other" }] },
    },
  }, {}, { "x-conversation-session": sessionId });
  assert.equal(foreignAttempt.statusCode, 201);
  const foreignTrip = foreignAttempt.body as { id: number; context: Record<string, unknown> };
  tripIds.push(foreignTrip.id);
  assert.equal("recommendationSnapshot" in foreignTrip.context, false);
  assert.equal((foreignTrip as any).conversationSessionId, undefined);
});

test("trip PATCH rebinds to an explicit fresh conversation and exposes its snapshot to handover", async () => {
  const owner = `fresh-session-owner-${Date.now()}`;
  const oldSessionId = `old-planner-session-${Date.now()}`;
  const freshSessionId = `fresh-planner-session-${Date.now()}`;
  conversationIds.push(oldSessionId, freshSessionId);
  const confirmedAt = "2026-06-15T12:00:00.000Z";
  const snapshotContext = {
    origin: null,
    destination: "Lisbon",
    dateRange: null,
    travellerCount: null,
    budget: null,
    transportPreferences: [],
    accommodationNeeds: [],
    activityPreferences: ["museum"],
    sustainabilityPriority: null,
    stopovers: [],
    accessibilityNeeds: [],
    locationConsentMode: null,
  };
  const snapshot = (recommendationId: string) => ({
    confirmedAt,
    source: "live",
    recommendations: [{
      id: recommendationId,
      type: "transport",
      name: "Confirmed train",
      location: "Berlin to Lisbon",
      description: "Indicative rail itinerary",
      price: "€120 indicative",
      carbonKg: 18,
      carbonLabel: "low",
      score: 90,
      certification: null,
      source: "provider",
      verifiedAt: confirmedAt,
      tags: ["rail"],
    }],
    unknowns: ["Availability and final price require provider confirmation."],
    contextFingerprint: tripContextFingerprint(snapshotContext),
  });
  await db.insert(conversationsTable).values([
    {
      sessionId: oldSessionId,
      userId: owner,
      context: { recommendationSnapshot: snapshot("old-session-option") },
    },
    {
      sessionId: freshSessionId,
      userId: null,
      context: { recommendationSnapshot: snapshot("fresh-session-option") },
    },
  ]);
  const [trip] = await db.insert(savedTripsTable).values({
    userId: owner,
    title: "Trip before fresh planner session",
    destination: "Lisbon",
    conversationSessionId: oldSessionId,
    context: { activityPreferences: ["museum"], recommendationSnapshot: snapshot("old-session-option") },
  }).returning();
  tripIds.push(trip.id);

  const updateTrip = handler("/trips/:id", "patch");
  const updated = await call(
    updateTrip,
    owner,
    {
      title: "Trip after fresh planner session",
      destination: "Lisbon",
      context: { destination: "Lisbon", activityPreferences: ["museum"] },
    },
    { id: String(trip.id) },
    { "x-conversation-session": freshSessionId },
  );
  assert.equal(updated.statusCode, 200);
  const [updatedTrip] = await db.select().from(savedTripsTable)
    .where(eq(savedTripsTable.id, trip.id)).limit(1);
  assert.equal(updatedTrip.conversationSessionId, freshSessionId);
  assert.equal((updatedTrip.context as Record<string, any>).recommendationSnapshot.recommendations[0].id, "fresh-session-option");
  const [freshConversation] = await db.select().from(conversationsTable)
    .where(eq(conversationsTable.sessionId, freshSessionId)).limit(1);
  assert.equal(freshConversation.userId, owner);

  const handoverLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/handover" && item.route.methods.post,
  );
  assert.ok(handoverLayer, "POST /assistant/handover exists");
  const previousResendApiKey = process.env.RESEND_API_KEY;
  const previousRecruitmentEmail = process.env.RECRUITMENT_NOTIFICATION_EMAIL;
  process.env.RESEND_API_KEY = "";
  process.env.RECRUITMENT_NOTIFICATION_EMAIL = "";
  try {
    const handover = await call(
      handoverLayer.route.stack.at(-1).handle,
      owner,
      {
        savedTripId: trip.id,
        shareTranscriptConsent: true,
        transcript: [{ role: "user", content: "Please help with this confirmed trip." }],
        selectedRecommendationIds: ["fresh-session-option"],
      },
    );
    assert.equal(handover.statusCode, 200);
    handoverIds.push((handover.body as { handoverId: string }).handoverId);
  } finally {
    if (previousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendApiKey;
    if (previousRecruitmentEmail === undefined) delete process.env.RECRUITMENT_NOTIFICATION_EMAIL;
    else process.env.RECRUITMENT_NOTIFICATION_EMAIL = previousRecruitmentEmail;
  }
});

test("trip PATCH rejects an explicit missing or foreign conversation instead of retaining its old link", async () => {
  const owner = `replacement-owner-${Date.now()}`;
  const foreignOwner = `replacement-foreign-owner-${Date.now()}`;
  const oldSessionId = `replacement-old-session-${Date.now()}`;
  const foreignSessionId = `replacement-foreign-session-${Date.now()}`;
  const missingSessionId = `replacement-missing-session-${Date.now()}`;
  conversationIds.push(oldSessionId, foreignSessionId);
  await db.insert(conversationsTable).values([
    { sessionId: oldSessionId, userId: owner, context: {} },
    { sessionId: foreignSessionId, userId: foreignOwner, context: {} },
  ]);
  const [trip] = await db.insert(savedTripsTable).values({
    userId: owner,
    title: "Keep current association",
    destination: "Lisbon",
    conversationSessionId: oldSessionId,
    context: { activityPreferences: ["museum"] },
  }).returning();
  tripIds.push(trip.id);
  const updateTrip = handler("/trips/:id", "patch");

  for (const sessionId of [foreignSessionId, missingSessionId]) {
    const rejected = await call(updateTrip, owner, {
      title: "Must not silently keep old context",
      destination: "Lisbon",
      context: { destination: "Lisbon", activityPreferences: ["museum"] },
    }, { id: String(trip.id) }, { "x-conversation-session": sessionId });
    assert.equal(rejected.statusCode, 403);
  }

  const [unchangedTrip] = await db.select().from(savedTripsTable)
    .where(eq(savedTripsTable.id, trip.id)).limit(1);
  assert.equal(unchangedTrip.title, "Keep current association");
  assert.equal(unchangedTrip.conversationSessionId, oldSessionId);
});

test("profile, trip, booking, reward, and traveller advisor routes require authentication", () => {
  const protectedRoutes = [
    ["get", "/me/profile"],
    ["patch", "/me/profile"],
    ["get", "/trips"],
    ["post", "/trips"],
    ["patch", "/trips/:id"],
    ["get", "/bookings"],
    ["post", "/bookings"],
    ["get", "/rewards"],
    ["get", "/me/handovers"],
    ["get", "/me/handovers/:id"],
  ] as const;

  for (const [method, path] of protectedRoutes) {
    const route = routeLayer(path, method);
    assert.equal(
      route.stack[0]?.name,
      "requireAuth",
      `${method.toUpperCase()} ${path} rejects signed-out requests`,
    );
  }
});

after(async () => {
  if (handoverIds.length) {
    await db.delete(advisorHandoversTable).where(inArray(advisorHandoversTable.handoverId, handoverIds));
  }
  if (bookingIds.length) {
    await db.delete(bookingRecordsTable).where(inArray(bookingRecordsTable.id, bookingIds));
  }
  if (tripIds.length) {
    await db.delete(savedTripsTable).where(inArray(savedTripsTable.id, tripIds));
  }
  if (conversationIds.length) {
    await db.delete(conversationsTable).where(inArray(conversationsTable.sessionId, conversationIds));
  }
  await db.delete(rewardEventsTable).where(inArray(rewardEventsTable.userId, userIds));
  await db.delete(travellerProfilesTable).where(inArray(travellerProfilesTable.userId, userIds));
});