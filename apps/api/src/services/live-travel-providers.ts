import type { Recommendation, TripContext } from "@workspace/api-zod";
import type { AssistantTimingObserver } from "./rasa-gateway";

const DUFFEL_API = "https://api.duffel.com";
const CLIMATIQ_API = "https://api.climatiq.io";
const VERIFIED_AT = new Date().toISOString().slice(0, 10);
// Bound each remote operation; the overall trip calculation is still measured separately.
const TIMEOUT_MS = 2_300;
export const LIVE_TRAVEL_SEARCH_DEADLINE_MS = 1_700;

type Place = {
  name: string;
  iataCode: string;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

type ProviderResult = {
  recommendations: Recommendation[];
  source: "live" | "demo";
  notice: string;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" ? value as JsonRecord : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Do not infer journey speed from transport mode or fabricate missing timings. */
export function flightConvenience(offer: JsonRecord): { durationMinutes?: number; connectionCount?: number } {
  if (!Array.isArray(offer.slices) || offer.slices.length === 0) return {};
  const slices = offer.slices.map(record);
  const durations = slices.map((slice) => {
    const duration = stringValue(slice?.duration);
    const match = duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (!match || !match.slice(1).some(Boolean)) return null;
    const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) + Number(match[3] ?? 0) / 60;
    return minutes > 0 && Number.isFinite(minutes) ? minutes : null;
  });
  const connections = slices.map((slice) => Array.isArray(slice?.segments) && slice.segments.length > 0
    ? slice.segments.length - 1 : null);
  return {
    ...(durations.every((value): value is number => value !== null)
      ? { durationMinutes: durations.reduce((sum, value) => sum + value, 0) } : {}),
    ...(connections.every((value): value is number => value !== null)
      ? { connectionCount: connections.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

function parseDate(value: string | null): { checkIn: string; checkOut: string } | null {
  if (!value) return null;
  const match = value.match(/(20\d{2}-\d{2}-\d{2})(?:\s*(?:to|[-–])\s*(20\d{2}-\d{2}-\d{2}))?/);
  if (match) {
    const start = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(start.valueOf())) return null;
    if (!match[2]) return { checkIn: match[1], checkOut: addDays(match[1], 2) };
    const end = new Date(`${match[2]}T00:00:00Z`);
    if (Number.isNaN(end.valueOf()) || end <= start) return null;
    return { checkIn: match[1], checkOut: match[2] };
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/this\s+weekend/i.test(value)) {
    const daysUntilSaturday = (6 - start.getUTCDay() + 7) % 7;
    start.setUTCDate(start.getUTCDate() + daysUntilSaturday);
    return { checkIn: iso(start), checkOut: addDays(iso(start), 2) };
  }
  if (/next\s+week/i.test(value)) {
    start.setUTCDate(start.getUTCDate() + (8 - start.getUTCDay()) % 7 + 7);
    return { checkIn: iso(start), checkOut: addDays(iso(start), 2) };
  }
  if (/next\s+month/i.test(value)) {
    start.setUTCMonth(start.getUTCMonth() + 1, 1);
    return { checkIn: iso(start), checkOut: addDays(iso(start), 3) };
  }
  return null;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return iso(parsed);
}

function providerTimingName(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.includes("/places/suggestions")) return "duffel-place";
  if (pathname.includes("/air/offer_requests")) return "duffel-flights";
  if (pathname.includes("/air/offers")) return "duffel-offer-page";
  if (pathname.includes("/stays/search")) return "duffel-stays";
  if (pathname.includes("/data/v1/estimate")) return "climatiq-estimate";
  return "provider-other";
}

async function requestJson(
  url: string,
  init: RequestInit,
  onTiming?: AssistantTimingObserver,
  deadlineSignal?: AbortSignal,
): Promise<unknown | null> {
  const startedAt = performance.now();
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = deadlineSignal ? AbortSignal.any([deadlineSignal, timeout]) : timeout;
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    onTiming?.(providerTimingName(url), performance.now() - startedAt);
  }
}

function providerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Duffel-Version": "v2",
    Authorization: `Bearer ${token}`,
  };
}

function choosePlace(value: unknown): Place | null {
  const data = record(value);
  if (!data) return null;
  const coordinates = record(data.geographic_coordinates);
  const firstAirport = Array.isArray(data.airports) ? record(data.airports[0]) : null;
  const iataCode = stringValue(data.iata_code);
  const name = stringValue(data.name);
  if (!iataCode || !name || !/^[A-Z0-9]{3}$/i.test(iataCode)) return null;
  return {
    name,
    iataCode: iataCode.toUpperCase(),
    countryCode: stringValue(data.iata_country_code),
    latitude: finiteNumber(data.latitude) ??
      finiteNumber(coordinates?.latitude) ??
      finiteNumber(firstAirport?.latitude),
    longitude: finiteNumber(data.longitude) ??
      finiteNumber(coordinates?.longitude) ??
      finiteNumber(firstAirport?.longitude),
  };
}

async function resolvePlace(query: string, token: string, onTiming?: AssistantTimingObserver, deadlineSignal?: AbortSignal): Promise<Place | null> {
  const body = await requestJson(
    `${DUFFEL_API}/places/suggestions?query=${encodeURIComponent(query)}`,
    { headers: providerHeaders(token) },
    onTiming,
    deadlineSignal,
  );
  const root = record(body);
  const places = Array.isArray(root?.data) ? root.data : [];
  const candidates = places.map(choosePlace).filter((place): place is Place => Boolean(place));
  return candidates.find((place) => {
    const item = places.find((candidate) => choosePlace(candidate)?.iataCode === place.iataCode);
    return record(item)?.type === "city";
  }) ?? candidates[0] ?? null;
}

function flightCarbonLabel(value: number): "low" | "moderate" | "high" {
  return value < 100 ? "low" : value < 300 ? "moderate" : "high";
}

function routeDistanceKm(origin: Place, destination: Place): number | null {
  if (
    origin.latitude === null ||
    origin.longitude === null ||
    destination.latitude === null ||
    destination.longitude === null
  ) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(destination.latitude - origin.latitude);
  const longitudeDelta = radians(destination.longitude - origin.longitude);
  const startLatitude = radians(origin.latitude);
  const endLatitude = radians(destination.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

async function estimateFlightCarbon(
  origin: Place,
  destination: Place,
  travellers: number,
  token: string,
  onTiming?: AssistantTimingObserver,
  deadlineSignal?: AbortSignal,
): Promise<number | null> {
  const distance = routeDistanceKm(origin, destination);
  if (distance === null || distance <= 0) return null;
  const sameCountry = origin.countryCode && destination.countryCode &&
    origin.countryCode === destination.countryCode;
  const activityId = sameCountry
    ? "passenger_flight-route_type_domestic-aircraft_type_na-distance_na-class_na-rf_included-distance_uplift_included"
    : distance < 3_700
      ? "passenger_flight-route_type_international-aircraft_type_na-distance_short_haul_lt_3700km-class_na-rf_included-distance_uplift_included"
      : "passenger_flight-route_type_international-aircraft_type_na-distance_long_haul_gt_3700km-class_na-rf_included-distance_uplift_included";
  const body = await requestJson(`${CLIMATIQ_API}/data/v1/estimate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      emission_factor: {
        activity_id: activityId,
        data_version: "37",
        region: "GB",
      },
      parameters: {
        passengers: Math.max(1, Math.min(20, travellers)),
        distance,
        distance_unit: "km",
      },
    }),
  }, onTiming, deadlineSignal);
  const data = record(body);
  const carbon = finiteNumber(data?.co2e);
  const unit = stringValue(data?.co2e_unit);
  if (carbon === null || carbon < 0 || unit?.toLowerCase() !== "kg") return null;
  return carbon;
}

async function estimateStayCarbon(
  destination: Place,
  nights: number,
  token: string,
  onTiming?: AssistantTimingObserver,
  deadlineSignal?: AbortSignal,
): Promise<number | null> {
  if (!destination.countryCode || !Number.isFinite(nights) || nights <= 0) return null;
  const body = await requestJson(`${CLIMATIQ_API}/data/v1/estimate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      emission_factor: {
        activity_id: "accommodation-type_hotel_stay",
        data_version: "37",
        region: destination.countryCode,
      },
      parameters: { number: nights },
    }),
  }, onTiming, deadlineSignal);
  const data = record(body);
  const carbon = finiteNumber(data?.co2e);
  return carbon !== null && carbon >= 0 && stringValue(data?.co2e_unit)?.toLowerCase() === "kg" ? carbon : null;
}

async function searchFlights(
  origin: Place,
  destination: Place,
  dates: { checkIn: string; checkOut: string },
  travellers: number,
  duffelToken: string,
  climatiqToken: string,
  onTiming?: AssistantTimingObserver,
  deadlineSignal?: AbortSignal,
): Promise<Recommendation[]> {
  const [body, outbound, inbound] = await Promise.all([
    requestJson(`${DUFFEL_API}/air/offer_requests`, {
      method: "POST",
      headers: providerHeaders(duffelToken),
      body: JSON.stringify({
        data: {
          cabin_class: "economy",
          slices: [
            { origin: origin.iataCode, destination: destination.iataCode, departure_date: dates.checkIn },
            { origin: destination.iataCode, destination: origin.iataCode, departure_date: dates.checkOut },
          ],
          passengers: Array.from({ length: Math.max(1, Math.min(20, travellers)) }, () => ({ type: "adult" })),
          // Bound the search to direct flights; requesting all connections in
          // the initial response can return thousands of offers and time out.
          return_offers: false,
          max_connections: 0,
        },
      }),
    }, onTiming, deadlineSignal),
    estimateFlightCarbon(origin, destination, travellers, climatiqToken, onTiming, deadlineSignal),
    estimateFlightCarbon(destination, origin, travellers, climatiqToken, onTiming, deadlineSignal),
  ]);
  const responseData = record(record(body)?.data);
  const inlineOffers = Array.isArray(responseData?.offers) ? responseData.offers : [];
  const requestId = stringValue(responseData?.id);
  const listedOffers = inlineOffers.length ? null : requestId
    ? await requestJson(
      `${DUFFEL_API}/air/offers?offer_request_id=${encodeURIComponent(requestId)}&limit=3`,
      { headers: providerHeaders(duffelToken) },
      onTiming,
      deadlineSignal,
    )
    : null;
  const listed = record(listedOffers)?.data;
  const candidates = inlineOffers.length ? inlineOffers : Array.isArray(listed) ? listed : [];
  const recommendations: Recommendation[] = [];
  // A single route estimate applies to the displayed round-trip comparison,
  // not a separate external call for every fare returned by the provider.
  const routeCarbonKg = outbound !== null && inbound !== null ? outbound + inbound : null;
  for (const raw of candidates.slice(0, 3)) {
    const offer = record(raw);
    const id = stringValue(offer?.id);
    const amount = stringValue(offer?.total_amount);
    const currency = stringValue(offer?.total_currency);
    const carbonKg = routeCarbonKg;
    if (!id || !amount || !currency || carbonKg === null) continue;
    const owner = record(offer?.owner);
    const name = stringValue(owner?.name) ?? "Duffel flight offer";
    recommendations.push({
      id: `duffel-flight-${id}`,
      type: "transport",
      ...flightConvenience(offer!),
      name,
      location: `${origin.name} → ${destination.name}`,
      description: "Duffel TEST MODE return offer. Route-average Climatiq estimate is not aircraft-specific. Price and availability must be revalidated before any booking; Landa never creates an order here.",
      price: `${currency} ${amount}`,
      carbonKg,
      carbonLabel: flightCarbonLabel(carbonKg),
      score: Math.max(1, Math.round(100 - Math.min(carbonKg / 8, 80))),
      certification: null,
      source: "Duffel TEST MODE + Climatiq outbound and return route estimates",
      verifiedAt: VERIFIED_AT,
      tags: ["flight", "live test offer", "Climatiq emissions"],
    });
  }
  return recommendations;
}

async function searchStays(
  destination: Place,
  dates: { checkIn: string; checkOut: string },
  travellers: number,
  duffelToken: string,
  climatiqToken: string,
  onTiming?: AssistantTimingObserver,
  deadlineSignal?: AbortSignal,
): Promise<Recommendation[]> {
  if (destination.latitude === null || destination.longitude === null) return [];
  const [body, stayCarbon] = await Promise.all([
    requestJson(`${DUFFEL_API}/stays/search`, {
      method: "POST",
      headers: providerHeaders(duffelToken),
      body: JSON.stringify({
        data: {
          check_in_date: dates.checkIn,
          check_out_date: dates.checkOut,
          rooms: 1,
          guests: Array.from({ length: Math.max(1, Math.min(20, travellers)) }, () => ({ type: "adult" })),
          location: { radius: 25, geographic_coordinates: { latitude: destination.latitude, longitude: destination.longitude } },
        },
      }),
    }, onTiming, deadlineSignal),
    estimateStayCarbon(destination, Math.max(
      1,
      Math.round(
        (new Date(`${dates.checkOut}T00:00:00Z`).valueOf() -
          new Date(`${dates.checkIn}T00:00:00Z`).valueOf()) / 86_400_000,
      ),
    ), climatiqToken, onTiming, deadlineSignal),
  ]);
  const responseData = record(record(body)?.data);
  const results = Array.isArray(responseData?.results) ? responseData.results : [];
  if (results.length === 0) return [];
  const recommendations: Recommendation[] = [];
  for (const raw of results.slice(0, 3)) {
    const result = record(raw);
    const accommodation = record(result?.accommodation);
    const id = stringValue(result?.id) ?? stringValue(accommodation?.id);
    const name = stringValue(accommodation?.name);
    const amount = finiteNumber(Number(result?.cheapest_rate_total_amount));
    const currency = stringValue(result?.cheapest_rate_total_currency);
    const carbonKg = stayCarbon;
    if (!id || !name || amount === null || !currency || carbonKg === null) continue;
    recommendations.push({
      id: `duffel-stay-${id}`,
      type: "stay",
      name,
      location: destination.name,
      description: "Duffel TEST MODE stay availability. Price and availability must be revalidated before any booking.",
      price: `${currency} ${amount}`,
      carbonKg,
      carbonLabel: flightCarbonLabel(carbonKg),
      score: Math.max(1, Math.round(100 - Math.min(carbonKg * 2, 80))),
      certification: null,
      source: "Duffel TEST MODE + Climatiq country hotel-night factor",
      verifiedAt: VERIFIED_AT,
      tags: ["stay", "live test offer", "Climatiq emissions"],
    });
  }
  return recommendations;
}

export async function getLiveTravelRecommendations(
  context: TripContext,
  onTiming?: AssistantTimingObserver,
  responseDeadline?: AbortSignal,
): Promise<ProviderResult> {
  const deadlineSignal = responseDeadline ?? AbortSignal.timeout(LIVE_TRAVEL_SEARCH_DEADLINE_MS);
  const duffelToken = process.env.DUFFEL_ACCESS_TOKEN;
  const climatiqToken = process.env.CLIMATIQ_API_KEY;
  if (!duffelToken || !climatiqToken) {
    return { recommendations: [], source: "demo", notice: "Live travel search is unavailable because provider credentials are not configured." };
  }
  if (!context.origin || !context.destination || !context.dateRange || !context.travellerCount) {
    return { recommendations: [], source: "demo", notice: "Live travel search needs origin, destination, usable dates, and traveller count; no bookable dates were invented." };
  }
  const dates = parseDate(context.dateRange);
  if (!dates) {
    return { recommendations: [], source: "demo", notice: "Live travel search needs specific future dates or a supported date phrase; no bookable dates were invented." };
  }
  try {
    const [origin, destination] = await Promise.all([
      resolvePlace(context.origin, duffelToken, onTiming, deadlineSignal),
      resolvePlace(context.destination, duffelToken, onTiming, deadlineSignal),
    ]);
    if (!origin || !destination) {
      if (deadlineSignal.aborted) {
        return { recommendations: [], source: "demo", notice: "Live travel search exceeded its 1.7-second response budget; no unvalidated live results are shown." };
      }
      return { recommendations: [], source: "demo", notice: "The travel providers could not resolve both places, so no live result is shown." };
    }
    const wantsStay = !context.accommodationNeeds.some((need) => /\bnone\b|no accommodation|not needed/i.test(need));
    const [flights, stays] = await Promise.all([
      searchFlights(origin, destination, dates, context.travellerCount, duffelToken, climatiqToken, onTiming, deadlineSignal),
      wantsStay ? searchStays(destination, dates, context.travellerCount, duffelToken, climatiqToken, onTiming, deadlineSignal) : Promise.resolve([]),
    ]);
    const recommendations = [...flights, ...stays];
    return {
      recommendations,
      source: recommendations.length ? "live" : "demo",
      notice: deadlineSignal.aborted
        ? recommendations.length
          ? "Live travel search reached its 1.7-second response budget; only offers and emissions that completed validation are shown."
          : "Live travel search exceeded its 1.7-second response budget; no unvalidated live results are shown."
        : recommendations.length
          ? "Results are Duffel TEST MODE offers with route-average Climatiq flight estimates or country-average hotel-night estimates. They are not bookings or certified eco-accommodation."
          : "No live offer passed provider and emissions validation; no estimated carbon or availability was invented.",
    };
  } catch {
    if (deadlineSignal.aborted) {
      return { recommendations: [], source: "demo", notice: "Live travel search exceeded its 1.7-second response budget; no unvalidated live results are shown." };
    }
    return { recommendations: [], source: "demo", notice: "Live travel providers are temporarily unavailable; showing no live result rather than an unverified estimate." };
  }
}