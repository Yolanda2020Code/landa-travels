import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import {
  RequestAdvisorHandoverBody,
  RequestAdvisorHandoverResponse,
  SendAssistantMessageBody,
  SendAssistantMessageResponse,
} from "@workspace/api-zod";
import { emptyTripContext } from "../services/eco-travel";
import { db, conversationsTable, conversationTurnsTable, savedTripsTable, advisorHandoversTable } from "@workspace/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { TripContext } from "@workspace/api-zod";
import { recordChatbotEvent } from "../services/chatbot-analytics";
import { isValidRasaButtonPayload, rasaWireMessage, RasaUnavailableError, sendRasaMessage } from "../services/rasa-gateway";
import { getLiveTravelRecommendations, LIVE_TRAVEL_SEARCH_DEADLINE_MS } from "../services/live-travel-providers";
import { rankTripRecommendations } from "../services/trip-ranking";
import { applyCertifiedStaysToRecommendations } from "../services/certification-registry";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { getRequestAuth } from "../middlewares/clerkAuthConfig";
import { logger } from "../lib/logger";
import guestAdvisorRouter, { requestGuestAdvisor, ASYNC_ADVISOR_MESSAGE } from "./guest-advisor";
import {
  boundAndRedactTranscript,
  buildHandoverSummary,
  contextFromSavedTrip,
  createRecommendationSnapshot,
  minimizeHandoverContext,
  nextClarificationFailureCount,
  newHandoverId,
  notifyAdvisorInbox,
  recommendComplexCaseHandover,
  recommendationSnapshotFromUnknown,
  recommendationSnapshotMatchesContext,
  sanitizeRecommendation,
  tripContextFingerprint,
  MAX_RECOMMENDATIONS,
  type RecommendationSnapshot,
} from "../services/advisor-handover";

const router: IRouter = Router();
const ASSISTANT_REQUEST_ADMISSION_WINDOW_MS = 5 * 60 * 1000;
const EXPIRED_ASSISTANT_CONVERSATION_MESSAGE =
  "This assistant conversation is expired or too close to expiry. Start a new conversation to continue.";
const activeAssistantRequests = new Set<string>();

function analyticsIntent(message: string): string {
  if (/cancel|stop/i.test(message)) return "cancel";
  if (/recommend|option|suggest/i.test(message)) return "request_recommendations";
  if (/confirm|looks good|yes/i.test(message)) return "confirm_review";
  if (/no|deny|wrong|change/i.test(message)) return "deny_or_correction";
  if (/location|near me|gps/i.test(message)) return "current_location";
  return "inform";
}

function redactForPersistence(message: string): string {
  return message
    .replace(/[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)/g, "[REDACTED GPS]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "[REDACTED PHONE]")
    .replace(/\b\d{1,6}\s+[\w.' -]+\s+(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd)\b/gi, "[REDACTED ADDRESS]")
    .replace(/\b(?:api[-_ ]?key|token|password|secret)\s*[:=]\s*\S+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b(?:wheelchair(?: access)?|step[- ]free(?: access)?|mobility assistance|medical assistance|disability|allergy|accessible assistance)\b/gi, "[REDACTED ACCESSIBILITY NEED]")
    .replace(/accessibility\s+.*?(?=,\s+accommodation\b)/gi, "accessibility [REDACTED ACCESSIBILITY NEED]");
}

function minimizeContext(context: TripContext): TripContext {
  return {
    ...context,
    currentLocation: null,
    accessibilityNeeds: context.accessibilityNeeds.length ? ["provided"] : [],
  };
}

function providerContextMatches(left: TripContext, right: TripContext): boolean {
  return left.origin === right.origin &&
    left.destination === right.destination &&
    left.dateRange === right.dateRange &&
    left.travellerCount === right.travellerCount &&
    JSON.stringify(left.accommodationNeeds) === JSON.stringify(right.accommodationNeeds);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function conversationCallerUserId(req: Request): string | null {
  const directUserId = (req as AuthenticatedRequest).userId;
  if (typeof directUserId === "string") return directUserId;
  const auth = getRequestAuth(req);
  const rawUserId = auth?.sessionClaims?.userId || auth?.userId;
  return typeof rawUserId === "string" ? rawUserId : null;
}

function isPlanningCancellation(message: string, payload: string | undefined, replies: string[]): boolean {
  return payload === "/cancel" ||
    /^cancel(?:\s+(?:this plan|my trip|the plan))?[.!?]*$/i.test(message.trim()) ||
    replies.some((reply) => /i cancelled this plan and cleared its travel details/i.test(reply));
}

function isPlanningEditRequest(message: string, payload: string | undefined): boolean {
  return Boolean(
    payload && (/^\/correct_information\b/.test(payload) || /^\/guided_slot/.test(payload)) ||
    /\b(?:start over|reset|discard|revise)\s+(?:my\s+)?(?:trip|plan)\b/i.test(message) ||
    /\b(?:change|switch|update|correct|edit|remove|add)\s+(?:(?:my|the)\s+)?(?:trip|plan|origin|destination|dates?|travel dates|travellers?|travelers?|traveller count|budget|transport|accommodation|activities|activity preferences|stopovers?|accessibility|sustainability)\b/i.test(message),
  );
}

function isNewRecommendationAction(message: string, payload: string | undefined, context: TripContext): boolean {
  const wireMessage = rasaWireMessage(message, context, payload);
  return wireMessage === "/confirm_review" ||
    /^\/request_recommendations\b/.test(wireMessage) ||
    analyticsIntent(message) === "confirm_review" ||
    analyticsIntent(message) === "request_recommendations";
}

function isGeneralHelpExplanation(messages: string[]): boolean {
  return messages.some((message) =>
    /carbon values are planning estimates|i can help with sustainable trip planning|i can still help plan your trip safely|explain carbon estimates/i.test(message),
  );
}

router.post("/assistant/message", async (req, res) => {
  const startedAt = performance.now();
  const timings: Array<{ name: string; durationMs: number }> = [];
  const timingEnabled = process.env.ASSISTANT_TIMING === "1" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test";
  const observeTiming = (name: string, durationMs: number) => {
    if (timingEnabled) timings.push({ name, durationMs });
  };
  const time = async <T>(name: string, operation: () => PromiseLike<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await operation();
    } finally {
      observeTiming(name, performance.now() - start);
    }
  };
  const emitTimings = () => {
    if (!timingEnabled || typeof res.setHeader !== "function") return;
    const items = [...timings, { name: "assistant-total", durationMs: performance.now() - startedAt }];
    res.setHeader("Server-Timing", items
      .map(({ name, durationMs }) => `${name};dur=${durationMs.toFixed(1)}`)
      .join(", "));
  };
  const parsed = SendAssistantMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a valid message." });
    return;
  }
  if (parsed.data.payload !== undefined && !isValidRasaButtonPayload(parsed.data.payload)) {
    res.status(400).json({ error: "Please enter a valid message." });
    return;
  }

  const { sessionId, message, payload, context: prevContext } = parsed.data;

  const redactedMessage = redactForPersistence(message);

  // Read first so ownership and expiry are established before any turn write
  // or call to Rasa. Global retention deletes run on the startup/periodic
  // maintenance path, not once per traveller message.
  let [convo, previousAssistant] = await time("db-load-conversation", async () => {
    return Promise.all([
      db.query.conversationsTable.findFirst({
        where: eq(conversationsTable.sessionId, sessionId),
      }),
      db.query.conversationTurnsTable.findFirst({
        where: eq(conversationTurnsTable.sessionId, sessionId),
        orderBy: [desc(conversationTurnsTable.createdAt)],
      }),
    ]);
  });

  const callerUserId = conversationCallerUserId(req);
  const guardConversation = () => {
    if (convo && convo.userId !== null && callerUserId !== convo.userId) {
      emitTimings();
      res.status(403).json({ error: "This assistant conversation belongs to another signed-in traveller." });
      return false;
    }
    if (convo && convo.expiresAt.getTime() <= Date.now() + ASSISTANT_REQUEST_ADMISSION_WINDOW_MS) {
      emitTimings();
      res.status(410).json({ error: EXPIRED_ASSISTANT_CONVERSATION_MESSAGE });
      return false;
    }
    return true;
  };

  if (!convo) {
    const rasaConversationId = randomUUID();
    const inserted = await time("db-create-conversation", () => db.insert(conversationsTable).values({
      sessionId,
      context: { ...minimizeContext(emptyTripContext), rasaConversationId },
    }).onConflictDoNothing().returning());
    convo = inserted[0];
    if (!convo) {
      [convo, previousAssistant] = await Promise.all([
        db.query.conversationsTable.findFirst({
          where: eq(conversationsTable.sessionId, sessionId),
        }),
        db.query.conversationTurnsTable.findFirst({
          where: eq(conversationTurnsTable.sessionId, sessionId),
          orderBy: [desc(conversationTurnsTable.createdAt)],
        }),
      ]);
    }
  }
  if (!convo) {
    emitTimings();
    res.status(503).json({ error: "The assistant conversation could not be opened. Please retry." });
    return;
  }
  if (!guardConversation()) return;

  let storedConversationMetadata = objectRecord(convo.context);
  let rasaConversationId = typeof storedConversationMetadata.rasaConversationId === "string" &&
    storedConversationMetadata.rasaConversationId.length > 0
      ? storedConversationMetadata.rasaConversationId
      : null;
  if (!rasaConversationId) {
    const candidateRasaConversationId = randomUUID();
    const expectedOwner = convo.userId === null
      ? sql`${conversationsTable.userId} IS NULL`
      : eq(conversationsTable.userId, convo.userId);
    const claimed = await time("db-claim-rasa-conversation", () => db.update(conversationsTable)
      .set({
        context: sql`jsonb_set(${conversationsTable.context}, '{rasaConversationId}', to_jsonb(${candidateRasaConversationId}::text), true)`,
      })
      .where(and(
        eq(conversationsTable.sessionId, sessionId),
        expectedOwner,
        gt(conversationsTable.expiresAt, new Date(Date.now() + ASSISTANT_REQUEST_ADMISSION_WINDOW_MS)),
        sql`NULLIF(${conversationsTable.context}->>'rasaConversationId', '') IS NULL`,
      ))
      .returning());
    if (claimed[0]) {
      convo = claimed[0];
      storedConversationMetadata = objectRecord(convo.context);
      rasaConversationId = candidateRasaConversationId;
    } else {
      const latest = await db.query.conversationsTable.findFirst({
        where: eq(conversationsTable.sessionId, sessionId),
      });
      if (!latest) {
        emitTimings();
        res.status(410).json({ error: EXPIRED_ASSISTANT_CONVERSATION_MESSAGE });
        return;
      }
      convo = latest;
      storedConversationMetadata = objectRecord(convo.context);
      rasaConversationId = typeof storedConversationMetadata.rasaConversationId === "string" &&
        storedConversationMetadata.rasaConversationId.length > 0
          ? storedConversationMetadata.rasaConversationId
          : null;
      if (!rasaConversationId) {
        emitTimings();
        res.status(503).json({ error: "The assistant conversation could not be opened. Please retry." });
        return;
      }
    }
  }
  if (!guardConversation()) return;

  const activeRequestId = rasaConversationId!;
  if (activeAssistantRequests.has(activeRequestId)) {
    emitTimings();
    res.status(429).json({ error: "This assistant conversation is already processing a request. Please wait and retry." });
    return;
  }
  activeAssistantRequests.add(activeRequestId);
  await (async () => {
  // Save user turn
  await time("db-save-user-turn", () => db.insert(conversationTurnsTable).values({
    sessionId,
    role: "user",
    content: redactedMessage,
    redactedContent: redactedMessage,
  }));

  let result;
  try {
    // Confirmation already contains the complete traveller-approved search
    // criteria. Start read-only provider lookups while Rasa processes the
    // confirmation rather than serializing two independent network paths.
    // A result is only used if Rasa confirms those provider-relevant slots.
    const requestedProviderContext =
      prevContext?.reviewConfirmation === true &&
      payload === undefined &&
      rasaWireMessage(message, prevContext) === "/confirm_review"
        ? prevContext
        : null;
    const providerStartedAt = performance.now();
    const providerDeadline = requestedProviderContext
      ? AbortSignal.timeout(LIVE_TRAVEL_SEARCH_DEADLINE_MS)
      : undefined;
    const providerPromise = requestedProviderContext
      ? getLiveTravelRecommendations(requestedProviderContext, observeTiming, providerDeadline).then((value) => {
        observeTiming("provider-total", performance.now() - providerStartedAt);
        return value;
      })
      : null;
    result = await sendRasaMessage(
      rasaConversationId!, message, prevContext ?? emptyTripContext, payload, observeTiming,
      recommendationSnapshotFromUnknown(objectRecord(convo.context).recommendationSnapshot),
    );
    if (result.context.reviewConfirmation && result.recommendations.length > 0) {
      const providerResult = providerPromise
        ? providerContextMatches(requestedProviderContext!, result.context)
          ? await providerPromise
          : await getLiveTravelRecommendations(result.context, observeTiming, providerDeadline)
        : await getLiveTravelRecommendations(result.context, observeTiming, providerDeadline);
      if (providerResult.recommendations.length > 0) {
        const liveTypes = new Set(providerResult.recommendations.map((item) => item.type));
        result = {
          ...result,
          messages: [...result.messages, providerResult.notice],
          recommendations: [
            ...providerResult.recommendations,
            ...result.recommendations.filter((item) =>
              item.type === "experience" ||
              item.type === "offset" ||
              (item.type === "transport" && !/flight/i.test(item.name)) ||
              (item.type === "stay" && !liveTypes.has("stay"))
            ),
          ],
          source: providerResult.source,
        };
      } else {
        result = {
          ...result,
          messages: [...result.messages, providerResult.notice],
        };
      }
    }
  } catch (error) {
    void recordChatbotEvent({
      sessionId,
      eventType: "error",
      latencyMs: Math.round(performance.now() - startedAt),
      payload: { code: "rasa_unavailable" },
    }).catch((analyticsError) => logger.error({ err: analyticsError }, "Failed to record assistant error analytics"));
    if (error instanceof RasaUnavailableError) {
      emitTimings();
      res.status(503).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (result.context.reviewConfirmation && result.recommendations.length > 0) {
    const stayResult = applyCertifiedStaysToRecommendations(
      result.recommendations,
      result.context.destination,
      result.context.dateRange,
    );
    result = {
      ...result,
      recommendations: stayResult.recommendations,
      ...(stayResult.notice ? { messages: [...result.messages, stayResult.notice] } : {}),
    };
  }
  if (result.context.reviewConfirmation) {
    result = {
      ...result,
      recommendations: rankTripRecommendations(result.recommendations, result.context),
    };
  }
  const recommendationLimitReached = result.recommendations.length > MAX_RECOMMENDATIONS;
  result = {
    ...result,
    recommendations: result.recommendations
      .slice(0, MAX_RECOMMENDATIONS)
      .map(sanitizeRecommendation)
      .filter((option): option is NonNullable<typeof option> => option !== null),
    ...(recommendationLimitReached
      ? { messages: [...result.messages, `Showing at most ${MAX_RECOMMENDATIONS} options; refine the search to review more. The advisor handover will include the same displayed options.`] }
      : {}),
  };
  const { context } = result;
  const previousConversationMetadata = objectRecord(convo.context);
  const previousClarificationFailures = Number.isInteger(previousConversationMetadata.clarificationFailureCount)
    ? Number(previousConversationMetadata.clarificationFailureCount)
    : 0;
  const repeatedAssistantPrompt = previousAssistant?.role === "assistant" &&
    result.messages.length > 0 &&
    previousAssistant.redactedContent === redactForPersistence(result.messages.join("\n"));
  const planningContextFingerprint = tripContextFingerprint(context);
  const previousPlanningContextFingerprint = typeof previousConversationMetadata.planningContextFingerprint === "string"
    ? previousConversationMetadata.planningContextFingerprint
    : null;
  const planningContextChanged = previousPlanningContextFingerprint !== null &&
    previousPlanningContextFingerprint !== planningContextFingerprint;
  const successfulResolution = !isGeneralHelpExplanation(result.messages) &&
    (planningContextChanged || context.reviewConfirmation === true);
  const clarificationFailureCount = nextClarificationFailureCount(
    previousClarificationFailures,
    result.messages,
    successfulResolution,
  );
  const previousRecommendationSnapshot = recommendationSnapshotFromUnknown(previousConversationMetadata.recommendationSnapshot);
  const previousSnapshotMatchesContext = previousRecommendationSnapshot !== null &&
    recommendationSnapshotMatchesContext(previousRecommendationSnapshot, context);
  const cancelledPlan = isPlanningCancellation(message, payload, result.messages);
  const editedPlan = isPlanningEditRequest(message, payload) ||
    (previousRecommendationSnapshot !== null && !previousSnapshotMatchesContext);
  const recommendationSnapshot = !cancelledPlan &&
    context.reviewConfirmation === true &&
    result.recommendations.length > 0 &&
    isNewRecommendationAction(message, payload, context)
      ? createRecommendationSnapshot(result.recommendations, result.source, new Date().toISOString(), context)
      : !cancelledPlan && !editedPlan && previousSnapshotMatchesContext
        ? previousRecommendationSnapshot
        : null;
  const handoverRecommendation = recommendComplexCaseHandover(
    context,
    result.recommendations,
    clarificationFailureCount,
  );
  const changedSlots = Object.keys(context).filter((key) => JSON.stringify((prevContext ?? emptyTripContext)[key as keyof TripContext]) !== JSON.stringify((context as unknown as Record<string, unknown>)[key]));
  const analyticsWrites: Array<() => Promise<unknown>> = [
    () => recordChatbotEvent({ sessionId, eventType: "turn", latencyMs: Math.round(performance.now() - startedAt), payload: { intent: analyticsIntent(message), entities: changedSlots, messageLength: message.length } }),
  ];
  if (changedSlots.length) analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "slot_change", payload: { slots: changedSlots } }));
  if (result.recommendations.length) {
    analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "request_recommendation", payload: { count: result.recommendations.length } }));
    analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "recommendation", payload: { count: result.recommendations.length } }));
  }
  if (context.reviewConfirmation) analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "completion", payload: { outcome: "review_confirmed" } }));
  if (result.messages.some((message) => /try again|unable|fallback|not certain/i.test(message))) analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "fallback", payload: { reason: "assistant_fallback" } }));
  if (repeatedAssistantPrompt) {
    analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "repeated_prompt", payload: { evidence: "consecutive_identical_assistant_prompt" } }));
  }
  const normalizedOrigin = context.origin?.trim().toLocaleLowerCase();
  const normalizedDestination = context.destination?.trim().toLocaleLowerCase();
  if (normalizedOrigin && normalizedDestination && normalizedOrigin === normalizedDestination) {
    analyticsWrites.push(() => recordChatbotEvent({ sessionId, eventType: "source_destination_confusion", payload: { evidence: "normalized_source_equals_destination" } }));
  }

  // Save assistant turn
  const persistenceWrites: PromiseLike<unknown>[] = [];
  if (result.messages.length > 0) {
    const assistantContent = redactForPersistence(result.messages.join("\n"));
    persistenceWrites.push(db.insert(conversationTurnsTable).values({
      sessionId,
      role: "assistant",
      content: assistantContent,
      redactedContent: assistantContent,
    }));
  }

  // Update conversation context
  const persistedContext = {
    ...minimizeContext(context),
    rasaConversationId,
    clarificationFailureCount,
    planningContextFingerprint,
    ...(recommendationSnapshot ? { recommendationSnapshot } : {}),
  };
  persistenceWrites.push(db.update(conversationsTable)
    .set({ context: persistedContext, updatedAt: new Date() })
    .where(eq(conversationsTable.sessionId, sessionId)));
  await time("db-save-assistant", () => Promise.all(persistenceWrites));

  void Promise.all(analyticsWrites.map((write) => write()))
    .catch((error) => logger.error({ err: error }, "Failed to record assistant analytics"));

  const data = SendAssistantMessageResponse.parse({
    sessionId,
    messages: result.messages,
    quickReplies: result.quickReplies,
    recommendations: result.recommendations,
    handoverRecommendation,
    handover: result.handover,
    context,
    source: result.source,
    latencyMs: Math.round(performance.now() - startedAt),
  });

  emitTimings();
  res.json(data);
  })().finally(() => {
    activeAssistantRequests.delete(activeRequestId);
  });
});

router.use(guestAdvisorRouter);
router.post("/assistant/handover", (req, res, next) => {
  if (req.body?.savedTripId !== undefined) requireAuth(req, res, next);
  else next();
}, async (req, res): Promise<void> => {
  const parsed = RequestAdvisorHandoverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The handover context is incomplete." });
    return;
  }

  const {
    transcript,
    savedTripId,
    shareTranscriptConsent,
    selectedRecommendationIds = [],
  } = parsed.data;
  if (!shareTranscriptConsent) {
    res.status(400).json({ error: "Please confirm that you want to share the redacted conversation with an advisor." });
    return;
  }
  if (savedTripId === undefined) {
    await requestGuestAdvisor(req, res, activeAssistantRequests);
    return;
  }
  const userId = (req as AuthenticatedRequest).userId;
  const [ownedTrip] = await db.select()
    .from(savedTripsTable)
    .where(and(eq(savedTripsTable.id, savedTripId), eq(savedTripsTable.userId, userId)))
    .limit(1);
  if (!ownedTrip) {
    res.status(404).json({ error: "Save this trip before requesting advisor support." });
    return;
  }
  let conversationSnapshot: RecommendationSnapshot | null = null;
  if (ownedTrip.conversationSessionId) {
    const [ownedConversation] = await db.select({ context: conversationsTable.context })
      .from(conversationsTable)
      .where(and(
        eq(conversationsTable.sessionId, ownedTrip.conversationSessionId),
        eq(conversationsTable.userId, userId),
      )).limit(1);
    if (ownedConversation) {
      conversationSnapshot = recommendationSnapshotFromUnknown(
        objectRecord(ownedConversation.context).recommendationSnapshot,
      );
    }
  }
  const tripContextRecord = objectRecord(ownedTrip.context);
  const authoritativeContext = contextFromSavedTrip(ownedTrip);
  const authoritativeSnapshot = conversationSnapshot &&
    recommendationSnapshotMatchesContext(conversationSnapshot, authoritativeContext)
      ? conversationSnapshot
      : null;
  const uniqueSelection = [...new Set(selectedRecommendationIds)];
  if (uniqueSelection.length !== selectedRecommendationIds.length ||
      uniqueSelection.some((id) => !authoritativeSnapshot?.recommendations.some((option) => option.id === id))) {
    res.status(400).json({ error: "Selected recommendations must match options from this saved trip's confirmed results." });
    return;
  }
  const { recommendationSnapshot: _oldSnapshot, ...tripContextWithoutSnapshot } = tripContextRecord;
  await db.update(savedTripsTable).set({
    context: {
      ...tripContextWithoutSnapshot,
      ...(authoritativeSnapshot ? { recommendationSnapshot: authoritativeSnapshot } : {}),
    },
    updatedAt: new Date(),
  }).where(and(eq(savedTripsTable.id, savedTripId), eq(savedTripsTable.userId, userId)));
  const safeTranscript = boundAndRedactTranscript(transcript);
  const summary = buildHandoverSummary(
    authoritativeContext,
    safeTranscript.length,
    authoritativeSnapshot?.recommendations.length ?? 0,
    uniqueSelection.length,
  );
  const [handover] = await db.insert(advisorHandoversTable).values({
    handoverId: newHandoverId(),
    userId,
    savedTripId,
    status: "requested",
    summary,
    privacyContext: minimizeHandoverContext(authoritativeContext, authoritativeSnapshot, uniqueSelection),
    transcript: safeTranscript,
    notificationStatus: "pending",
  }).returning();
  const notification = await notifyAdvisorInbox(handover.handoverId, summary);
  const [updated] = await db.update(advisorHandoversTable).set({
    notificationStatus: notification.status,
    notificationError: notification.error ?? null,
    updatedAt: new Date(),
  }).where(eq(advisorHandoversTable.id, handover.id)).returning();
  await recordChatbotEvent({
    sessionId: ownedTrip.conversationSessionId ?? `handover-${handover.handoverId}`,
    eventType: "advisor_handover",
    payload: { transcriptTurns: safeTranscript.length, handoverId: handover.handoverId },
  });
  const nextStep = notification.status === "accepted"
    ? "Your request is saved in the advisor inbox and its email notification was accepted by the provider. An advisor will review it and reply later in your saved-trip workspace."
    : "Your request was saved, but notification delivery is not confirmed. Check the advisor status page for updates.";
  res.json(RequestAdvisorHandoverResponse.parse({
    handoverId: updated.handoverId,
    status: updated.status,
    summary: updated.summary,
    nextStep,
    deliveryStatus: updated.notificationStatus,
    slaMessage: ASYNC_ADVISOR_MESSAGE,
  }));
});

export default router;
