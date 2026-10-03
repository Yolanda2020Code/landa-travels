import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  chatbotEventsTable,
  conversationsTable,
  conversationTurnsTable,
  db,
} from "@workspace/db";
import { emptyTripContext } from "../services/eco-travel";
import { tripContextFingerprint } from "../services/advisor-handover";
import assistantRouter from "./assistant";

type ResponseStub = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (code: number) => ResponseStub;
  setHeader: (name: string, value: string) => ResponseStub;
  json: (body: unknown) => ResponseStub;
};

function response(): ResponseStub {
  const output = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const result = {
    get statusCode() { return output.statusCode; },
    get body() { return output.body; },
    get headers() { return output.headers; },
    status(code: number) { output.statusCode = code; return result; },
    setHeader(name: string, value: string) { output.headers[name.toLowerCase()] = value; return result; },
    json(body: unknown) { output.body = body; return result; },
  };
  return result;
}

test("assistant route forwards button payload but persists and returns only its visible title", async () => {
  const sessionId = `quick-reply-route-${Date.now()}`;
  const title = "Balanced";
  const payload = '/inform{"sustainability_level":"balanced"}';
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  let webhookMessage: string | undefined;
  let webhookSender: string | undefined;

  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  assert.ok(routeLayer, "POST /assistant/message exists");
  const route = routeLayer.route.stack.at(-1).handle;

  try {
    process.env.RASA_URL = "http://rasa.test";
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/webhooks/rest/webhook")) {
        const body = JSON.parse(String(init?.body));
        webhookMessage = body.message;
        webhookSender = body.sender;
        return new Response(JSON.stringify([{
          text: "Preference saved.",
          buttons: [{ title: "Balanced", payload }],
        }]), { status: 200 });
      }
      if (path.endsWith("/tracker")) {
        return new Response(JSON.stringify({ slots: { requested_slot: null } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const invalidResponse = response();
    await route({
      body: { sessionId, message: title, payload: " \u0001 ", context: emptyTripContext },
      headers: {},
    }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(webhookMessage, undefined);

    const res = response();
    await route({
      body: { sessionId, message: title, payload, context: emptyTripContext },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(webhookMessage, payload);
    assert.match(webhookSender ?? "", /^[0-9a-f-]{36}$/i);
    assert.notEqual(webhookSender, sessionId, "Rasa sender is a server-generated conversation namespace");
    const result = res.body as {
      messages: string[];
      quickReplies: Array<{ title: string; payload: string }>;
    };
    assert.deepEqual(result.messages, ["Preference saved."]);
    assert.deepEqual(result.quickReplies, [{ title, payload }]);
    const [conversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal((conversation.context as Record<string, unknown>).rasaConversationId, webhookSender);

    const turns = await db.select().from(conversationTurnsTable)
      .where(eq(conversationTurnsTable.sessionId, sessionId));
    const userTurn = turns.find((turn) => turn.role === "user");
    assert.equal(userTurn?.content, title);
    assert.doesNotMatch(userTurn?.content ?? "", /\/inform|sustainability_level/);

    const waitForEventCount = async (expected: number) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const events = await db.select().from(chatbotEventsTable)
          .where(eq(chatbotEventsTable.sessionId, sessionId));
        if (events.length >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Expected at least ${expected} asynchronously written analytics events.`);
    };
    await waitForEventCount(1);
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
    const previousRasaSender = webhookSender;
    const reconnectedResponse = response();
    await route({
      body: { sessionId, message: title, payload, context: emptyTripContext },
      headers: {},
    }, reconnectedResponse);
    assert.equal(reconnectedResponse.statusCode, 200);
    assert.match(webhookSender ?? "", /^[0-9a-f-]{36}$/i);
    assert.notEqual(webhookSender, sessionId);
    assert.notEqual(webhookSender, previousRasaSender, "a recreated parent receives a fresh Rasa namespace");
    await waitForEventCount(2);
    const [recreatedConversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal((recreatedConversation.context as Record<string, unknown>).rasaConversationId, webhookSender);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("assistant offers advisory escalation after two pre-review clarification failures without submitting a handover", async () => {
  const sessionId = `assistant-early-escalation-${Date.now()}`;
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  let failClarification = true;
  let trackerOrigin: string | null = null;
  const rasaSenders: string[] = [];
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;
  await db.insert(conversationsTable).values({
    sessionId,
    context: {
      ...emptyTripContext,
      clarificationFailureCount: 1,
      planningContextFingerprint: tripContextFingerprint(emptyTripContext),
    },
  });

  try {
    process.env.RASA_URL = "http://early-escalation-rasa.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tracker")) {
        return new Response(JSON.stringify({ slots: { origin: trackerOrigin } }), { status: 200 });
      }
      if (url.pathname.endsWith("/webhooks/rest/webhook")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        rasaSenders.push(body.sender);
        return failClarification
          ? new Response(JSON.stringify([{
              text: "I’m not certain what you meant. Say plan a trip, correct a detail, explain carbon estimates, speak to an advisor, or cancel.",
            }]), { status: 200 })
          : new Response(JSON.stringify([{ text: "I have recorded your origin. What is your destination?" }]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const res = response();
    await route({
      body: { sessionId, message: "Could you help me?", payload: "/ask_carbon_method", context: emptyTripContext },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { handoverRecommendation: unknown }).handoverRecommendation, {
      recommended: true,
      reason: "repeated_failed_clarification",
      message: "I’m having trouble understanding a planning detail. You can ask an advisor for help; nothing will be sent unless you sign in, save this trip, and explicitly consent.",
    });
    assert.equal((res.body as { context: { reviewConfirmation: boolean | null } }).context.reviewConfirmation, null);
    assert.equal((res.body as { context: { origin: string | null } }).context.origin, null);
    assert.equal((res.body as { context: { handoverRequested: boolean } }).context.handoverRequested, false);
    assert.match(rasaSenders[0] ?? "", /^[0-9a-f-]{36}$/i);
    assert.notEqual(rasaSenders[0], sessionId, "legacy rows are migrated to a server-generated Rasa namespace");

    failClarification = false;
    trackerOrigin = "Berlin";
    const resolutionResponse = response();
    await route({
      body: {
        sessionId,
        message: "Berlin",
        context: (res.body as { context: typeof emptyTripContext }).context,
      },
      headers: {},
    }, resolutionResponse);
    assert.equal((resolutionResponse.body as { handoverRecommendation: { recommended: boolean } }).handoverRecommendation.recommended, false);
    const [afterResolution] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal((afterResolution.context as Record<string, any>).clarificationFailureCount, 0);

    failClarification = true;
    const nextFailureResponse = response();
    await route({
      body: {
        sessionId,
        message: "??",
        context: (resolutionResponse.body as { context: typeof emptyTripContext }).context,
      },
      headers: {},
    }, nextFailureResponse);
    assert.equal((nextFailureResponse.body as { handoverRecommendation: { recommended: boolean } }).handoverRecommendation.recommended, false);
    const [afterNextFailure] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal((afterNextFailure.context as Record<string, any>).clarificationFailureCount, 1);
    assert.equal(new Set(rasaSenders).size, 1, "the persisted namespace remains stable across requests");
    assert.equal((afterNextFailure.context as Record<string, any>).rasaConversationId, rasaSenders[0]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("assistant bounds same-conversation work instead of queuing unbounded requests", async () => {
  const sessionId = `assistant-request-bound-${Date.now()}`;
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  let notifyWebhookStarted!: () => void;
  let releaseWebhook!: () => void;
  const webhookStarted = new Promise<void>((resolve) => { notifyWebhookStarted = resolve; });
  const webhookGate = new Promise<void>((resolve) => { releaseWebhook = resolve; });
  let rasaCalls = 0;
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;

  try {
    process.env.RASA_URL = "http://bounded-request-rasa.test";
    globalThis.fetch = async (input) => {
      rasaCalls += 1;
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/tracker")) {
        return new Response(JSON.stringify({ slots: {} }), { status: 200 });
      }
      if (path.endsWith("/webhooks/rest/webhook")) {
        notifyWebhookStarted();
        await webhookGate;
        return new Response(JSON.stringify([{ text: "I can help plan that trip." }]), { status: 200 });
      }
      return new Response(JSON.stringify({ intent: { name: "other" } }), { status: 200 });
    };

    const firstResponse = response();
    const firstRequest = route({
      body: { sessionId, message: "Plan a trip.", context: emptyTripContext },
      headers: {},
    }, firstResponse);
    await webhookStarted;
    const callsWhileFirstIsActive = rasaCalls;

    const secondResponse = response();
    await route({
      body: { sessionId, message: "Change my destination.", context: emptyTripContext },
      headers: {},
    }, secondResponse);
    assert.equal(secondResponse.statusCode, 429);
    assert.equal(rasaCalls, callsWhileFirstIsActive, "the rejected request never joins the Rasa queue");
    const turnsDuringFirstRequest = await db.select().from(conversationTurnsTable)
      .where(eq(conversationTurnsTable.sessionId, sessionId));
    assert.equal(turnsDuringFirstRequest.length, 1, "the rejected request writes no user turn");

    releaseWebhook();
    await firstRequest;
    assert.equal(firstResponse.statusCode, 200);
  } finally {
    releaseWebhook();
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("confirmation starts read-only provider work while Rasa processes the same confirmed trip", async () => {
  const sessionId = `confirmation-parallel-${Date.now()}`;
  const context = {
    ...emptyTripContext,
    origin: "Berlin",
    destination: "Lisbon",
    dateRange: "2030-06-10 to 2030-06-14",
    travellerCount: 2,
    budget: "Flexible",
    transportPreferences: ["flight"],
    accessibilityNeeds: ["none"],
    sustainabilityPriority: "balanced",
    accommodationNeeds: ["hotel"],
    locationConsentMode: "skipped" as const,
    reviewConfirmation: true,
  };
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  const previousDuffel = process.env.DUFFEL_ACCESS_TOKEN;
  const previousClimatiq = process.env.CLIMATIQ_API_KEY;
  const previousAssistantTiming = process.env.ASSISTANT_TIMING;
  let providerStarted = false;
  let rasaWaitedForProvider = false;
  let notifyProviderStarted!: () => void;
  const providerStartedSignal = new Promise<void>((resolve) => { notifyProviderStarted = resolve; });
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;

  try {
    process.env.RASA_URL = "http://rasa.test";
    process.env.DUFFEL_ACCESS_TOKEN = "test-duffel";
    process.env.CLIMATIQ_API_KEY = "test-climatiq";
    process.env.ASSISTANT_TIMING = "1";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "rasa.test") {
        if (url.pathname.endsWith("/webhooks/rest/webhook")) {
          await Promise.race([
            providerStartedSignal,
            new Promise<void>((resolve) => setTimeout(resolve, 500)),
          ]);
          rasaWaitedForProvider = providerStarted;
          return new Response(JSON.stringify([{
            text: "Your confirmed trip options.",
            custom: { type: "recommendations", items: [{ id: "rasa-option", name: "Rail option", carbon_kg: 20 }] },
          }]), { status: 200 });
        }
        if (url.pathname.endsWith("/tracker")) {
          return new Response(JSON.stringify({ slots: {
            origin: context.origin,
            destination: context.destination,
            travel_dates: context.dateRange,
            travelers: context.travellerCount,
            budget: context.budget,
            transport_preference: "flight",
            accessibility_need: "none",
            sustainability_level: "balanced",
            accommodation_need: "hotel",
            location_mode: "none",
            review_confirmation: true,
          } }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }

      providerStarted = true;
      notifyProviderStarted();
      if (url.pathname.endsWith("/places/suggestions")) {
        const berlin = url.searchParams.get("query") === "Berlin";
        return new Response(JSON.stringify({ data: [{
          type: "city",
          name: berlin ? "Berlin" : "Lisbon",
          iata_code: berlin ? "BER" : "LIS",
          iata_country_code: berlin ? "DE" : "PT",
          geographic_coordinates: berlin
            ? { latitude: 52.52, longitude: 13.4 }
            : { latitude: 38.72, longitude: -9.14 },
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { offers: [], results: [] } }), { status: 200 });
    };

    const res = response();
    await route({
      body: { sessionId, message: "Confirm these trip details and show my best options.", context },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(rasaWaitedForProvider, true, "provider lookup began before the Rasa webhook completed");
    assert.deepEqual((res.body as { recommendations: Array<{ id: string }> }).recommendations.map(({ id }) => id), ["rasa-option"]);
    const timings = res.headers["server-timing"] ?? "";
    assert.doesNotMatch(timings, /retention-cleanup;dur=|db-analytics;dur=/);
    assert.doesNotMatch(timings, /rasa-slot-events;dur=/);
    assert.match(timings, /rasa-webhook;dur=/);
    assert.match(timings, /rasa-tracker;dur=/);
    assert.match(timings, /duffel-place;dur=/);
    assert.match(timings, /provider-total;dur=/);
    assert.match(timings, /db-save-assistant;dur=/);
    assert.match(timings, /assistant-total;dur=/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    if (previousDuffel === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
    else process.env.DUFFEL_ACCESS_TOKEN = previousDuffel;
    if (previousClimatiq === undefined) delete process.env.CLIMATIQ_API_KEY;
    else process.env.CLIMATIQ_API_KEY = previousClimatiq;
    if (previousAssistantTiming === undefined) delete process.env.ASSISTANT_TIMING;
    else process.env.ASSISTANT_TIMING = previousAssistantTiming;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("confirmed assistant recommendations persist to the conversation cache with advisory escalation fields", async () => {
  const sessionId = `assistant-snapshot-${Date.now()}`;
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  const previousDuffel = process.env.DUFFEL_ACCESS_TOKEN;
  const previousClimatiq = process.env.CLIMATIQ_API_KEY;
  let webhookMode: "options" | "help" | "replacement" = "options";
  let trackerDestination: string | null = "Lisbon";
  let trackerReview = true;
  let trackerStopovers = ["Paris", "Porto"];
  let recommendationConfirmations = 0;
  const context = {
    ...emptyTripContext,
    origin: "Berlin",
    destination: "Lisbon",
    dateRange: "2030-06-10 to 2030-06-14",
    travellerCount: 2,
    budget: "Flexible",
    transportPreferences: ["rail"],
    accommodationNeeds: ["hotel"],
    accessibilityNeeds: ["none"],
    sustainabilityPriority: "balanced",
    locationConsentMode: "skipped" as const,
    reviewConfirmation: true,
  };
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;

  try {
    process.env.RASA_URL = "http://snapshot-rasa.test";
    delete process.env.DUFFEL_ACCESS_TOKEN;
    delete process.env.CLIMATIQ_API_KEY;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "snapshot-rasa.test") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.pathname.endsWith("/webhooks/rest/webhook")) {
        const requestMessage = JSON.parse(String(init?.body ?? "{}")).message as string;
        if (requestMessage.startsWith("/correct_information")) {
          trackerDestination = "Oslo";
          trackerReview = false;
          webhookMode = "help";
        } else if (requestMessage === "/confirm_review") {
          trackerReview = true;
          recommendationConfirmations += 1;
          webhookMode = recommendationConfirmations === 1 ? "options" : "replacement";
        } else if (requestMessage === "/cancel") {
          trackerDestination = null;
          trackerReview = false;
          trackerStopovers = [];
          webhookMode = "help";
        }
        if (webhookMode === "help") {
          return new Response(JSON.stringify([{ text: "Carbon values are planning estimates based on distance and mode." }]), { status: 200 });
        }
        const items = webhookMode === "replacement"
          ? [{ id: "replacement-option", type: "transport", name: "Replacement flight", carbon_kg: 25, price_eur: 150, score: 95 }]
          : Array.from({ length: 64 }, (_, index) => ({
              id: index === 63 ? "last-flight-option" : `mixed-card-${index}`,
              type: (["stay", "transport", "experience", "offset"] as const)[index % 4],
              name: index === 63 ? "Last flight option" : `Mixed category option ${index}`,
              carbon_kg: 12 + index,
              price_eur: 100 + index,
              score: 100 - index,
              tags: index === 63 ? ["flight"] : [],
            }));
        return new Response(JSON.stringify([{
          text: "Here are the reviewed options.",
          custom: {
            type: "recommendations",
            items,
          },
        }]), { status: 200 });
      }
      if (url.pathname.endsWith("/tracker")) {
        return new Response(JSON.stringify({ slots: {
          origin: "Berlin",
          destination: trackerDestination,
          stopovers: trackerStopovers,
          travel_dates: "2030-06-10 to 2030-06-14",
          travelers: 2,
          budget: "Flexible",
          transport_preference: "rail",
          accessibility_need: "none",
          sustainability_level: "balanced",
          accommodation_need: "hotel",
          location_mode: "none",
          review_confirmation: trackerReview,
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const res = response();
    await route({
      body: {
        sessionId,
        message: "Confirm these trip details and show my best options.",
        context,
      },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    const output = res.body as {
      recommendations: Array<{ id: string; rankingExplanation?: string }>;
      handoverRecommendation: { recommended: boolean; reason: string | null; message: string | null };
      context: typeof context;
    };
    assert.equal(output.recommendations.length, 64);
    assert.ok(output.recommendations.some(({ id }) => id === "last-flight-option"));
    assert.ok(output.recommendations.some((item) => Boolean(item.rankingExplanation)));
    assert.deepEqual(output.handoverRecommendation, {
      recommended: true,
      reason: "multiple_stopovers",
      message: "This itinerary includes several stopovers and may need expert coordination.",
    });
    const [conversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    const storedContext = conversation.context as Record<string, any>;
    assert.equal(storedContext.recommendationSnapshot.source, "demo");
    assert.equal(storedContext.recommendationSnapshot.recommendations.length, output.recommendations.length);
    assert.ok(storedContext.recommendationSnapshot.recommendations.some((item: { id: string }) => item.id === "last-flight-option"));
    assert.equal(storedContext.recommendationSnapshot.recommendations[0].durationMinutes, undefined);
    assert.equal(typeof storedContext.recommendationSnapshot.confirmedAt, "string");
    assert.ok(storedContext.recommendationSnapshot.unknowns.length > 0);
    const firstConfirmedAt = storedContext.recommendationSnapshot.confirmedAt;
    const confirmedContext = output.context;

    webhookMode = "help";
    const helpResponse = response();
    await route({
      body: { sessionId, message: "Explain carbon estimates.", context: confirmedContext },
      headers: {},
    }, helpResponse);
    assert.deepEqual((helpResponse.body as { recommendations: unknown[] }).recommendations, []);
    const [afterHelpConversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    const afterHelpSnapshot = (afterHelpConversation.context as Record<string, any>).recommendationSnapshot;
    assert.equal(afterHelpSnapshot.confirmedAt, firstConfirmedAt);
    assert.equal(afterHelpSnapshot.recommendations.length, 64);

    webhookMode = "replacement";
    const newActionResponse = response();
    await route({
      body: { sessionId, message: "Please recommend fresh options.", context: confirmedContext },
      headers: {},
    }, newActionResponse);
    assert.equal((newActionResponse.body as { recommendations: Array<{ id: string }> }).recommendations[0].id, "replacement-option");
    const [afterNewActionConversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    const afterNewActionSnapshot = (afterNewActionConversation.context as Record<string, any>).recommendationSnapshot;
    assert.deepEqual(afterNewActionSnapshot.recommendations.map((item: { id: string }) => item.id), ["replacement-option"]);

    const editResponse = response();
    await route({
      body: { sessionId, message: "change my destination to Oslo", context: confirmedContext },
      headers: {},
    }, editResponse);
    assert.equal((editResponse.body as { context: { destination: string | null } }).context.destination, "Oslo");
    const [afterEditConversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal("recommendationSnapshot" in (afterEditConversation.context as Record<string, unknown>), false);

    const reConfirmResponse = response();
    await route({
      body: {
        sessionId,
        message: "Confirm the revised trip.",
        payload: "/confirm_review",
        context: (editResponse.body as { context: typeof context }).context,
      },
      headers: {},
    }, reConfirmResponse);
    assert.equal((reConfirmResponse.body as { recommendations: Array<{ id: string }> }).recommendations[0].id, "replacement-option");

    const cancelResponse = response();
    await route({
      body: {
        sessionId,
        message: "Cancel this plan",
        payload: "/cancel",
        context: (reConfirmResponse.body as { context: typeof context }).context,
      },
      headers: {},
    }, cancelResponse);
    const [afterCancelConversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.equal("recommendationSnapshot" in (afterCancelConversation.context as Record<string, unknown>), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
    if (previousDuffel === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
    else process.env.DUFFEL_ACCESS_TOKEN = previousDuffel;
    if (previousClimatiq === undefined) delete process.env.CLIMATIQ_API_KEY;
    else process.env.CLIMATIQ_API_KEY = previousClimatiq;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("a bound assistant conversation cannot be changed without its owner's authentication", async () => {
  const sessionId = `assistant-owner-guard-${Date.now()}`;
  const ownerId = `clerk-owner-${Date.now()}`;
  const storedContext = { ...emptyTripContext, preserved: "server-owned" };
  await db.insert(conversationsTable).values({
    sessionId,
    userId: ownerId,
    context: storedContext,
  });
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;
  try {
    const res = response();
    await route({
      body: { sessionId, message: "Please change the trip.", context: emptyTripContext },
      headers: { "x-user-id": ownerId, "x-clerk-user-id": ownerId },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.match((res.body as { error: string }).error, /belongs to another signed-in traveller/i);
    const turns = await db.select().from(conversationTurnsTable)
      .where(eq(conversationTurnsTable.sessionId, sessionId));
    assert.equal(turns.length, 0);
    assert.equal(fetchCalls, 0, "foreign conversations are rejected before calling Rasa");
    const [conversation] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.sessionId, sessionId)).limit(1);
    assert.deepEqual(conversation.context, storedContext);
  } finally {
    globalThis.fetch = previousFetch;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionId));
  }
});

test("expired and near-expiry conversations return 410 without mutation or Rasa access", async () => {
  const sessionIds = [
    `assistant-expired-${Date.now()}`,
    `assistant-near-expiry-${Date.now()}`,
  ];
  const sentinelContexts = sessionIds.map((_, index) => ({
    ...emptyTripContext,
    sentinel: `unchanged-${index}`,
  }));
  await db.insert(conversationsTable).values(sessionIds.map((sessionId, index) => ({
    sessionId,
    context: sentinelContexts[index],
    expiresAt: new Date(Date.now() + (index === 0 ? -60_000 : 4 * 60_000)),
  })));
  const routeLayer = (assistantRouter as any).stack.find(
    (item: any) => item.route?.path === "/assistant/message" && item.route.methods.post,
  );
  const route = routeLayer.route.stack.at(-1).handle;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    for (let index = 0; index < sessionIds.length; index += 1) {
      const res = response();
      await route({
        body: { sessionId: sessionIds[index], message: "Continue the trip.", context: emptyTripContext },
        headers: {},
      }, res);
      assert.equal(res.statusCode, 410);
      assert.match((res.body as { error: string }).error, /expired or too close to expiry/i);
      const turns = await db.select().from(conversationTurnsTable)
        .where(eq(conversationTurnsTable.sessionId, sessionIds[index]));
      assert.equal(turns.length, 0);
      const [conversation] = await db.select().from(conversationsTable)
        .where(eq(conversationsTable.sessionId, sessionIds[index])).limit(1);
      assert.deepEqual(conversation.context, sentinelContexts[index]);
    }
    assert.equal(fetchCalls, 0, "expired conversations are rejected before calling Rasa");
  } finally {
    globalThis.fetch = previousFetch;
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionIds[0]));
    await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionIds[1]));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionIds[0]));
    await db.delete(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionIds[1]));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionIds[0]));
    await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, sessionIds[1]));
  }
});