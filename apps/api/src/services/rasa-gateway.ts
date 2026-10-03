import type { AssistantMessageResponse, Recommendation, TripContext } from "@workspace/api-zod";
import { plannerFollowupReply, typedPlannerEditPayload } from "./planner-followups";
import type { RecommendationSnapshot } from "./advisor-handover";

const DEFAULT_RASA_URL = "http://127.0.0.1:5005";
// Cold Rasa inference plus a remote provider estimate can exceed five seconds.
// Bound the wait without treating a briefly busy model as an immediate outage.
const RASA_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;
type QuickReply = AssistantMessageResponse["quickReplies"][number];
type TripContextWithActivities = TripContext & { activityPreferences?: string[] };

type RasaMessage = {
  text?: unknown;
  buttons?: unknown;
  custom?: unknown;
};

const PLANNER_GUIDED_PAYLOAD = "__planner_guided_continue__";
const PLANNER_GREETING_PAYLOAD = "__planner_greet__";
const PLANNER_SLOT_PREFIX = "__planner_slot__:";
const PLANNER_EDIT_PREFIX = "__planner_edit__:";
const GUIDED_SLOT_NAMES = new Set([
  "origin",
  "destination",
  "travel_dates",
  "travelers",
  "budget",
  "transport_preference",
  "accessibility_need",
  "sustainability_level",
  "accommodation_need",
  "activity_preferences",
  "location_mode",
  "location",
  "review_confirmation",
]);

type GuidedPayload = {
  kind: "slot" | "edit";
  values: Record<string, unknown>;
};

export type RasaAssistantResult = {
  messages: string[];
  quickReplies: QuickReply[];
  context: TripContext;
  recommendations: Recommendation[];
  handover: boolean | null;
  source: "demo" | "live";
};

export class RasaUnavailableError extends Error {
  constructor(message = "The Rasa travel assistant is temporarily unavailable.") {
    super(message);
    this.name = "RasaUnavailableError";
  }
}

export function rasaContextSlotValues(context: TripContext): Record<string, unknown> {
  const locationMode = context.locationConsentMode === "skipped"
    ? "none"
    : context.locationConsentMode;
  const activityPreferences = (context as TripContextWithActivities).activityPreferences;
  return {
    origin: context.origin,
    destination: context.destination,
    location: locationMode === "manual" ? context.currentLocation : null,
    stopovers: context.stopovers,
    travel_dates: context.dateRange,
    travelers: context.travellerCount,
    budget: context.budget,
    transport_preference: context.transportPreferences[0] ?? null,
    accessibility_need: context.accessibilityNeeds[0] ?? null,
    sustainability_level: context.sustainabilityPriority,
    accommodation_need: context.accommodationNeeds[0] ?? null,
    activity_preferences: activityPreferences?.length ? activityPreferences : null,
    location_mode: locationMode,
    review_confirmation: context.reviewConfirmation,
  };
}

function guidedPayload(payload?: string): GuidedPayload | null {
  if (!payload) return null;
  if (payload === PLANNER_GUIDED_PAYLOAD || payload === PLANNER_GREETING_PAYLOAD) return null;
  const prefix = payload.startsWith(PLANNER_SLOT_PREFIX)
    ? PLANNER_SLOT_PREFIX
    : payload.startsWith(PLANNER_EDIT_PREFIX)
      ? PLANNER_EDIT_PREFIX
      : null;
  const body = prefix ? payload.slice(prefix.length) : payload.startsWith("/guided_slot")
    ? payload.slice("/guided_slot".length)
    : null;
  if (body === null) return null;
  try {
    const values = JSON.parse(body) as unknown;
    const item = record(values);
    if (!item) throw new TypeError("The guided slot payload is invalid.");
    const safeValues: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(item)) {
      if (!GUIDED_SLOT_NAMES.has(name)) throw new TypeError("The guided slot payload contains an unsupported slot.");
      const validArray = Array.isArray(value) && value.every((entry) =>
        typeof entry === "string" && entry.length <= 120 && !/[\u0000-\u001f\u007f]/.test(entry));
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && !validArray) {
        throw new TypeError("The guided slot payload contains an invalid value.");
      }
      if (typeof value === "string" && (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) {
        throw new TypeError("The guided slot payload contains an invalid value.");
      }
      safeValues[name] = value;
    }
    if (!Object.keys(safeValues).length) throw new TypeError("The guided slot payload is empty.");
    return { kind: prefix === PLANNER_EDIT_PREFIX ? "edit" : "slot", values: safeValues };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("The guided slot payload is invalid.");
  }
}

const TRIP_SLOT_NAMES = new Set([
  "origin", "destination", "stopovers", "travel_dates", "travelers", "budget",
  "transport_preference", "accessibility_need", "sustainability_level",
  "accommodation_need", "activity_preferences", "location_mode", "location",
  "review_confirmation",
]);

export function rasaConversationNeedsContextBootstrap(trackerValue: unknown): boolean {
  const tracker = record(trackerValue);
  if (!tracker) return true;
  const activeLoop = record(tracker.active_loop);
  if (text(activeLoop?.name)) return false;

  const slots = record(tracker.slots) ?? {};
  if (Object.entries(slots).some(([name, value]) => {
    if (!TRIP_SLOT_NAMES.has(name) || value === null || value === undefined || value === "") return false;
    return !Array.isArray(value) || value.length > 0;
  })) return false;

  const events = Array.isArray(tracker.events) ? tracker.events : [];
  const latestSessionStartedIndex = events.reduce((lastIndex, rawEvent, index) =>
    record(rawEvent)?.event === "session_started" ? index : lastIndex, -1);
  const currentSessionEvents = latestSessionStartedIndex >= 0
    ? events.slice(latestSessionStartedIndex + 1)
    : events;
  const hasConversationTurn = currentSessionEvents.some((rawEvent) => {
    const event = record(rawEvent);
    if (!event) return false;
    if (event.event === "user") return true;
    if (event.event === "action") {
      const name = text(event.name);
      return Boolean(name && name !== "action_listen" && name !== "action_session_start");
    }
    return event.event === "active_loop" && text(event.name) !== null;
  });
  return !hasConversationTurn;
}

export function rasaSlotValuesForTurn(
  trackerValue: unknown,
  context: TripContext,
  payload?: string,
  wireMessage?: string,
): Record<string, unknown> {
  const values = rasaConversationNeedsContextBootstrap(trackerValue)
    ? rasaContextSlotValues(context)
    : {};
  const guided = guidedPayload(payload);
  if (guided) Object.assign(values, guided.values);
  if (wireMessage?.startsWith("/correct_information")) {
    const body = wireMessage.slice("/correct_information".length);
    let hasCorrection = false;
    try {
      const corrections = body.trim() ? record(JSON.parse(body)) : null;
      if (corrections) {
        for (const name of ["origin", "destination"]) {
          if (Object.prototype.hasOwnProperty.call(corrections, name)) {
            values[name] = corrections[name];
            hasCorrection = true;
          }
        }
      }
    } catch {
      throw new TypeError("The correction payload is invalid.");
    }
    if (hasCorrection) values.review_confirmation = null;
  }
  if (guided?.kind === "slot" &&
      Object.keys(guided.values).some((name) => name !== "review_confirmation")) {
    values.review_confirmation = null;
  }
  if (guided?.kind === "edit" && !Object.prototype.hasOwnProperty.call(guided.values, "review_confirmation")) {
    values.review_confirmation = null;
  }
  if (payload === "/confirm_review" || wireMessage === "/confirm_review") {
    values.review_confirmation = true;
  }
  return values;
}

export function plannerRequestedSlotFromReplies(replies: QuickReply[]): string | null {
  const marker = replies.find((reply) => reply.payload.startsWith(PLANNER_SLOT_PREFIX));
  return marker ? marker.payload.slice(PLANNER_SLOT_PREFIX.length) : null;
}

export function isValidRasaButtonPayload(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2000 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function rasaWireMessage(message: string, context: TripContext, payload?: string): string {
  if (payload !== undefined) {
    if (!isValidRasaButtonPayload(payload)) {
      throw new TypeError("The assistant button payload is invalid.");
    }
    if (payload === PLANNER_GREETING_PAYLOAD) return "/greet";
    if (payload === PLANNER_GUIDED_PAYLOAD || guidedPayload(payload)) return "/guided_continue";
    return payload;
  }
  if (/^(speak|talk)\s+to\s+(a\s+)?(human|person|advisor)/i.test(message.trim())) {
    return "/request_handover";
  }
  // Closing acknowledgements must not fall through to an unsupported dialogue
  // prediction after recommendations. Do not rewrite thanks followed by a
  // question, correction or another trip detail.
  if (/^(?:(?:thank you|thanks)(?:\s+(?:so much|a lot|for (?:your|the) help))?(?:\s*[,!.]\s*|\s+)?(?:(?:i(?:\s+am|'m|’m)\s+done|that(?:\s+is|'s|’s)\s+all)(?:\s+for (?:now|today))?)?|i(?:\s+am|'m|’m)\s+done(?:\s+for (?:now|today))?)[.!]*$/i.test(message.trim())) {
    return "/goodbye";
  }
  // The guided route submission starts the form, rather than asking Core to
  // infer a next action for an unhandled inform intent outside any active loop.
  if (context.origin && context.destination &&
      /^I am travelling from .+ to .+\.$/i.test(message.trim())) {
    return "/plan_trip";
  }
  const correction = message.trim().match(/^(?:please\s+)?(?:change|switch|update|correct|set)\s+(?:(?:my|the)\s+)?(destination|origin)\s+to\s+(.+?)(?:\s+instead)?[.!?]?$/i);
  if (correction) {
    const value = correction[2].trim().replace(/[.!?]+$/, "");
    if (value && value.length <= 80 && !/[\r\n]/.test(value)) {
      return `/correct_information${JSON.stringify({ [correction[1].toLowerCase()]: value })}`;
    }
  }
  // Vague correction requests must not be guessed as confirmation or refusal.
  // Rasa presents a field selector without changing the existing trip.
  if (/^(?:please\s+)?(?:correct|change|edit|update)\s+(?:a\s+detail|something|my trip|the trip details)[.!?]?$/i.test(message.trim()) ||
      /^(?:no[,\s]+)?wait\b/i.test(message.trim())) return "/correct_information";
  const isPlannerConfirmation =
    context.reviewConfirmation === true &&
    /^confirm these trip details and show my best options\.?$/i.test(message.trim());
  return isPlannerConfirmation ? "/confirm_review" : message;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function rasaPromptBoundCityMessage(message: string, trackerValue: unknown, parsedValue: unknown): string | null {
  const tracker = record(trackerValue);
  if (record(tracker?.active_loop)?.name !== "trip_form") return null;
  const slot = record(tracker?.slots)?.requested_slot;
  if (slot !== "origin" && slot !== "destination" && slot !== "location") return null;
  const value = message.trim().replace(/[.!?]+$/, "").trim();
  if (value.length > 120 || !/^[\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,4}$/u.test(value)) return null;
  if (/^(?:hello|hi|thanks?|thank you|bye|goodbye|yes|no|cancel|stop|restart|help|skip|continue|back)$/i.test(value)) return null;
  const parsed = record(parsedValue);
  const spans = [
    ...(Array.isArray(parsed?.geographic_spans) ? parsed.geographic_spans : []),
    ...(Array.isArray(parsed?.entities) ? parsed.entities.filter((entity) =>
      ["origin", "destination", "stopover", "location"].includes(String(record(entity)?.entity))) : []),
  ];
  if (!spans.some((span) =>
    text(record(span)?.value)?.toLocaleLowerCase() === value.toLocaleLowerCase())) return null;
  // Role comes from the server's actual Rasa prompt, never the browser context
  // or the classifier's guess for a bare city. Rasa still validates the value.
  return `/inform${JSON.stringify({ [slot]: value })}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactIsoDateRange(message: string): string | null {
  const match = message.match(/\b(20\d{2}-\d{2}-\d{2})\s+to\s+(20\d{2}-\d{2}-\d{2})\b/);
  if (!match) return null;

  const isValidDate = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  };
  if (!isValidDate(match[1]) || !isValidDate(match[2]) || match[1] > match[2]) return null;
  return `${match[1]} to ${match[2]}`;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((item): item is string => Boolean(item));
  const single = text(value);
  return single ? [single] : [];
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tripContextFromRasaSlots(slotsValue: unknown): TripContext {
  const slots = record(slotsValue) ?? {};
  const locationMode = text(slots.location_mode);
  return {
    origin: text(slots.origin),
    destination: text(slots.destination),
    currentLocation: locationMode === "manual" ? text(slots.location) : null,
    stopovers: stringList(slots.stopovers),
    dateRange: text(slots.travel_dates),
    travellerCount: numberValue(slots.travelers),
    budget: text(slots.budget),
    transportPreferences: stringList(slots.transport_preference),
    accessibilityNeeds: stringList(slots.accessibility_need),
    sustainabilityPriority: text(slots.sustainability_level),
    accommodationNeeds: stringList(slots.accommodation_need),
    activityPreferences: stringList(slots.activity_preferences),
    locationConsentMode: locationMode === "none" ? "skipped" : locationMode,
    reviewConfirmation: typeof slots.review_confirmation === "boolean" ? slots.review_confirmation : null,
    handoverRequested: Boolean(text(slots.handover_id)),
  } as TripContextWithActivities;
}

function recommendationFromRasa(value: unknown, destination: string | null): Recommendation | null {
  const item = record(value);
  if (!item) return null;
  const id = text(item.id);
  const name = text(item.name);
  const carbonKg = numberValue(item.carbon_kg);
  const priceEur = numberValue(item.price_eur);
  if (!id || !name || carbonKg === null) return null;
  const typeValue = text(item.type);
  const type: Recommendation["type"] =
    typeValue === "stay" || typeValue === "experience" || typeValue === "offset"
      ? typeValue
      : "transport";
  const carbonLabel: Recommendation["carbonLabel"] =
    carbonKg <= 50 ? "low" : carbonKg <= 150 ? "moderate" : "high";
  const recommendation: Recommendation & {
    durationMinutes?: number;
    changes?: number;
    rankingExplanation?: string;
  } = {
    id,
    type,
    name,
    location: destination ?? "Trip option",
    description: text(item.description) ??
      "Rasa-ranked illustrative option. Confirm live price, availability, and route details before booking.",
    price: priceEur === null ? "Not available — check provider" : `€${priceEur.toFixed(0)} per traveller · indicative`,
    carbonKg,
    carbonLabel,
    score: Math.round(numberValue(item.score) ?? 0),
    certification: text(item.certification),
    source: text(item.source) ?? "Rasa demonstration data",
    verifiedAt: text(item.verified_at) ?? new Date().toISOString(),
    tags: ["Rasa ranked", "illustrative estimate"],
  };
  const durationMinutes = numberValue(item.duration_minutes ?? item.durationMinutes);
  const changes = numberValue(item.changes);
  const rankingExplanation = text(item.ranking_explanation ?? item.rankingExplanation);
  if (durationMinutes !== null && durationMinutes >= 0) recommendation.durationMinutes = durationMinutes;
  if (changes !== null && changes >= 0) recommendation.changes = changes;
  if (rankingExplanation) recommendation.rankingExplanation = rankingExplanation;
  return recommendation;
}

function quickRepliesFromRequestedSlot(requestedSlot: string | null, context?: TripContext): QuickReply[] {
  const replies = (titles: string[]) => titles.map((title) => ({ title, payload: title }));
  switch (requestedSlot) {
    case "destination": {
      // Examples are context-dependent, not purported live destinations or routes.
      const examples = ["Paris", "Amsterdam", "Copenhagen", "Berlin", "Lisbon", "Prague", "Barcelona"];
      const origin = context?.origin?.toLowerCase() ?? "";
      const stopovers = context?.stopovers.map((value) => value.toLowerCase()) ?? [];
      const available = examples.filter((city) => city.toLowerCase() !== origin && !stopovers.includes(city.toLowerCase()));
      return replies(available.slice(origin ? 1 : 0, origin ? 4 : 3));
    }
    case "travel_dates": return replies(["This weekend", "Next month", "Dates are flexible"]);
    case "travelers": return replies(["1 traveller", "2 travellers", "4 travellers"]);
    case "budget": return replies(["Under €1,000", "€1,000–2,500", "Flexible budget"]);
    case "transport_preference": return replies(["Rail", "Coach", "Flight", "Flexible"]);
    case "accessibility_need": return replies(["None", "Step-free access", "Wheelchair access", "Mobility assistance"]);
    case "sustainability_level": return replies(["Climate-first", "Balanced", "Comfort-first"]);
    case "accommodation_need": return replies(["Hotel", "Hostel", "Apartment", "None"]);
    case "activity_preferences": return replies(["Cultural experiences", "Outdoor activities", "Nature and wildlife", "No preference"]);
    case "location_mode": return replies(["Use approximate device location", "Enter a city manually", "Skip location"]);
    case "location": return [];
    default: return [];
  }
}

export function mapRasaResult(messagesValue: unknown, trackerValue: unknown): RasaAssistantResult {
  const tracker = record(trackerValue) ?? {};
  const slots = record(tracker.slots) ?? {};
  const context = tripContextFromRasaSlots(slots);
  const rasaMessages = Array.isArray(messagesValue) ? messagesValue : [];
  const messages: string[] = [];
  const quickReplies: QuickReply[] = [];
  const recommendations: Recommendation[] = [];
  let handover: boolean | null = null;
  let source: "demo" | "live" = "demo";

  for (const raw of rasaMessages) {
    const message = record(raw) as RasaMessage | null;
    if (!message) continue;
    const messageText = text(message.text);
    if (messageText) messages.push(messageText);
    if (Array.isArray(message.buttons)) {
      for (const rawButton of message.buttons) {
        const button = record(rawButton);
        const title = text(button?.title);
        if (!button || !title || title.length > 200) continue;
        const payload = button.payload === undefined ? title : button.payload;
        if (isValidRasaButtonPayload(payload)) quickReplies.push({ title, payload });
      }
    }
    const custom = record(message.custom);
    if (custom?.type === "recommendations" && Array.isArray(custom.items)) {
      for (const item of custom.items) {
        const recommendation = recommendationFromRasa(item, context.destination);
        if (recommendation) recommendations.push(recommendation);
      }
      source = custom.live_amadeus_available === true ? "live" : "demo";
    }
    if (custom?.type === "local_handover_preview") {
      handover = true;
      const explanation = "I can help you request a later reply from a travel advisor. This is not live chat. Review the sharing details and submit the request in the advisor panel; guests can provide a reply email without creating an account. Nothing has been sent yet. Your request reference appears after submission.";
      if (messageText) messages[messages.length - 1] = explanation;
      else messages.push(explanation);
    }
  }

  if (!quickReplies.length) {
    quickReplies.push(...quickRepliesFromRequestedSlot(text(slots.requested_slot), context));
  }
  const requestedSlot = text(slots.requested_slot);
  if (requestedSlot) {
    quickReplies.push({
      title: `Planner input: ${requestedSlot}`,
      payload: `${PLANNER_SLOT_PREFIX}${requestedSlot}`,
    });
  }
  if (!messages.length && !recommendations.length) {
    messages.push("I’m ready for the next trip detail.");
  }

  return { messages, quickReplies, context, recommendations, handover, source };
}

export type AssistantTimingObserver = (name: string, durationMs: number) => void;

function rasaTimingName(path: string): string {
  if (path.endsWith("/tracker")) return "rasa-tracker";
  if (path.endsWith("/webhooks/rest/webhook")) return "rasa-webhook";
  if (path === "/model/parse") return "rasa-parse";
  return "rasa-other";
}

async function rasaFetch(path: string, init?: RequestInit, onTiming?: AssistantTimingObserver): Promise<unknown> {
  const baseUrl = (process.env.RASA_URL || DEFAULT_RASA_URL).replace(/\/$/, "");
  const startedAt = performance.now();
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(RASA_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
    } catch {
      throw new RasaUnavailableError();
    }
    if (!response.ok) {
      throw new RasaUnavailableError(`Rasa returned HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new RasaUnavailableError("Rasa returned an invalid response.");
    }
  } finally {
    onTiming?.(rasaTimingName(path), performance.now() - startedAt);
  }
}

export async function sendRasaMessage(
  sessionId: string,
  message: string,
  context: TripContext,
  payload?: string,
  onTiming?: AssistantTimingObserver,
  snapshot: RecommendationSnapshot | null = null,
): Promise<RasaAssistantResult> {
  return serializeRasaConversation(sessionId, () =>
    sendRasaMessageSerial(sessionId, message, context, payload, onTiming, snapshot));
}

export async function getRasaHandoverContext(sessionId: string): Promise<TripContext> {
  return serializeRasaConversation(sessionId, async () => {
    const tracker = record(await rasaFetch(`/conversations/${encodeURIComponent(sessionId)}/tracker`));
    if (rasaConversationNeedsContextBootstrap(tracker)) {
      throw new RasaUnavailableError("Please resume guided planning before sharing this conversation; its live context is no longer available.");
    }
    return tripContextFromRasaSlots(tracker?.slots);
  });
}

const conversationQueues = new Map<string, Promise<unknown>>();

function serializeRasaConversation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = conversationQueues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  conversationQueues.set(sessionId, current);
  return current.finally(() => {
    if (conversationQueues.get(sessionId) === current) conversationQueues.delete(sessionId);
  });
}

async function sendRasaMessageSerial(
  sessionId: string,
  message: string,
  context: TripContext,
  payload?: string,
  onTiming?: AssistantTimingObserver,
  snapshot: RecommendationSnapshot | null = null,
): Promise<RasaAssistantResult> {
  payload ??= typedPlannerEditPayload(message);
  let wireMessage = rasaWireMessage(message, context, payload);
  const exactDates = exactIsoDateRange(message);
  const guided = guidedPayload(payload);
  const effectiveContext = guided?.kind === "edit" || wireMessage.startsWith("/correct_information{")
    ? { ...context, reviewConfirmation: null }
    : exactDates ? { ...context, dateRange: exactDates } : context;
  const trackerBefore = record(await rasaFetch(`/conversations/${encodeURIComponent(sessionId)}/tracker`, undefined, onTiming));
  const pendingCorrection = record(trackerBefore?.latest_message)?.intent;
  const correctionChoicePending = record(pendingCorrection)?.name === "correct_information" &&
    !record(trackerBefore?.active_loop)?.name && !record(trackerBefore?.slots)?.requested_slot;
  if (payload === undefined && correctionChoicePending && wireMessage === message &&
      /^[\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,4}[.!?]?$/u.test(message.trim()) &&
      !/^(?:hello|hi|thanks?|bye|yes|no|cancel|stop|help|skip|continue)$/i.test(message.trim())) {
    const parsed = record(await rasaFetch("/model/parse", {
      method: "POST", body: JSON.stringify({ text: message }),
    }, onTiming));
    if (Array.isArray(parsed?.geographic_spans) && parsed.geographic_spans.some((span) =>
        text(record(span)?.value)?.toLocaleLowerCase() === message.trim().toLocaleLowerCase())) {
      wireMessage = "/correct_information";
    }
  }
  const authoritativeContext = rasaConversationNeedsContextBootstrap(trackerBefore)
    ? context : tripContextFromRasaSlots(trackerBefore?.slots);
  const readOnlyReply = payload === undefined ? plannerFollowupReply(message, authoritativeContext, snapshot) : null;
  const readOnlyResult = (reply: string): RasaAssistantResult => ({
    ...mapRasaResult([{ text: reply, buttons: [{ title: "Continue guided planning", payload: PLANNER_GUIDED_PAYLOAD }] }], trackerBefore),
    context: authoritativeContext,
    source: snapshot?.source ?? "demo",
  });
  if (readOnlyReply) return readOnlyResult(readOnlyReply);
  if (payload === undefined && wireMessage === message &&
      record(trackerBefore?.active_loop)?.name === "trip_form" &&
      ["origin", "destination", "location"].includes(String(record(trackerBefore?.slots)?.requested_slot)) &&
      message.trim().length <= 120 &&
      /^[\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*){0,4}[.!?]?$/u.test(message.trim())) {
    const parsed = await rasaFetch("/model/parse", {
      method: "POST", body: JSON.stringify({ text: message }),
    }, onTiming);
    let bound = rasaPromptBoundCityMessage(message, trackerBefore, parsed);
    if (!bound) {
      // Bare names are harder for spaCy than names in a travel sentence. The
      // role cue is supplied by the actual active form, not invented trip data.
      // Only geographical spans count here: cue-generated rule entities alone
      // are not evidence that an arbitrary noun is a place.
      const slot = record(trackerBefore?.slots)?.requested_slot;
      const contextual = record(await rasaFetch("/model/parse", {
        method: "POST",
        body: JSON.stringify({ text: `I am travelling ${slot === "destination" ? "to" : "from"} ${message.trim()}` }),
      }, onTiming));
      bound = rasaPromptBoundCityMessage(message, trackerBefore, {
        geographic_spans: contextual?.geographic_spans,
      });
    }
    wireMessage = bound ?? wireMessage;
  }
  const plannerSlotValues = rasaSlotValuesForTurn(trackerBefore, effectiveContext, payload, wireMessage);
  if (exactDates) {
    plannerSlotValues.travel_dates = exactDates;
    plannerSlotValues.review_confirmation = null;
  }
  const turnMetadata: JsonRecord = Object.keys(plannerSlotValues).length
    ? { planner_slot_values: plannerSlotValues } : {};
  if (wireMessage === "/correct_information") turnMetadata.planner_correction_requested = true;
  const tentative = wireMessage === "/correct_information"
    ? message.trim().match(/^(?:no[,\s]+)?wait[,\s]+(.+?)[.!?]?$/i)?.[1]?.trim() ??
      (correctionChoicePending ? message.trim() : undefined)
    : undefined;
  if (tentative && tentative.length <= 80) {
    const parsed = record(await rasaFetch("/model/parse", {
      method: "POST", body: JSON.stringify({ text: message }),
    }, onTiming));
    if (Array.isArray(parsed?.geographic_spans) && parsed.geographic_spans.some((span) =>
        text(record(span)?.value)?.toLocaleLowerCase() === tentative.toLocaleLowerCase())) {
      turnMetadata.planner_correction_candidate = tentative;
    }
  }
  const metadata = Object.keys(turnMetadata).length ? { metadata: turnMetadata } : {};
  // Keep the user's utterance intact for NLU; exact ISO dates are carried in
  // validated planner metadata instead of replacing free text with a command.
  // Rasa's policy has no out-of-form transition for a bare "inform" intent.
  // Start the form first, then deliver the original free text while it is
  // active so its entities still fill slots rather than hanging Core inference.
  if (!wireMessage.startsWith("/")) {
    const activeLoop = record(trackerBefore?.active_loop);
    if (!activeLoop?.name) {
      const parsed = record(await rasaFetch("/model/parse", {
        method: "POST",
        body: JSON.stringify({ text: wireMessage }),
      }, onTiming));
      const intent = record(parsed?.intent)?.name;
      if (authoritativeContext.reviewConfirmation &&
          (intent === "inform" || intent === "nlu_fallback")) {
        return readOnlyResult("I couldn't identify a specific follow-up request. You can ask What is the cheapest?, ask What is guided planning?, or type Change activities, Change dates, or Change budget. Your trip is unchanged and no new search has started.");
      }
      if (intent === "inform") {
        await rasaFetch("/webhooks/rest/webhook", {
          method: "POST",
          body: JSON.stringify({ sender: sessionId, message: "/plan_trip", ...metadata }),
        }, onTiming);
      }
    }
  }
  const rasaMessages = await rasaFetch("/webhooks/rest/webhook", {
    method: "POST",
    body: JSON.stringify({ sender: sessionId, message: wireMessage, ...metadata }),
  }, onTiming);
  const tracker = await rasaFetch(`/conversations/${encodeURIComponent(sessionId)}/tracker`, undefined, onTiming);
  return mapRasaResult(rasaMessages, tracker);
}