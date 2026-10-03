import assert from "node:assert/strict";
import test from "node:test";
import type { Recommendation } from "@workspace/api-zod";
import { mapRasaResult, rasaConversationNeedsContextBootstrap, rasaContextSlotValues, rasaSlotValuesForTurn, rasaWireMessage, rasaPromptBoundCityMessage, sendRasaMessage, tripContextFromRasaSlots } from "./rasa-gateway";

async function captureInformTurn(message: string, sessionId: string) {
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  const requests: Array<{ url: string; body?: string }> = [];
  const existingTracker = {
    active_loop: { name: null },
    slots: {},
    events: [{ event: "user", text: "hello" }],
  };
  process.env.RASA_URL = "http://rasa.test";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, body });
    if (url.endsWith("/model/parse")) {
      return new Response(JSON.stringify({ intent: { name: "inform" } }), { status: 200 });
    }
    if (url.endsWith("/webhooks/rest/webhook")) {
      return new Response(JSON.stringify([{ text: "Got it." }]), { status: 200 });
    }
    return new Response(JSON.stringify(existingTracker), { status: 200 });
  };
  try {
    await sendRasaMessage(sessionId, message, tripContextFromRasaSlots({}));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
  }
  return requests;
}

test("Rasa slots are the authoritative trip context", () => {
  const context = tripContextFromRasaSlots({
    origin: "Berlin",
    destination: "Paris",
    travel_dates: "2026-10-12 to 2026-10-15",
    travelers: 2,
    budget: "€1,000–2,500",
    transport_preference: "rail",
    accessibility_need: "none",
    sustainability_level: "climate-first",
    accommodation_need: "eco-hotel",
    activity_preferences: ["cultural"],
    location_mode: "none",
    review_confirmation: false,
  });

  assert.equal(context.origin, "Berlin");
  assert.equal(context.destination, "Paris");
  assert.equal(context.travellerCount, 2);
  assert.deepEqual(context.transportPreferences, ["rail"]);
  assert.equal(context.locationConsentMode, "skipped");
  assert.equal(context.sustainabilityPriority, "climate-first");
  assert.deepEqual((context as typeof context & { activityPreferences: string[] }).activityPreferences, ["cultural"]);
});

test("missing Rasa traveller slot remains unset instead of becoming zero", () => {
  assert.equal(tripContextFromRasaSlots({ travelers: null }).travellerCount, null);
});

test("vague corrections ask for a target without denying or confirming", () => {
  const context = tripContextFromRasaSlots({origin: "Paris", destination: "Amsterdam", review_confirmation: true});
  for (const message of ["No wait England", "Correct a detail", "Change something"]) {
    assert.equal(rasaWireMessage(message, context), "/correct_information");
    const tracker = {events: [{event: "user", text: "previous"}]};
    assert.deepEqual(rasaSlotValuesForTurn(tracker, context, undefined, "/correct_information"), {});
  }
  assert.equal(rasaWireMessage("no", context), "no");
  assert.equal(rasaWireMessage("What do you mean?", context), "What do you mean?");
});

test("Rasa text and custom recommendations map to the frontend contract", () => {
  const result = mapRasaResult([
    {
      text: "I ranked the options using your climate-first preference.",
      custom: {
        type: "recommendations",
        live_amadeus_available: false,
        items: [{
          id: "rail-demo",
          type: "transport",
          name: "Daytime rail",
          price_eur: 54,
          carbon_kg: 18.4,
          score: 92,
          source: "Climatiq live estimate",
          duration_minutes: 185,
          changes: 1,
          ranking_explanation: "Lowest estimated emissions among the available routes.",
        }],
      },
    },
  ], {
    slots: {
      destination: "Paris",
      sustainability_level: "climate-first",
      requested_slot: null,
    },
  });

  assert.deepEqual(result.messages, ["I ranked the options using your climate-first preference."]);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].carbonLabel, "low");
  assert.equal(result.recommendations[0].location, "Paris");
  assert.equal((result.recommendations[0] as Recommendation & { durationMinutes?: number }).durationMinutes, 185);
  assert.equal((result.recommendations[0] as Recommendation & { changes?: number }).changes, 1);
  assert.equal((result.recommendations[0] as Recommendation & { rankingExplanation?: string }).rankingExplanation, "Lowest estimated emissions among the available routes.");
  assert.equal(result.source, "demo");
});

test("curated accommodation retains the checked date and never invents a hotel price", () => {
  const result = mapRasaResult([{
    custom: {
      type: "recommendations",
      items: [{
        id: "saint-petersbourg-paris",
        type: "stay",
        name: "Hôtel Saint-Pétersbourg Paris Opéra & Spa",
        price_eur: null,
        carbon_kg: 39,
        source: "https://www.laclefverte.org/etablissement/23648",
        verified_at: "2026-09-29",
        certification: "La Clef Verte — reconfirm before booking",
      }],
    },
  }], { slots: { destination: "Paris" } });
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].price, "Not available — check provider");
  assert.equal(result.recommendations[0].verifiedAt, "2026-09-29");
  assert.match(result.recommendations[0].source, /^https:\/\/www\.laclefverte\.org/);
});

test("requested Rasa slots produce relevant structured quick replies", () => {
  const result = mapRasaResult(
    [{ text: "How should I balance climate impact, price, and convenience?" }],
    { slots: { requested_slot: "sustainability_level" } },
  );

  assert.deepEqual(result.quickReplies, [
    { title: "Climate-first", payload: "Climate-first" },
    { title: "Balanced", payload: "Balanced" },
    { title: "Comfort-first", payload: "Comfort-first" },
    { title: "Planner input: sustainability_level", payload: "__planner_slot__:sustainability_level" },
  ]);
});

test("the requested Rasa form slot is exposed to the planner without inferring sequence from filled values", () => {
  const result = mapRasaResult(
    [{ text: "When are you planning to travel?" }],
    { slots: { requested_slot: "travel_dates" } },
  );
  assert.ok(result.quickReplies.some((reply) =>
    reply.title === "Planner input: travel_dates" &&
    reply.payload === "__planner_slot__:travel_dates"));
});

test("Rasa button titles stay visible while exact, bounded payloads are retained", () => {
  const result = mapRasaResult([
    {
      text: "Choose a preference.",
      buttons: [
        { title: "Balanced", payload: '/inform{"sustainability_level":"balanced"}' },
        { title: "Plain reply" },
        { title: "Invalid payload", payload: { command: "/inform" } },
        { title: "Too long", payload: "x".repeat(2001) },
        { title: "x".repeat(201), payload: "valid" },
      ],
    },
  ], { slots: {} });

  assert.deepEqual(result.messages, ["Choose a preference."]);
  assert.deepEqual(result.quickReplies, [
    { title: "Balanced", payload: '/inform{"sustainability_level":"balanced"}' },
    { title: "Plain reply", payload: "Plain reply" },
  ]);
});

test("structured planner context maps deterministically to post-turn validated slot values", () => {
  const context = {
    origin: "Berlin (BER)",
    destination: "Paris (PAR)",
    currentLocation: null,
    stopovers: [],
    dateRange: "2026-10-12 to 2026-10-15",
    travellerCount: 2,
    budget: "€1,000–2,500",
    transportPreferences: ["rail"],
    accessibilityNeeds: ["none"],
    sustainabilityPriority: "climate-first",
    accommodationNeeds: ["eco-hotel"],
    activityPreferences: ["nature"],
    locationConsentMode: "skipped",
    reviewConfirmation: true,
    handoverRequested: false,
  } as Parameters<typeof rasaContextSlotValues>[0];

  const slots = rasaContextSlotValues(context);
  assert.equal(slots.origin, "Berlin (BER)");
  assert.equal(slots.destination, "Paris (PAR)");
  assert.equal(slots.transport_preference, "rail");
  assert.deepEqual(slots.activity_preferences, ["nature"]);
  assert.equal(slots.location_mode, "none");
  assert.equal(slots.review_confirmation, true);
});

test("existing Rasa trackers never receive stale client-context slot writes", () => {
  const context = {
    origin: "Paris",
    destination: "Rome",
  } as Parameters<typeof rasaContextSlotValues>[0];
  const tracker = {
    active_loop: { name: "trip_form" },
    events: [{ event: "user", text: "origin is Madrid" }],
    slots: { origin: "Madrid", destination: null, requested_slot: "destination" },
  };

  assert.equal(rasaConversationNeedsContextBootstrap(tracker), false);
  assert.deepEqual(
    rasaSlotValuesForTurn(tracker, context, '/guided_slot{"destination":"Rome"}', "/guided_continue"),
    { destination: "Rome", review_confirmation: null },
  );
  assert.equal(tracker.slots.origin, "Madrid");
});

test("new Rasa conversations bootstrap restored context exactly once", () => {
  const context = tripContextFromRasaSlots({
    origin: "Berlin",
    destination: "Paris",
    activity_preferences: ["cultural"],
  });
  const newTracker = {
    active_loop: { name: null },
    events: [{ event: "action", name: "action_session_start" }],
    slots: {},
  };
  assert.equal(rasaConversationNeedsContextBootstrap(newTracker), true);
  const firstTurn = rasaSlotValuesForTurn(newTracker, context, "__planner_greet__", "/greet");
  assert.equal(firstTurn.origin, "Berlin");
  assert.deepEqual(firstTurn.activity_preferences, ["cultural"]);

  const followupTracker = {
    active_loop: { name: "trip_form" },
    events: [{ event: "user", text: "/greet" }],
    slots: { origin: "Berlin", destination: "Paris" },
  };
  assert.deepEqual(rasaSlotValuesForTurn(followupTracker, context, "__planner_guided_continue__"), {});
});

test("Rasa turn metadata preserves explicit edits and confirmations", () => {
  const tracker = { events: [{ event: "user", text: "hello" }], slots: { origin: "Berlin" } };
  const context = tripContextFromRasaSlots({ origin: "Berlin", review_confirmation: false });
  assert.deepEqual(
    rasaSlotValuesForTurn(tracker, context, '__planner_edit__:{"destination":null,"review_confirmation":null}', "/guided_continue"),
    { destination: null, review_confirmation: null },
  );
  assert.deepEqual(
    rasaSlotValuesForTurn(tracker, context, "/confirm_review", "/confirm_review"),
    { review_confirmation: true },
  );
});

test("guided button payloads become safe post-turn validation metadata", () => {
  assert.deepEqual(
    rasaSlotValuesForTurn(
      { active_loop: { name: "trip_form" }, slots: { origin: "Berlin" } },
      tripContextFromRasaSlots({ origin: "Paris" }),
      '/guided_slot{"activity_preferences":["nature"]}',
      "/guided_continue",
    ),
    { activity_preferences: ["nature"], review_confirmation: null },
  );
  assert.deepEqual(
    rasaSlotValuesForTurn(
      { active_loop: { name: "trip_form" }, slots: { origin: "Berlin" } },
      tripContextFromRasaSlots({ origin: "Paris" }),
      '__planner_edit__:{"destination":null,"review_confirmation":null}',
      "/guided_continue",
    ),
    { destination: null, review_confirmation: null },
  );
  assert.throws(
    () => rasaSlotValuesForTurn(
      { active_loop: { name: "trip_form" }, slots: { origin: "Berlin" } },
      tripContextFromRasaSlots({}),
      '/guided_slot{"handover_id":"not allowed"}',
      "/guided_continue",
    ),
    /unsupported slot/,
  );
});

test("structured requests attach validation metadata to the user turn without pre-setting tracker slots", async () => {
  const previousFetch = globalThis.fetch;
  const previousRasaUrl = process.env.RASA_URL;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const existingTracker = {
    active_loop: { name: "trip_form" },
    slots: { origin: "Madrid", destination: null, requested_slot: "destination" },
    events: [{ event: "user", text: "Madrid" }],
  };
  process.env.RASA_URL = "http://rasa.test";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/webhooks/rest/webhook")) {
      return new Response(JSON.stringify([{ text: "Got it." }]), { status: 200 });
    }
    return new Response(JSON.stringify(existingTracker), { status: 200 });
  };
  try {
    await sendRasaMessage(
      "guided-slot-regression-session",
      "My destination is Rome.",
      tripContextFromRasaSlots({ origin: "Paris", destination: "Rome" }),
      '/guided_slot{"destination":"Rome"}',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRasaUrl === undefined) delete process.env.RASA_URL;
    else process.env.RASA_URL = previousRasaUrl;
  }

  assert.equal(requests.some((request) => request.url.endsWith("/tracker/events")), false);
  const turn = requests.find((request) => request.url.endsWith("/webhooks/rest/webhook"));
  assert.ok(turn);
  const body = JSON.parse(turn.body ?? "{}");
  assert.equal(body.message, "/guided_continue");
  assert.deepEqual(body.metadata.planner_slot_values, {
    destination: "Rome",
    review_confirmation: null,
  });
});

test("full-route free text with an ISO date range reaches Rasa NLU unchanged", async () => {
  const message = "I am travelling from Berlin to Paris on 2026-10-10 to 2026-10-13 with 2 travellers and a €900 budget.";
  const requests = await captureInformTurn(message, "route-dates-nlu-session");

  const parseRequest = requests.find((request) => request.url.endsWith("/model/parse"));
  assert.ok(parseRequest);
  assert.equal(JSON.parse(parseRequest.body ?? "{}").text, message);
  const turns = requests
    .filter((request) => request.url.endsWith("/webhooks/rest/webhook"))
    .map((request) => JSON.parse(request.body ?? "{}"));
  assert.deepEqual(turns.map((turn) => turn.message), ["/plan_trip", message]);
  assert.deepEqual(turns[1].metadata.planner_slot_values, {
    travel_dates: "2026-10-10 to 2026-10-13",
    review_confirmation: null,
  });
});

test("a standalone ISO date range reaches Rasa NLU while preserving its exact dates", async () => {
  const message = "2026-10-10 to 2026-10-13";
  const requests = await captureInformTurn(message, "standalone-dates-nlu-session");

  const parseRequest = requests.find((request) => request.url.endsWith("/model/parse"));
  assert.ok(parseRequest);
  assert.equal(JSON.parse(parseRequest.body ?? "{}").text, message);
  const turns = requests
    .filter((request) => request.url.endsWith("/webhooks/rest/webhook"))
    .map((request) => JSON.parse(request.body ?? "{}"));
  assert.deepEqual(turns.map((turn) => turn.message), ["/plan_trip", message]);
  assert.deepEqual(turns[1].metadata.planner_slot_values, {
    travel_dates: message,
    review_confirmation: null,
  });
});

test("greeting and guided Continue are explicit Rasa commands, not synthetic form prose", () => {
  const context = tripContextFromRasaSlots({});
  assert.equal(rasaWireMessage("Hello", context, "__planner_greet__"), "/greet");
  assert.equal(rasaWireMessage("Update trip details", context, "__planner_guided_continue__"), "/guided_continue");
  assert.equal(rasaWireMessage("Nature and outdoors", context, '/guided_slot{"activity_preferences":["nature"]}'), "/guided_continue");
});

test("the planner final action invokes Rasa's confirmation intent deterministically", () => {
  const context = tripContextFromRasaSlots({ review_confirmation: true });
  assert.equal(
    rasaWireMessage("Confirm these trip details and show my best options.", context),
    "/confirm_review",
  );
  assert.equal(rasaWireMessage("Speak to a human", context), "/request_handover");
});

test("a supplied button payload is sent verbatim instead of running text intent rewrites", () => {
  const context = tripContextFromRasaSlots({});
  const payload = '/inform{"sustainability_level":"balanced"}';
  assert.equal(rasaWireMessage("Balanced", context, payload), payload);
});

test("explicit route corrections carry the replacement city even when NLU misses the entity", () => {
  const context = tripContextFromRasaSlots({ destination: "Paris" });
  assert.equal(
    rasaWireMessage("change destination to Oslo", context),
    '/correct_information{"destination":"Oslo"}',
  );
  assert.equal(
    rasaWireMessage("Please update my origin to Amsterdam.", context),
    '/correct_information{"origin":"Amsterdam"}',
  );
  assert.equal(rasaWireMessage("I might visit Cambridge", context), "I might visit Cambridge");
});

test("guided route begins the form rather than sending an unhandled inform intent", () => {
  const context = {
    origin: "Berlin", destination: "Paris",
  } as Parameters<typeof rasaWireMessage>[1];
  assert.equal(rasaWireMessage("I am travelling from Berlin to Paris.", context), "/plan_trip");
  assert.equal(rasaWireMessage("My travel dates are 2026-10-10 to 2026-10-13.", context), "My travel dates are 2026-10-10 to 2026-10-13.");
});

test("bare geographical answers use the actual Rasa requested role, not inferred entities", () => {
  const tracker = { active_loop: { name: "trip_form" }, slots: { requested_slot: "origin" } };
  const parsed = { intent: { name: "nlu_fallback" }, geographic_spans: [{ value: "Graz", start: 0, end: 4 }] };
  assert.equal(rasaPromptBoundCityMessage("Graz", tracker, parsed), '/inform{"origin":"Graz"}');
  assert.equal(rasaPromptBoundCityMessage("Toulouse", tracker, {
    entities: [{ entity: "destination", value: "Toulouse" }],
  }), '/inform{"origin":"Toulouse"}');
  tracker.slots.requested_slot = "destination";
  assert.equal(rasaPromptBoundCityMessage("Graz.", tracker, parsed), '/inform{"destination":"Graz"}');
  assert.equal(rasaPromptBoundCityMessage("Keyboard", tracker, {}), null);
  assert.equal(rasaPromptBoundCityMessage("from Graz to Paris", tracker, parsed), null);
  assert.equal(rasaPromptBoundCityMessage("Graz", { ...tracker, active_loop: {} }, parsed), null);
  tracker.slots.requested_slot = "budget";
  assert.equal(rasaPromptBoundCityMessage("Graz", tracker, parsed), null);
});

test("city binding does not turn commands or unknown nouns into planner fields", () => {
  const tracker = { active_loop: { name: "trip_form" }, slots: { requested_slot: "origin" } };
  for (const message of ["cancel", "hello", "no", "help", "skip"]) {
    assert.equal(rasaPromptBoundCityMessage(message, tracker, { geographic_spans: [{ value: message }] }), null);
  }
  assert.equal(rasaPromptBoundCityMessage("keyboard", tracker, { geographic_spans: [] }), null);
});

test("closing acknowledgements use goodbye without changing or re-confirming the trip", () => {
  const context = tripContextFromRasaSlots({ origin: "Berlin", destination: "Paris", review_confirmation: true });
  for (const message of ["Thank you", "Thank you I am done", "Thanks, I'm done.", "Thank you for your help", "I’m done for today"]) {
    assert.equal(rasaWireMessage(message, context), "/goodbye");
  }
  for (const message of ["Thank you, change my destination to Oslo", "Thanks, how is carbon calculated?", "Thank you for booking my trip"]) {
    assert.equal(rasaWireMessage(message, context), message);
  }
  assert.deepEqual(rasaSlotValuesForTurn({ slots: { origin: "Berlin" } }, context, undefined, "/goodbye"), {});
});