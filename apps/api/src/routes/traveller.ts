import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, travellerProfilesTable, savedTripsTable, bookingRecordsTable, rewardEventsTable, contactRequestsTable, advisorHandoversTable, conversationsTable } from "@workspace/db";
import {
  CreateBookingBody, CreateBookingResponse, CreateSavedTripBody, CreateSavedTripResponse,
  GetCurrentProfileResponse, GetRewardSummaryResponse, ListBookingsResponse, ListSavedTripsResponse,
  SubmitContactRequestBody, SubmitContactRequestResponse, UpdateCurrentProfileBody, UpdateCurrentProfileResponse,
  UpdateSavedTripBody, UpdateSavedTripParams, UpdateSavedTripResponse,
  GetMyHandoverParams, GetMyHandoverResponse, ListMyHandoversResponse,
} from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { conversationSessionHeader, recordChatbotEvent } from "../services/chatbot-analytics";
import { validateAndBindConversation } from "../services/conversation-correlation";
import {
  recommendationSnapshotFromUnknown,
  recommendationSnapshotMatchesContext,
} from "../services/advisor-handover";
import type { TripContext } from "@workspace/api-zod";

const router: IRouter = Router();
const user = (req: AuthenticatedRequest) => req.userId;
const effectiveTripField = <T extends string | number>(
  inputValue: T | null | undefined,
  existingValue: T | null | undefined,
  contextValue: unknown,
): T | null => {
  if (inputValue !== undefined && inputValue !== null) return inputValue;
  if (inputValue === null) return (contextValue as T | null | undefined) ?? null;
  return existingValue ?? (contextValue as T | null | undefined) ?? null;
};

async function serverOwnedTripContext(
  context: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  userId: string,
  tripFields: {
    origin?: string | null;
    destination?: string | null;
    dateRange?: string | null;
    travellerCount?: number | null;
    budget?: string | null;
    sustainabilityPriority?: string | null;
  },
): Promise<Record<string, unknown>> {
  const { recommendationSnapshot: _untrustedSnapshot, ...travellerContext } = context ?? {};
  if (!sessionId) return travellerContext;
  const [conversation] = await db.select({ context: conversationsTable.context })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.sessionId, sessionId),
      eq(conversationsTable.userId, userId),
    )).limit(1);
  if (!conversation) return travellerContext;
  const storedContext = conversation.context !== null && typeof conversation.context === "object"
    ? conversation.context as Record<string, unknown>
    : {};
  const snapshot = recommendationSnapshotFromUnknown(storedContext.recommendationSnapshot);
  const candidateContext = {
    ...travellerContext,
    origin: tripFields.origin ?? travellerContext.origin,
    destination: tripFields.destination ?? travellerContext.destination,
    dateRange: tripFields.dateRange ?? travellerContext.dateRange,
    travellerCount: tripFields.travellerCount ?? travellerContext.travellerCount,
    budget: tripFields.budget ?? travellerContext.budget,
    sustainabilityPriority: tripFields.sustainabilityPriority ?? travellerContext.sustainabilityPriority,
  } as Partial<TripContext>;
  return snapshot && recommendationSnapshotMatchesContext(snapshot, candidateContext)
    ? { ...travellerContext, recommendationSnapshot: snapshot }
    : travellerContext;
}

router.get("/me/profile", requireAuth, async (req, res): Promise<void> => {
  const request = req as AuthenticatedRequest;
  let [profile] = await db.select().from(travellerProfilesTable).where(eq(travellerProfilesTable.userId, user(request))).limit(1);
  if (!profile) {
    [profile] = await db.insert(travellerProfilesTable).values({ userId: user(request) }).returning();
  }
  res.json(GetCurrentProfileResponse.parse(profile));
});

router.patch("/me/profile", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateCurrentProfileBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const request = req as AuthenticatedRequest;
  const [profile] = await db.insert(travellerProfilesTable).values({ userId: user(request), ...parsed.data })
    .onConflictDoUpdate({ target: travellerProfilesTable.userId, set: { ...parsed.data, updatedAt: new Date() } }).returning();
  res.json(UpdateCurrentProfileResponse.parse(profile));
});

router.get("/trips", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(savedTripsTable).where(eq(savedTripsTable.userId, user(req as AuthenticatedRequest))).orderBy(desc(savedTripsTable.updatedAt));
  res.json(ListSavedTripsResponse.parse(rows));
});

router.get("/me/handovers", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(advisorHandoversTable)
    .where(eq(advisorHandoversTable.userId, user(req as AuthenticatedRequest)))
    .orderBy(desc(advisorHandoversTable.createdAt));
  res.json(ListMyHandoversResponse.parse(rows));
});

router.get("/me/handovers/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetMyHandoverParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid handover reference." }); return; }
  const [row] = await db.select().from(advisorHandoversTable).where(and(
    eq(advisorHandoversTable.handoverId, params.data.id),
    eq(advisorHandoversTable.userId, user(req as AuthenticatedRequest)),
  )).limit(1);
  if (!row) { res.status(404).json({ error: "Handover not found." }); return; }
  res.json(GetMyHandoverResponse.parse(row));
});

router.post("/trips", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateSavedTripBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const sessionId = conversationSessionHeader(req.headers["x-conversation-session"]);
  const userId = user(req as AuthenticatedRequest);
  const validatedSessionId = await validateAndBindConversation(sessionId, userId);
  const context = await serverOwnedTripContext(parsed.data.context, validatedSessionId, userId, parsed.data);
  const [trip] = await db.insert(savedTripsTable).values({
    userId, ...parsed.data, context, conversationSessionId: validatedSessionId,
  }).returning();
  if (validatedSessionId) await recordChatbotEvent({ sessionId: validatedSessionId, eventType: "save", payload: { tripId: trip.id, source: "demo" } });
  res.status(201).json(CreateSavedTripResponse.parse(trip));
});

router.patch("/trips/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateSavedTripParams.safeParse(req.params);
  const parsed = UpdateSavedTripBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid trip update." }); return; }
  const userId = user(req as AuthenticatedRequest);
  const [existing] = await db.select({
    id: savedTripsTable.id,
    conversationSessionId: savedTripsTable.conversationSessionId,
    origin: savedTripsTable.origin,
    destination: savedTripsTable.destination,
    dateRange: savedTripsTable.dateRange,
    travellerCount: savedTripsTable.travellerCount,
    budget: savedTripsTable.budget,
    sustainabilityPriority: savedTripsTable.sustainabilityPriority,
    context: savedTripsTable.context,
  }).from(savedTripsTable).where(and(
    eq(savedTripsTable.id, params.data.id),
    eq(savedTripsTable.userId, userId),
  )).limit(1);
  if (!existing) { res.status(404).json({ error: "Saved trip not found." }); return; }
  const rawHeaderSessionId = req.headers["x-conversation-session"];
  const hasExplicitSessionHeader = rawHeaderSessionId !== undefined;
  const headerSessionId = conversationSessionHeader(rawHeaderSessionId);
  if (hasExplicitSessionHeader && !headerSessionId) {
    res.status(400).json({ error: "The assistant conversation reference is invalid." });
    return;
  }
  const requestedSessionId = hasExplicitSessionHeader
    ? headerSessionId
    : existing.conversationSessionId ?? undefined;
  const validatedSessionId = requestedSessionId
    ? await validateAndBindConversation(requestedSessionId, userId)
    : undefined;
  if (requestedSessionId && !validatedSessionId) {
    res.status(403).json({ error: "The assistant conversation is not available to this traveller." });
    return;
  }
  const existingContext = existing.context !== null && typeof existing.context === "object" && !Array.isArray(existing.context)
    ? existing.context as Record<string, unknown>
    : {};
  const context = await serverOwnedTripContext(parsed.data.context ?? existingContext, validatedSessionId, userId, {
    origin: effectiveTripField(parsed.data.origin, existing.origin, parsed.data.context?.origin),
    destination: effectiveTripField(parsed.data.destination, existing.destination, parsed.data.context?.destination),
    dateRange: effectiveTripField(parsed.data.dateRange, existing.dateRange, parsed.data.context?.dateRange),
    travellerCount: effectiveTripField(parsed.data.travellerCount, existing.travellerCount, parsed.data.context?.travellerCount),
    budget: effectiveTripField(parsed.data.budget, existing.budget, parsed.data.context?.budget),
    sustainabilityPriority: effectiveTripField(parsed.data.sustainabilityPriority, existing.sustainabilityPriority, parsed.data.context?.sustainabilityPriority),
  });
  const [trip] = await db.update(savedTripsTable).set({
    ...parsed.data,
    context,
    conversationSessionId: validatedSessionId ?? null,
    updatedAt: new Date(),
  }).where(and(eq(savedTripsTable.id, params.data.id), eq(savedTripsTable.userId, userId))).returning();
  if (!trip) { res.status(404).json({ error: "Saved trip not found." }); return; }
  res.json(UpdateSavedTripResponse.parse(trip));
});

router.get("/bookings", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(bookingRecordsTable).where(eq(bookingRecordsTable.userId, user(req as AuthenticatedRequest))).orderBy(desc(bookingRecordsTable.createdAt));
  res.json(ListBookingsResponse.parse(rows));
});

router.post("/bookings", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateBookingBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const userId = user(req as AuthenticatedRequest);
  let correlationSessionId: string | undefined;
  if (parsed.data.tripId != null) {
    const [ownedTrip] = await db.select({ id: savedTripsTable.id, conversationSessionId: savedTripsTable.conversationSessionId }).from(savedTripsTable)
      .where(and(eq(savedTripsTable.id, parsed.data.tripId), eq(savedTripsTable.userId, userId))).limit(1);
    if (!ownedTrip) { res.status(404).json({ error: "Saved trip not found." }); return; }
    correlationSessionId = ownedTrip.conversationSessionId ?? undefined;
  }
  const [booking] = await db.insert(bookingRecordsTable).values({
    userId, ...parsed.data, status: "requested", source: "demo",
    providerReference: parsed.data.providerReference ?? null, carbonKg: parsed.data.carbonKg ?? null,
    details: parsed.data.details ?? {},
  }).returning();
  if (correlationSessionId) await recordChatbotEvent({ sessionId: correlationSessionId, eventType: "demo_booking_request", payload: { bookingId: booking.id, bookingType: booking.bookingType } });
  res.status(201).json(CreateBookingResponse.parse(booking));
});

router.get("/rewards", requireAuth, async (req, res): Promise<void> => {
  const events = await db.select().from(rewardEventsTable).where(eq(rewardEventsTable.userId, user(req as AuthenticatedRequest))).orderBy(desc(rewardEventsTable.createdAt));
  const totalPoints = events.reduce((sum, event) => sum + event.points, 0);
  const level = totalPoints >= 500 ? "Pathfinder" : totalPoints >= 200 ? "Wayfinder" : "First steps";
  const nextLevelPoints = totalPoints >= 500 ? 0 : totalPoints >= 200 ? 500 : 200;
  res.json(GetRewardSummaryResponse.parse({ totalPoints, level, nextLevelPoints, events }));
});

router.post("/contact", async (req, res): Promise<void> => {
  const parsed = SubmitContactRequestBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.consent) { res.status(400).json({ error: "Please provide valid details and consent." }); return; }
  const [request] = await db.insert(contactRequestsTable).values(parsed.data).returning({ id: contactRequestsTable.id });
  res.status(201).json(SubmitContactRequestResponse.parse({ id: request.id, status: "received" }));
});

export default router;