import { createHash, randomUUID } from "node:crypto";
import type { Recommendation, TripContext } from "@workspace/api-zod";
import type { SavedTrip } from "@workspace/db";

export type HandoverTranscriptTurn = { role: "user" | "assistant"; content: string };
export type RecommendationSource = "demo" | "live";
export type RecommendationSnapshot = {
  confirmedAt: string;
  source: RecommendationSource;
  recommendations: Recommendation[];
  unknowns: string[];
  contextFingerprint: string;
};
export type HandoverReason =
  | "multiple_stopovers"
  | "unmet_accessibility"
  | "required_inventory_unavailable"
  | "repeated_failed_clarification";
export type HandoverRecommendation = {
  recommended: boolean;
  reason: HandoverReason | null;
  message: string | null;
};

const MAX_TRANSCRIPT_TURNS = 30;
const MAX_TRANSCRIPT_TURN_LENGTH = 1600;
const MAX_TRANSCRIPT_LENGTH = 12000;
export const MAX_RECOMMENDATIONS = 250;

export function redactHandoverText(value: string): string {
  return value
    .replace(/[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)/g, "[REDACTED LOCATION]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[REDACTED PHONE]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED PAYMENT NUMBER]")
    .replace(/\b\d{1,6}\s+[\w.' -]+\s+(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd)\b/gi, "[REDACTED ADDRESS]")
    .replace(/\b(?:api[-_ ]?key|token|password|secret|passphrase)\s*[:=]\s*\S+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b(?:wheelchair(?: access)?|step[- ]free(?: access)?|mobility assistance|medical assistance|disability|allergy|accessible assistance)\b/gi, "[REDACTED ACCESSIBILITY NEED]")
    .replace(/accessibility\s+.*?(?=,\s+accommodation\b)/gi, "accessibility [REDACTED ACCESSIBILITY NEED]");
}

export function boundAndRedactTranscript(turns: HandoverTranscriptTurn[]): HandoverTranscriptTurn[] {
  const bounded: HandoverTranscriptTurn[] = [];
  let totalLength = 0;
  for (const turn of turns.slice(-MAX_TRANSCRIPT_TURNS)) {
    const content = redactHandoverText(turn.content.trim()).slice(0, MAX_TRANSCRIPT_TURN_LENGTH);
    if (!content) continue;
    const remaining = MAX_TRANSCRIPT_LENGTH - totalLength;
    if (remaining <= 0) break;
    const boundedContent = content.slice(0, remaining);
    bounded.push({ role: turn.role, content: boundedContent });
    totalLength += boundedContent.length;
  }
  return bounded;
}

function safeText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string" || !value) return null;
  return redactHandoverText(value).slice(0, maxLength);
}

function safeList(values: unknown, maxItems = 10, maxLength = 100): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, maxItems)
    .filter((value): value is string => typeof value === "string")
    .map((value) => redactHandoverText(value).slice(0, maxLength))
    .filter(Boolean);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Preserve verified planner dates before the generic privacy redactor treats
 * their long digit sequences as a possible phone number.
 */
export function safePlanningDateRange(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  const exactRange = normalized.match(
    /^(\d{4}-\d{2}-\d{2})(?:\s+(?:to|\/)\s+(\d{4}-\d{2}-\d{2}|Flexible return))?$/i,
  );
  if (exactRange && isValidIsoDate(exactRange[1]) &&
      (!exactRange[2] || exactRange[2].toLowerCase() === "flexible return" || isValidIsoDate(exactRange[2]))) {
    return exactRange[2]
      ? `${exactRange[1]} to ${exactRange[2].toLowerCase() === "flexible return" ? "Flexible return" : exactRange[2]}`
      : exactRange[1];
  }
  return redactHandoverText(normalized).slice(0, 160) || null;
}

function digestText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return createHash("sha256").update(value.trim().toLocaleLowerCase()).digest("hex");
}

function safeFunctionalAccessibilityNeeds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const canonicalSelections = new Map([
    ["wheelchair", "Wheelchair access (step-free required)"],
    ["wheelchair access", "Wheelchair access"],
    ["wheelchair accessible", "Wheelchair access"],
    ["step free", "Step-free access"],
    ["step free access", "Step-free access"],
    ["step free required", "Step-free access"],
    ["mobility", "Limited walking / minimise stairs"],
    ["limited mobility", "Limited walking / minimise stairs"],
    ["limited walking", "Limited walking / minimise stairs"],
    ["limited walking distance", "Limited walking / minimise stairs"],
    ["minimise walking", "Limited walking / minimise stairs"],
    ["minimize walking", "Limited walking / minimise stairs"],
    ["hearing support", "Hearing support"],
    ["hearing assistance", "Hearing support"],
    ["hearing loop", "Hearing support"],
    ["visual support", "Visual support"],
    ["visual assistance", "Visual support"],
    ["vision support", "Visual support"],
    ["braille support", "Visual support"],
  ]);
  const noNeedValues = new Set(["none", "no specific needs", "no needs", "not needed", "standard options are fine"]);
  const result = new Set<string>();
  let needsConfirmation = false;
  for (const value of values.slice(0, 10)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const key = value.trim().normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, " ");
    if (noNeedValues.has(key)) continue;
    const canonical = canonicalSelections.get(key);
    if (canonical) result.add(canonical);
    else needsConfirmation = true;
  }
  if (needsConfirmation) result.add("Additional requirement—confirm with traveller");
  return [...result].slice(0, 10);
}

function sanitizedCertificationEvidence(value: unknown): Recommendation["certificationEvidence"] {
  const evidence = record(value);
  if (!evidence) return undefined;
  const scheme = safeText(evidence.scheme, 160);
  const licenceNumber = safeText(evidence.licenceNumber, 120);
  const validUntil = validDate(evidence.validUntil);
  const checkedAt = validDate(evidence.checkedAt);
  const registryUrl = safeText(evidence.registryUrl, 500);
  const hotelUrl = evidence.hotelUrl === null ? null : safeText(evidence.hotelUrl, 500);
  const address = safeText(evidence.address, 240);
  if (!scheme || !licenceNumber || !validUntil || !checkedAt || !registryUrl || address === null) return undefined;
  return { scheme, licenceNumber, validUntil: new Date(validUntil), checkedAt: new Date(checkedAt), registryUrl, hotelUrl, address };
}

export function sanitizeRecommendation(value: unknown): Recommendation | null {
  const item = record(value);
  if (!item) return null;
  const id = safeText(item.id, 160);
  const name = safeText(item.name, 200);
  const location = safeText(item.location, 200);
  const description = safeText(item.description, 1200);
  const price = safeText(item.price, 200);
  const type = item.type;
  const source = safeText(item.source, 500);
  const verifiedAt = validDate(item.verifiedAt);
  const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null;
  if (!id || !name || !location || !description || !price || !source || !verifiedAt || score === null ||
      !["stay", "transport", "experience", "offset"].includes(String(type))) return null;

  const carbonKg = item.carbonKg === null
    ? null
    : typeof item.carbonKg === "number" && Number.isFinite(item.carbonKg) ? item.carbonKg : null;
  const carbonLabel = item.carbonLabel === null || ["low", "moderate", "high"].includes(String(item.carbonLabel))
    ? item.carbonLabel as Recommendation["carbonLabel"]
    : null;
  const certification = item.certification === null ? null : safeText(item.certification, 240);
  const tags = safeList(item.tags);
  const recommendation: Recommendation = {
    id, type: type as Recommendation["type"], name, location, description, price, carbonKg,
    carbonLabel, score, certification, source, verifiedAt, tags,
  };
  const evidence = sanitizedCertificationEvidence(item.certificationEvidence);
  if (evidence) recommendation.certificationEvidence = evidence;
  if (typeof item.durationMinutes === "number" && Number.isFinite(item.durationMinutes) && item.durationMinutes >= 0) {
    recommendation.durationMinutes = item.durationMinutes;
  }
  if (typeof item.connectionCount === "number" && Number.isInteger(item.connectionCount) && item.connectionCount >= 0) {
    recommendation.connectionCount = item.connectionCount;
  }
  const rankingExplanation = safeText(item.rankingExplanation, 800);
  if (rankingExplanation) recommendation.rankingExplanation = rankingExplanation;
  return recommendation;
}

function recommendationUnknowns(recommendations: Recommendation[], source: RecommendationSource): string[] {
  const unknowns = new Set<string>();
  if (source === "demo") unknowns.add("Options are demonstration/curated data, not live inventory.");
  unknowns.add("Availability and final prices must be confirmed with the provider before booking.");
  for (const option of recommendations) {
    if (option.carbonKg === null) unknowns.add(`${option.name}: no carbon estimate was available.`);
    if (/not available|unavailable/i.test(option.price)) unknowns.add(`${option.name}: price is unavailable.`);
    if (option.type === "stay" && !option.certificationEvidence) {
      unknowns.add(`${option.name}: current certification evidence was not attached.`);
    }
    if (option.type === "transport" && option.durationMinutes === undefined) {
      unknowns.add(`${option.name}: journey duration is unknown.`);
    }
    if (option.type === "transport" && option.connectionCount === undefined) {
      unknowns.add(`${option.name}: connection count is unknown.`);
    }
    if (!option.rankingExplanation) unknowns.add(`${option.name}: no detailed comparative ranking explanation was supplied.`);
  }
  return [...unknowns].slice(0, 100).map((value) => redactHandoverText(value).slice(0, 300));
}

export function createRecommendationSnapshot(
  recommendations: unknown,
  source: unknown,
  confirmedAt: string,
  context: TripContext,
): RecommendationSnapshot {
  const safeSource: RecommendationSource = source === "live" ? "live" : "demo";
  const safeRecommendations = Array.isArray(recommendations)
    ? recommendations.slice(0, MAX_RECOMMENDATIONS)
      .map(sanitizeRecommendation)
      .filter((item): item is Recommendation => item !== null)
    : [];
  return {
    confirmedAt: validDate(confirmedAt) ?? new Date().toISOString(),
    source: safeSource,
    recommendations: safeRecommendations,
    unknowns: recommendationUnknowns(safeRecommendations, safeSource),
    contextFingerprint: tripContextFingerprint(context),
  };
}

export function recommendationSnapshotFromUnknown(value: unknown): RecommendationSnapshot | null {
  const snapshot = record(value);
  if (!snapshot || (snapshot.source !== "demo" && snapshot.source !== "live")) return null;
  const confirmedAt = validDate(snapshot.confirmedAt);
  if (!confirmedAt || !Array.isArray(snapshot.recommendations) ||
      typeof snapshot.contextFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(snapshot.contextFingerprint)) return null;
  const recommendations = snapshot.recommendations.slice(0, MAX_RECOMMENDATIONS)
    .map(sanitizeRecommendation)
    .filter((item): item is Recommendation => item !== null);
  const unknowns = safeList(snapshot.unknowns, 100, 300);
  return { confirmedAt, source: snapshot.source, recommendations, unknowns, contextFingerprint: snapshot.contextFingerprint };
}

export function tripContextFingerprint(context: Partial<TripContext>): string {
  const normalizeText = (value: unknown) => typeof value === "string" ? value.trim().toLocaleLowerCase() : null;
  const normalizeList = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLocaleLowerCase())
    : [];
  const canonical = {
    origin: normalizeText(context.origin),
    destination: normalizeText(context.destination),
    dateRange: safePlanningDateRange(context.dateRange)?.toLocaleLowerCase() ?? null,
    travellerCount: Number.isInteger(context.travellerCount) ? context.travellerCount : null,
    budget: normalizeText(context.budget),
    transportPreferences: normalizeList(context.transportPreferences),
    accommodationNeeds: normalizeList(context.accommodationNeeds),
    activityPreferences: normalizeList(context.activityPreferences),
    sustainabilityPriority: normalizeText(context.sustainabilityPriority),
    stopovers: normalizeList(context.stopovers),
    accessibilityNeedDigests: Array.isArray(context.accessibilityNeeds)
      ? context.accessibilityNeeds.map(digestText).filter((value): value is string => value !== null).sort()
      : [],
    manualLocationDigest: normalizeText(context.locationConsentMode) === "manual" ? digestText(context.currentLocation) : null,
    locationConsentMode: normalizeText(context.locationConsentMode),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function recommendationSnapshotMatchesContext(
  snapshot: RecommendationSnapshot,
  context: Partial<TripContext>,
): boolean {
  return snapshot.contextFingerprint === tripContextFingerprint(context);
}

export function minimizeHandoverContext(
  context: TripContext,
  snapshot: RecommendationSnapshot | null = null,
  selectedRecommendationIds: string[] = [],
) {
  const selected = selectedRecommendationIds.filter((id) => snapshot?.recommendations.some((option) => option.id === id));
  return {
    origin: safeText(context.origin),
    destination: safeText(context.destination),
    dateRange: safePlanningDateRange(context.dateRange),
    travellerCount: context.travellerCount,
    budget: safeText(context.budget),
    transportPreferences: safeList(context.transportPreferences),
    accommodationNeeds: safeList(context.accommodationNeeds),
    activityPreferences: safeList(context.activityPreferences ?? []),
    sustainabilityPriority: safeText(context.sustainabilityPriority),
    stopovers: safeList(context.stopovers),
    accessibilityNeeds: safeFunctionalAccessibilityNeeds(context.accessibilityNeeds),
    locationConsentMode: safeText(context.locationConsentMode, 40),
    recommendationOptions: snapshot?.recommendations ?? [],
    selectedRecommendationIds: selected,
    recommendationSelectionStatus: selected.length ? "explicit_selection" as const : "no_explicit_selection" as const,
    recommendationSource: snapshot?.source ?? null,
    recommendationConfirmedAt: snapshot?.confirmedAt ?? null,
    recommendationUnknowns: snapshot?.unknowns ?? ["No confirmed recommendation snapshot was available for this saved trip."],
  };
}

export function buildHandoverSummary(
  context: TripContext,
  transcriptLength: number,
  recommendationCount = 0,
  selectedCount = 0,
) {
  return [
    context.origin && `Origin: ${safeText(context.origin)}`,
    context.destination && `Destination: ${safeText(context.destination)}`,
    context.dateRange && `Dates: ${safePlanningDateRange(context.dateRange)}`,
    context.budget && `Budget: ${safeText(context.budget)}`,
    context.sustainabilityPriority && `Climate priority: ${safeText(context.sustainabilityPriority)}`,
    `Conversation turns supplied: ${transcriptLength}`,
    recommendationCount > 0 && `Confirmed options: ${recommendationCount}`,
    selectedCount > 0 && `Traveller-selected options: ${selectedCount}`,
  ].filter(Boolean).join(" · ");
}

function isValidatedSandboxInventory(option: Recommendation): boolean {
  const source = option.source.toLocaleLowerCase();
  const tags = option.tags.map((tag) => tag.toLocaleLowerCase());
  const expectedId = option.type === "stay" ? /^duffel-stay-/i : option.type === "transport" ? /^duffel-flight-/i : null;
  const hasQuotedPrice = /(?:\b[A-Z]{3}\s*|\p{Sc}\s*)\d[\d,.]*/u.test(option.price) &&
    !/not available|unavailable/i.test(option.price);
  return Boolean(
    expectedId?.test(option.id) &&
    source.includes("duffel test mode") &&
    tags.includes("live test offer") &&
    hasQuotedPrice,
  );
}

function transportInventoryMatchesNeed(option: Recommendation, need: string): boolean {
  const text = `${option.name} ${option.description} ${option.tags.join(" ")}`.toLocaleLowerCase();
  if (/\b(?:rail|train|eurostar)\b/.test(need.toLocaleLowerCase())) return /\b(?:rail|train|eurostar)\b/.test(text);
  if (/\b(?:flight|air|plane)\b/.test(need.toLocaleLowerCase())) return /\b(?:flight|air|plane)\b/.test(text);
  if (/\bbus\b/.test(need.toLocaleLowerCase())) return /\bbus\b/.test(text);
  if (/\bferry|boat\b/.test(need.toLocaleLowerCase())) return /\bferry|boat\b/.test(text);
  return true;
}

function affirmativelySupportsAccessibilityNeed(option: Recommendation, need: string): boolean {
  const text = `${option.name} ${option.description} ${option.tags.join(" ")}`.toLocaleLowerCase();
  const accessibilityTerms =
    "(?:wheelchair|step[- ]free|accessible|mobility|level access|hearing|deaf|braille|blind|visual|allerg|allergen|gluten|dairy|peanut|service animal|guide dog)";
  const uncertaintyTerms =
    "(?:not|no|unknown|unverified|unconfirmed|unspecified|cannot confirm|unable to confirm|not guaranteed|subject to availability|must be confirmed|requires? confirmation|needs? confirmation|check with (?:the )?provider|contact (?:the )?provider|can request|can be requested|provider confirmation required)";
  const caveat = new RegExp(
    `(?:\\b${uncertaintyTerms}\\b[^.!?]{0,100}\\b${accessibilityTerms}\\b|\\b${accessibilityTerms}\\b[^.!?]{0,100}\\b${uncertaintyTerms}\\b)`,
    "i",
  );
  if (caveat.test(text)) return false;

  const requested = need.toLocaleLowerCase();
  if (/wheelchair|mobility|step[- ]?free|physical access|level access|accessible/.test(requested)) {
    return /\bwheelchair[- ]accessible\s+(?:entrance|room|bathroom|toilet|shower|facilities|property|vehicle|transport)\b|\b(?:wheelchair|step[- ]free|level) access (?:is )?(?:available|provided|offered|included)\b|\bstep[- ]free (?:entrance|entry|route|room|bathroom|facility|facilities) (?:is )?(?:available|provided|offered|included)\b/.test(text);
  }
  if (/hearing|deaf|hard of hearing/.test(requested)) {
    return /\bhearing loop (?:is )?(?:available|provided|offered|installed)\b|\bassistive listening (?:system|device) (?:is )?(?:available|provided|offered)\b|\bvisual (?:alarm|alert) (?:is )?(?:available|provided|offered|installed)\b|\b(?:hearing|deaf) assistance (?:is )?(?:available|provided|offered)\b|\bhard of hearing (?:support|access) (?:is )?(?:available|provided|offered)\b/.test(text);
  }
  if (/blind|vision|visual impairment|low vision/.test(requested)) {
    return /\bbraille (?:signage|menus?|information|materials?) (?:is |are )?(?:available|provided|offered)\b|\btactile (?:signage|markers|guidance) (?:is |are )?(?:available|provided|offered)\b|\bguide dog (?:is )?(?:welcome|accepted|permitted)\b|\baudio navigation (?:is )?(?:available|provided|offered)\b|\bvisually impaired (?:access|support) (?:is )?(?:available|provided|offered)\b/.test(text);
  }
  if (/allerg|allergen|gluten|dairy|peanut|nut allergy|dietary/.test(requested)) {
    const allergens = ["peanut", "nuts?", "gluten", "dairy", "milk", "eggs?", "soy", "shellfish", "sesame"];
    const specificAllergen = allergens.find((allergen) => new RegExp(`\\b${allergen}\\b`, "i").test(requested));
    if (specificAllergen) {
      return new RegExp(`\\b${specificAllergen}[- ]free\\b|\\bfree of ${specificAllergen}\\b`, "i").test(text);
    }
    return /\ballergy[- ]safe (?:meal|food|menu|option) (?:is )?(?:available|provided|offered)\b|\ballergen[- ]aware (?:menu|service|option) (?:is )?(?:available|provided|offered)\b|\ballergy accommodation (?:is )?(?:available|provided)\b/.test(text);
  }
  if (/service animal|assistance dog|guide dog/.test(requested)) {
    return /\b(?:service animal|assistance dog|guide dog) (?:is )?(?:welcome|accepted|permitted)\b/.test(text);
  }
  return false;
}

export function recommendComplexCaseHandover(
  context: TripContext,
  recommendations: Recommendation[],
  clarificationFailureCount: number,
): HandoverRecommendation {
  const complete = context.reviewConfirmation === true &&
    Boolean(context.origin && context.destination && context.dateRange && context.budget) &&
    context.travellerCount !== null &&
    context.transportPreferences.length > 0 &&
    context.accommodationNeeds.length > 0 &&
    context.accessibilityNeeds.length > 0 &&
    context.locationConsentMode !== null &&
    !(context.locationConsentMode === "manual" && !context.currentLocation);
  if (!complete && clarificationFailureCount >= 2) {
    return {
      recommended: true,
      reason: "repeated_failed_clarification",
      message: "I’m having trouble understanding a planning detail. You can ask an advisor for help; nothing will be sent unless you sign in, save this trip, and explicitly consent.",
    };
  }
  if (!complete) return { recommended: false, reason: null, message: null };

  if (context.stopovers.length > 1) {
    return {
      recommended: true,
      reason: "multiple_stopovers",
      message: "This itinerary includes several stopovers and may need expert coordination.",
    };
  }

  const accessibilityNeeds = context.accessibilityNeeds
    .filter((need) => !/^(none|no specific needs|not needed)$/i.test(need.trim()));
  const unmetAccessibilityNeed = accessibilityNeeds.find((need) =>
    !recommendations.some((option) => isValidatedSandboxInventory(option) && affirmativelySupportsAccessibilityNeed(option, need)),
  );
  if (unmetAccessibilityNeed) {
    return {
      recommended: true,
      reason: "unmet_accessibility",
      message: "The returned provider-validated options do not affirmatively verify every requested accessibility need; an advisor can check these requirements.",
    };
  }

  const requiredAccommodation = context.accommodationNeeds.some((need) => !/^(none|no preference|flexible)$/i.test(need.trim()));
  const requiredTransportNeeds = context.transportPreferences
    .filter((need) => !/^(none|flexible|compare all)$/i.test(need.trim()))
    .flatMap((need) => need.split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i))
    .filter(Boolean);
  const hasRoomInventory = recommendations.some((option) => option.type === "stay" && isValidatedSandboxInventory(option));
  const missingTransportInventory = requiredTransportNeeds.some((need) =>
    !recommendations.some((option) =>
      option.type === "transport" &&
      isValidatedSandboxInventory(option) &&
      transportInventoryMatchesNeed(option, need),
    ),
  );
  if ((requiredAccommodation && !hasRoomInventory) || missingTransportInventory) {
    return {
      recommended: true,
      reason: "required_inventory_unavailable",
      message: "No validated live or sandbox inventory was returned for a required accommodation or transport preference; an advisor can check availability.",
    };
  }

  if (clarificationFailureCount >= 2) {
    return {
      recommended: true,
      reason: "repeated_failed_clarification",
      message: "The assistant has needed repeated clarification; an advisor can help resolve the remaining planning details.",
    };
  }
  return { recommended: false, reason: null, message: null };
}

export function isClarificationFailure(messages: string[]): boolean {
  return messages.some((message) =>
    /\b(?:i['’]?m|i am) not certain what you meant\b|\bi (?:could not|couldn['’]?t) follow\b|\bi could not treat that as a travel detail\b|\bi still did not follow\b|\bcould you say that a different way\b|\bplease rephrase\b|\bcould you repeat\b|\bi didn['’]?t understand what you meant\b/i.test(message),
  );
}

export function nextClarificationFailureCount(
  previousCount: number,
  messages: string[],
  successfulResolution: boolean,
): number {
  const safePreviousCount = Number.isInteger(previousCount) ? Math.max(0, previousCount) : 0;
  if (isClarificationFailure(messages)) return Math.min(100, safePreviousCount + 1);
  if (successfulResolution) return 0;
  return safePreviousCount;
}

export function contextFromSavedTrip(trip: SavedTrip): TripContext {
  const stored = (trip.context ?? {}) as Partial<TripContext>;
  return {
    origin: safeText(trip.origin ?? stored.origin ?? null),
    destination: safeText(trip.destination ?? stored.destination ?? null),
    currentLocation: stored.locationConsentMode === "manual" && typeof stored.currentLocation === "string"
      ? stored.currentLocation
      : null,
    stopovers: Array.isArray(stored.stopovers) ? stored.stopovers.slice(0, 10) : [],
    dateRange: safePlanningDateRange(trip.dateRange ?? stored.dateRange ?? null),
    travellerCount: trip.travellerCount ?? stored.travellerCount ?? null,
    budget: safeText(trip.budget ?? stored.budget ?? null),
    transportPreferences: Array.isArray(stored.transportPreferences) ? stored.transportPreferences.slice(0, 10) : [],
    accessibilityNeeds: Array.isArray(stored.accessibilityNeeds) ? stored.accessibilityNeeds : [],
    sustainabilityPriority: safeText(trip.sustainabilityPriority ?? stored.sustainabilityPriority ?? null),
    accommodationNeeds: Array.isArray(stored.accommodationNeeds) ? stored.accommodationNeeds.slice(0, 10) : [],
    activityPreferences: Array.isArray(stored.activityPreferences) ? stored.activityPreferences.slice(0, 10) : [],
    locationConsentMode: safeText(stored.locationConsentMode ?? null, 40),
    reviewConfirmation: true,
    handoverRequested: true,
  };
}

type NotificationResult = { status: "accepted" | "pending" | "failed" | "not_configured"; error?: string };

export async function notifyAdvisorInbox(handoverId: string, summary: string): Promise<NotificationResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const recipient = (process.env.RECRUITMENT_NOTIFICATION_EMAIL ?? process.env.RECRUITMENT_OWNER_EMAIL ?? process.env.RECRUITMENT_EMAIL)?.trim();
  if (!apiKey || !recipient) return { status: "not_configured", error: "notification_not_configured" };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      signal: AbortSignal.timeout(8_000),
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL?.trim() ?? "Landa Travels <onboarding@resend.dev>",
        to: [recipient],
        subject: `New Landa Travels advisor handover ${handoverId}`,
        text: `A traveller requested advisor support.\n\nReference: ${handoverId}\n${summary}\n\nOpen the authorized advisor inbox to assign and reply.`,
      }),
    });
    if (!response.ok) return { status: "failed", error: `provider_http_${response.status}` };
    return { status: "accepted" };
  } catch {
    return { status: "failed", error: "provider_unreachable" };
  }
}

export async function notifyGuestAdvisorReply(handoverId: string, recipient: string, reply: string): Promise<NotificationResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { status: "not_configured", error: "reply_email_not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
        "Idempotency-Key": `advisor-reply-${handoverId}-${createHash("sha256").update(reply).digest("hex")}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL?.trim() ?? "Landa Travels <onboarding@resend.dev>",
        to: [recipient], subject: `Landa Travels advisor reply — ${handoverId}`,
        reply_to: (process.env.ADVISOR_REPLY_TO_EMAIL ?? process.env.RECRUITMENT_NOTIFICATION_EMAIL ?? process.env.RECRUITMENT_EMAIL)?.trim(),
        text: `An advisor has replied to your request ${handoverId}.\n\n${reply}\n\nThis is a response to your consented trip-support request. Nothing has been booked. You can also read this reply in the original planning tab while your guest session remains available.`,
      }),
    });
    return response.ok ? { status: "accepted" } : { status: "failed", error: `provider_http_${response.status}` };
  } catch { return { status: "failed", error: "provider_unreachable" }; }
}

export function newHandoverId() {
  return `LANDA-${randomUUID().slice(0, 8).toUpperCase()}`;
}
