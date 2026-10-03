import { normalizeMapDestinationSlug } from "./map-context";

const ENTUR_ENDPOINT = "https://api.entur.io/journey-planner/v3/graphql";
const ENTUR_SOURCE_URL = "https://developer.entur.no/apis/graphql/journey-planner";
const PARIS_ENDPOINT = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records";
const PARIS_SOURCE_URL = "https://opendata.paris.fr/explore/dataset/que-faire-a-paris-/api";
const FETCH_TIMEOUT_MS = 2_500;
const PARIS_RESULT_LIMIT = 60;
const UPCOMING_WINDOW_DAYS = 30;
const ENTUR_CACHE_TTL_MS = 30_000;
const PARIS_CACHE_TTL_MS = 5 * 60_000;
const FEED_CACHE_LIMIT = 100;
const feedCache = new Map<string, { expiresAt: number; value: unknown }>();
const ENTUR_QUERY = `{
  stopPlace(id: "NSR:StopPlace:58366") {
    id
    name
    estimatedCalls(timeRange: 3600, numberOfDepartures: 3) {
      aimedDepartureTime
      expectedDepartureTime
      destinationDisplay { frontText }
      serviceJourney { journeyPattern { line { publicCode name } } }
    }
  }
}`;

type FeedStatus = "available" | "unavailable" | "not-covered";
type FeedEnvelope = {
  status: FeedStatus;
  checkedAt: string | null;
  source: string | null;
  sourceUrl: string | null;
  attribution: string | null;
  notice: string;
};
type TransitFeed = FeedEnvelope & {
  departures: Array<{
    stop: string;
    line: string;
    destination: string;
    departureAt: string;
    timing: "scheduled" | "real-time";
  }>;
};
type CulturalEvents = FeedEnvelope & {
  events: Array<{
    title: string;
    startAt: string;
    venue: string;
    category: string | null;
    sourceUrl: string;
  }>;
};

const PARIS_ATTRIBUTION = "Dataset: Que faire à Paris ? — Ville de Paris; Open Database License (ODbL).";
const ENTUR_ATTRIBUTION = "Entur Journey Planner API; data under the Norwegian Licence for Open Government Data (NLOD).";

/**
 * Uses only the official Entur open Journey Planner for a fixed central Oslo
 * stop, and Paris City's ODbL event catalogue. Other supported destinations
 * remain explicitly not covered; map stops are never promoted to departures.
 */
export async function getDestinationFeedContext(
  destination: string,
  travelDates?: string,
  now = new Date(),
) {
  const slug = normalizeMapDestinationSlug(destination);
  const [transitFeed, culturalEvents] = await Promise.all([
    slug === "oslo"
      ? cachedFeed("entur:oslo:central-departures", ENTUR_CACHE_TTL_MS, () => getOsloDepartures(now))
      : Promise.resolve(notCoveredTransit(destination)),
    slug === "paris"
      ? cachedFeed(`paris:events:${dateInParis(now)}:${travelDates ?? "upcoming"}`, PARIS_CACHE_TTL_MS, () => getParisEvents(destination, travelDates, now))
      : Promise.resolve(notCoveredEvents(destination)),
  ]);
  return { transitFeed, culturalEvents };
}

/** Test utility to isolate provider-cache behavior without exporting cache contents. */
export function clearDestinationFeedCache(): void {
  feedCache.clear();
}

async function cachedFeed<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = feedCache.get(key);
  if (entry && entry.expiresAt > now) return entry.value as T;
  if (entry) feedCache.delete(key);
  const value = await load();
  if (feedCache.size >= FEED_CACHE_LIMIT) {
    const firstKey = feedCache.keys().next().value;
    if (firstKey !== undefined) feedCache.delete(firstKey);
  }
  feedCache.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

function notCoveredTransit(destination: string): TransitFeed {
  return {
    status: "not-covered",
    checkedAt: null,
    source: null,
    sourceUrl: null,
    attribution: null,
    departures: [],
    notice: `No verified official departure feed is connected for ${destination}. Nearby OpenStreetMap stops are location references only, not schedules.`,
  };
}

function notCoveredEvents(destination: string): CulturalEvents {
  return {
    status: "not-covered",
    checkedAt: null,
    source: null,
    sourceUrl: null,
    attribution: null,
    events: [],
    notice: `No verified current cultural-events feed is connected for ${destination}. Mapped attractions are not current event listings.`,
  };
}

function unavailableTransit(notice: string): TransitFeed {
  return {
    status: "unavailable",
    checkedAt: null,
    source: "Entur Journey Planner",
    sourceUrl: ENTUR_SOURCE_URL,
    attribution: ENTUR_ATTRIBUTION,
    departures: [],
    notice,
  };
}

async function getOsloDepartures(now: Date): Promise<TransitFeed> {
  let response: Response;
  try {
    response = await fetch(ENTUR_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "ET-Client-Name": "EcoTravelAdvisor-context",
      },
      body: JSON.stringify({ query: ENTUR_QUERY }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return unavailableTransit("Entur could not be reached within the bounded request timeout.");
  }
  if (!response.ok) return unavailableTransit(`Entur returned HTTP ${response.status}; departures are unavailable.`);

  try {
    const payload: unknown = await response.json();
    const root = asRecord(payload);
    if (Array.isArray(root?.errors) && root.errors.length > 0) {
      return unavailableTransit("Entur reported a GraphQL error; departures are unavailable.");
    }
    const data = asRecord(root?.data);
    const stopPlace = asRecord(data?.stopPlace);
    const calls = Array.isArray(stopPlace?.estimatedCalls) ? stopPlace.estimatedCalls : null;
    if (!calls) return unavailableTransit("Entur returned an invalid departure response.");
    const stopName = text(stopPlace?.name, 100) ?? "Jernbanetorget";
    const departures = calls.flatMap((call): TransitFeed["departures"] => {
      const record = asRecord(call);
      const journey = asRecord(record?.serviceJourney);
      const pattern = asRecord(journey?.journeyPattern);
      const line = asRecord(pattern?.line);
      const expected = isoTimestamp(record?.expectedDepartureTime);
      const aimed = isoTimestamp(record?.aimedDepartureTime);
      const departureAt = expected ?? aimed;
      const publicCode = text(line?.publicCode, 30);
      const lineName = text(line?.name, 80);
      const destinationName = text(asRecord(record?.destinationDisplay)?.frontText, 120);
      if (!departureAt || Date.parse(departureAt) < now.getTime() || !destinationName) return [];
      if (!publicCode && !lineName) return [];
      return [{
        stop: `${stopName} (central Oslo reference)`,
        line: publicCode ?? lineName!,
        destination: destinationName,
        departureAt,
        timing: expected ? "real-time" : "scheduled",
      }];
    }).slice(0, 3);

    return {
      status: "available",
      checkedAt: new Date().toISOString(),
      source: "Entur Journey Planner",
      sourceUrl: ENTUR_SOURCE_URL,
      attribution: ENTUR_ATTRIBUTION,
      departures,
      notice: "Live/current departures are for Jernbanetorget, a fixed central Oslo reference only—not the traveller's nearest stop, a routed journey, or future trip-date service. Confirm details with Entur before travel.",
    };
  } catch {
    return unavailableTransit("Entur returned unreadable departure data.");
  }
}

function unavailableEvents(notice: string): CulturalEvents {
  return {
    status: "unavailable",
    checkedAt: null,
    source: "Que faire à Paris? — Ville de Paris",
    sourceUrl: PARIS_SOURCE_URL,
    attribution: PARIS_ATTRIBUTION,
    events: [],
    notice,
  };
}

async function getParisEvents(
  destination: string,
  travelDates: string | undefined,
  now: Date,
): Promise<CulturalEvents> {
  const range = eventDateRange(travelDates, now);
  if (!range) {
    return unavailableEvents(`Paris event lookup was not performed because the supplied travel dates could not be read as YYYY-MM-DD to YYYY-MM-DD: ${destination}.`);
  }
  const where = [
    `date_start <= '${parisDateBoundary(range.end, true)}'`,
    `date_end >= '${parisDateBoundary(range.start, false)}'`,
    "address_city = 'Paris'",
  ].join(" AND ");
  const query = new URLSearchParams({
    limit: String(PARIS_RESULT_LIMIT),
    select: "title,url,date_start,date_end,occurrences,locations,address_city,address_name,address_street,address_zipcode,qfap_tags",
    where,
    order_by: "date_start desc",
  });
  let response: Response;
  try {
    response = await fetch(`${PARIS_ENDPOINT}?${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return unavailableEvents("Paris Data could not be reached within the bounded request timeout.");
  }
  if (!response.ok) return unavailableEvents(`Paris Data returned HTTP ${response.status}; event listings are unavailable.`);

  try {
    const payload: unknown = await response.json();
    const root = asRecord(payload);
    const records = Array.isArray(root?.results) ? root.results : null;
    if (!records) return unavailableEvents("Paris Data returned an invalid event response.");
    const events = records.flatMap((item): CulturalEvents["events"] => {
      const record = asRecord(item);
      if (!record || !hasPhysicalParisVenue(record)) return [];
      const title = text(record.title, 180);
      const venue = text(record.address_name, 140) ?? text(record.address_street, 140);
      const sourceUrl = officialParisEventUrl(record.url);
      const startAt = nextInPersonOccurrence(record, range, now);
      if (!title || !venue || !sourceUrl || !startAt) return [];
      return [{
        title,
        startAt,
        venue,
        category: text(record.qfap_tags, 80),
        sourceUrl,
      }];
    }).sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)).slice(0, 10);

    return {
      status: "available",
      checkedAt: new Date().toISOString(),
      source: "Que faire à Paris? — Ville de Paris",
      sourceUrl: PARIS_SOURCE_URL,
      attribution: PARIS_ATTRIBUTION,
      events,
      notice: `Paris events are filtered to dated, in-person listings with a published start date in ${range.start}–${range.end}. Virtual-only, undated, expired, and non-Paris records are excluded. Dates and availability can change; confirm each event with its official page.`,
    };
  } catch {
    return unavailableEvents("Paris Data returned unreadable event data.");
  }
}

type EventDateRange = { start: string; end: string };

function eventDateRange(travelDates: string | undefined, now: Date): EventDateRange | null {
  if (!travelDates) {
    const start = dateInParis(now);
    return { start, end: addDays(start, UPCOMING_WINDOW_DAYS) };
  }
  const [rawStart = "", rawEnd = ""] = travelDates.trim().split(/\s+(?:\/|to)\s+/i);
  const start = validDate(rawStart);
  if (!start) return null;
  const end = rawEnd.toLowerCase() === "flexible return"
    ? start
    : validDate(rawEnd);
  if (!end || end < start) return null;
  return { start, end };
}

function dateInParis(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function nextInPersonOccurrence(
  record: Record<string, unknown>,
  range: EventDateRange,
  now: Date,
): string | null {
  const startBound = Date.parse(parisDateBoundary(range.start, false));
  const endBound = Date.parse(parisDateBoundary(range.end, true));
  const rawOccurrences = record.occurrences;
  if (typeof rawOccurrences === "string" && rawOccurrences.trim()) {
    const candidates = rawOccurrences.split(";").flatMap((occurrence) => {
      const [rawStart, rawEnd] = occurrence.split("_");
      const start = isoTimestamp(rawStart);
      const end = isoTimestamp(rawEnd);
      if (!start || !end) return [];
      const startTime = Date.parse(start);
      const endTime = Date.parse(end);
      return startTime <= endBound && endTime >= startBound && endTime >= now.getTime() ? [start] : [];
    });
    return candidates.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  }
  const startAt = isoTimestamp(record.date_start);
  const endAt = isoTimestamp(record.date_end);
  if (!startAt || !endAt) return null;
  const startTime = Date.parse(startAt);
  return startTime >= startBound && startTime <= endBound && Date.parse(endAt) >= now.getTime()
    ? startAt
    : null;
}

function parisDateBoundary(date: string, endOfDay: boolean): string {
  const nextDate = endOfDay ? addDays(date, 1) : date;
  const utcReference = new Date(`${nextDate}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset",
  }).formatToParts(utcReference);
  const zone = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace(/^GMT/, "");
  const midnight = Date.parse(`${nextDate}T00:00:00${offset}`);
  return new Date(endOfDay ? midnight - 1 : midnight).toISOString();
}

function hasPhysicalParisVenue(record: Record<string, unknown>): boolean {
  const locations = Array.isArray(record.locations) ? record.locations : [];
  const candidates = locations.map(asRecord).filter((location): location is Record<string, unknown> => location !== null);
  if (candidates.length === 0) candidates.push(record);
  return candidates.some((location) => {
    const city = text(location.address_city, 100)?.toLowerCase();
    const street = text(location.address_street, 180);
    const zip = text(location.address_zipCode, 10) ?? text(location.address_zipcode, 10);
    const coordinateText = text(location.address_lat_lon, 60);
    let validCoordinates = false;
    if (coordinateText) {
      const [lat, lon] = coordinateText.split(",").map(Number);
      validCoordinates = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
    }
    const physicalAddress = Boolean(street && (/^75\d{3}$/.test(zip ?? "") || validCoordinates));
    return city === "paris" && physicalAddress;
  });
}

function officialParisEventUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paris.fr" || url.hostname.endsWith(".paris.fr"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}