import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { basename, dirname, resolve } from "node:path";

export type MapContextCategory = "hotel" | "attraction" | "transit";

export interface MapContextPlace {
  category: MapContextCategory;
  name: string;
  latitude: number;
  longitude: number;
  osmObjectId: string;
  sourceUrl: string;
  checkedAt: string;
  wikipedia?: string;
}

export interface MapContextDestination {
  slug: string;
  label: string;
  latitude: number;
  longitude: number;
  osmObjectId: string;
  sourceUrl: string;
  checkedAt: string;
}

export interface MapContext {
  schemaVersion: 1;
  destination: MapContextDestination;
  checkedAt: string;
  records: MapContextPlace[];
  attribution: "© OpenStreetMap contributors";
}

export type MapContextLoadResult =
  | { status: "ok"; data: MapContext; stale: false; ageMs: number }
  | { status: "stale"; data: MapContext; stale: true; ageMs: number }
  | { status: "cache-miss"; reason: "not-found" | "invalid"; message: string };

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIRECTORY = resolve(
  process.env.MAP_CONTEXT_CACHE_DIR?.trim() ||
    resolve(
      moduleDirectory,
      basename(moduleDirectory) === "dist" ? "../data/map-context" : "../../data/map-context",
    ),
);
const MAX_CACHE_BYTES = 1_000_000;
const MAX_RECORDS = 80;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const OSM_OBJECT_ID = /^(node|way|relation)\/[1-9]\d{0,19}$/;
const GUIDED_CITY_CODES: Record<string, string> = {
  BER: "berlin",
  PAR: "paris",
  LIS: "lisbon",
  AMS: "amsterdam",
  BCN: "barcelona",
  CPH: "copenhagen",
  OSL: "oslo",
  EDI: "edinburgh",
  SJO: "san-jose",
};

export const OFFLINE_MAP_DESTINATIONS = [
  { slug: "amsterdam", label: "Amsterdam" },
  { slug: "barcelona", label: "Barcelona" },
  { slug: "berlin", label: "Berlin" },
  { slug: "copenhagen", label: "Copenhagen" },
  { slug: "edinburgh", label: "Edinburgh" },
  { slug: "lisbon", label: "Lisbon" },
  { slug: "oslo", label: "Oslo" },
  { slug: "paris", label: "Paris" },
  { slug: "san-jose", label: "San José" },
] as const;

/**
 * Normalize all guided city names and airport codes to stable cache slugs.
 */
export function normalizeMapDestinationSlug(destination: string): string | null {
  const value = destination.trim().normalize("NFD").replace(/\p{M}/gu, "");
  const upper = value.toUpperCase();
  if (GUIDED_CITY_CODES[upper]) return GUIDED_CITY_CODES[upper]!;
  const normalized = value.toLowerCase();
  const codeSuffix = normalized.match(/^(.+?)(?:\s*\(\s*([a-z]{3})\s*\)|[-_\s]+([a-z]{3}))$/);
  if (codeSuffix) {
    const code = (codeSuffix[2] ?? codeSuffix[3])?.toUpperCase();
    const citySlug = codeSuffix[1]?.trim().replace(/[\s_]+/g, "-");
    if (code && citySlug && GUIDED_CITY_CODES[code] === citySlug) return citySlug;
  }
  const slug = normalized.replace(/[\s_]+/g, "-");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export type NearbyLocationInput =
  | { mode: "skip" }
  | { mode: "manual"; city: string }
  | { mode: "gps"; latitude: number; longitude: number };

export type NearbyMapItem = {
  name: string;
  objectId: string;
  sourceUrl: string;
  distanceKm: number;
};

export type NearbyMapContext = {
  status: "available" | "unavailable" | "skipped";
  mode: NearbyLocationInput["mode"];
  label: string | null;
  checkedAt: string | null;
  stale: boolean;
  attribution: "© OpenStreetMap contributors" | null;
  hotels: NearbyMapItem[];
  transit: NearbyMapItem[];
  attractions: NearbyMapItem[];
  notice: string;
};

const EMPTY_NEARBY_CONTEXT: NearbyMapContext = {
  status: "skipped",
  mode: "skip",
  label: null,
  checkedAt: null,
  stale: false,
  attribution: null,
  hotels: [],
  transit: [],
  attractions: [],
  notice: "Location tailoring was skipped. No device location was requested.",
};
const GPS_CITY_COVERAGE_KM = 35;
const NEARBY_PLACE_LIMIT_KM = 20;
const NEARBY_ITEMS_PER_CATEGORY = 6;

/**
 * Uses only bundled, prebuilt OpenStreetMap snapshots. GPS values remain local
 * to this call: they are neither cached nor returned in the response.
 */
export async function getNearbyMapContext(
  input: NearbyLocationInput,
  options: { now?: Date; cacheDirectory?: string } = {},
): Promise<NearbyMapContext> {
  if (input.mode === "skip") return EMPTY_NEARBY_CONTEXT;

  let cache: MapContext | null = null;
  let latitude: number;
  let longitude: number;
  let label: string;
  let stale = false;

  if (input.mode === "manual") {
    const slug = normalizeMapDestinationSlug(input.city);
    if (!slug || !OFFLINE_MAP_DESTINATIONS.some((city) => city.slug === slug)) {
      return unavailableNearbyContext(
        "manual",
        "No offline OpenStreetMap snapshot is available for that approximate city. Choose a listed supported city or skip location tailoring.",
      );
    }
    const result = await loadMapContext(input.city, options);
    if (result.status === "cache-miss") {
      return unavailableNearbyContext("manual", "The offline map snapshot for that approximate city could not be loaded.");
    }
    cache = result.data;
    stale = result.status === "stale";
    latitude = cache.destination.latitude;
    longitude = cache.destination.longitude;
    label = `Approximate city: ${cityLabel(cache.destination.slug)}`;
  } else {
    const candidates = await Promise.all(OFFLINE_MAP_DESTINATIONS.map(async (city) => {
      const result = await loadMapContext(city.slug, options);
      return result.status === "cache-miss" ? null : {
        data: result.data,
        stale: result.status === "stale",
      };
    }));
    const nearest = candidates
      .filter((candidate): candidate is { data: MapContext; stale: boolean } => candidate !== null)
      .map(({ data, stale: candidateStale }) => ({
        candidate: data,
        stale: candidateStale,
        distanceKm: distanceKm(input.latitude, input.longitude, data.destination.latitude, data.destination.longitude),
      }))
      .sort((left, right) => left.distanceKm - right.distanceKm)[0];
    if (!nearest || nearest.distanceKm > GPS_CITY_COVERAGE_KM) {
      return unavailableNearbyContext(
        "gps",
        "No supported offline map snapshot covers this approximate location. GPS values were used only for this lookup and were not retained.",
      );
    }
    cache = nearest.candidate;
    stale = nearest.stale;
    latitude = input.latitude;
    longitude = input.longitude;
    label = `Approximate GPS area near ${cityLabel(cache.destination.slug)}`;
  }

  const items = cache.records.flatMap((place) => {
    const distance = distanceKm(latitude, longitude, place.latitude, place.longitude);
    if (distance > NEARBY_PLACE_LIMIT_KM) return [];
    return [{
      category: place.category,
      distance,
      item: {
        name: place.name,
        objectId: place.osmObjectId,
        sourceUrl: place.sourceUrl,
        distanceKm: Math.round(distance * 10) / 10,
      },
    }];
  });
  const categoryItems = (category: MapContextCategory) => items
    .filter((entry) => entry.category === category)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, NEARBY_ITEMS_PER_CATEGORY)
    .map((entry) => entry.item);

  return {
    status: "available",
    mode: input.mode,
    label,
    checkedAt: cache.checkedAt,
    stale,
    attribution: cache.attribution,
    hotels: categoryItems("hotel"),
    transit: categoryItems("transit"),
    attractions: categoryItems("attraction"),
    notice: `Nearby places are approximate straight-line distances from ${input.mode === "manual" ? "the supported city-centre reference" : "the rounded device location"}. They come from an offline OpenStreetMap snapshot checked ${cache.checkedAt}; map points are not live hotel inventory, transit timetables, route directions, or opening-hour information. GPS coordinates are not stored or included in this response.`,
  };
}

function unavailableNearbyContext(
  mode: "manual" | "gps",
  notice: string,
): NearbyMapContext {
  return {
    status: "unavailable",
    mode,
    label: null,
    checkedAt: null,
    stale: false,
    attribution: null,
    hotels: [],
    transit: [],
    attractions: [],
    notice,
  };
}

function cityLabel(slug: string): string {
  return OFFLINE_MAP_DESTINATIONS.find((city) => city.slug === slug)?.label ?? slug;
}

function distanceKm(latA: number, lonA: number, latB: number, lonB: number): number {
  const radians = Math.PI / 180;
  const deltaLat = (latB - latA) * radians;
  const deltaLon = (lonB - lonA) * radians;
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(latA * radians) * Math.cos(latB * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validSourceUrl(value: unknown, objectId: string): value is string {
  return value === `https://www.openstreetmap.org/${objectId}`;
}

function parseMapContext(input: unknown, expectedSlug: string): MapContext | null {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.attribution !== "© OpenStreetMap contributors") return null;
  if (!isIsoDate(input.checkedAt) || !isRecord(input.destination) || !Array.isArray(input.records)) return null;
  const destination = input.destination;
  if (
    destination.slug !== expectedSlug
    || !isText(destination.label, 180)
    || !isLatitude(destination.latitude)
    || !isLongitude(destination.longitude)
    || !isText(destination.osmObjectId, 32)
    || !OSM_OBJECT_ID.test(destination.osmObjectId)
    || !validSourceUrl(destination.sourceUrl, destination.osmObjectId)
    || !isIsoDate(destination.checkedAt)
    || input.records.length > MAX_RECORDS
  ) return null;

  const records: MapContextPlace[] = [];
  for (const item of input.records) {
    if (!isRecord(item) || !["hotel", "attraction", "transit"].includes(String(item.category))) return null;
    if (
      !isText(item.name, 160)
      || !isLatitude(item.latitude)
      || !isLongitude(item.longitude)
      || !isText(item.osmObjectId, 32)
      || !OSM_OBJECT_ID.test(item.osmObjectId)
      || !validSourceUrl(item.sourceUrl, item.osmObjectId)
      || !isIsoDate(item.checkedAt)
      || (item.wikipedia !== undefined && !isText(item.wikipedia, 120))
    ) return null;
    const record: MapContextPlace = {
      category: item.category as MapContextCategory,
      name: item.name,
      latitude: item.latitude,
      longitude: item.longitude,
      osmObjectId: item.osmObjectId,
      sourceUrl: item.sourceUrl,
      checkedAt: item.checkedAt,
    };
    if (item.wikipedia !== undefined) record.wikipedia = item.wikipedia;
    records.push(record);
  }

  return {
    schemaVersion: 1,
    destination: {
      slug: destination.slug,
      label: destination.label,
      latitude: destination.latitude,
      longitude: destination.longitude,
      osmObjectId: destination.osmObjectId,
      sourceUrl: destination.sourceUrl,
      checkedAt: destination.checkedAt,
    },
    checkedAt: input.checkedAt,
    records,
    attribution: "© OpenStreetMap contributors",
  };
}

/**
 * Read a prebuilt map-context cache. This function performs filesystem reads
 * only; it never contacts Nominatim or Overpass.
 */
export async function loadMapContext(
  destination: string,
  options: { now?: Date; maxAgeMs?: number; cacheDirectory?: string } = {},
): Promise<MapContextLoadResult> {
  const slug = normalizeMapDestinationSlug(destination);
  if (!slug) {
    return { status: "cache-miss", reason: "invalid", message: "Destination is not a valid cache slug." };
  }

  // Construct the filename exclusively from the validated canonical slug.
  const filePath = path.join(options.cacheDirectory ?? DEFAULT_CACHE_DIRECTORY, `${slug}.json`);
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size > MAX_CACHE_BYTES) {
      return { status: "cache-miss", reason: "invalid", message: "Map cache file is invalid or exceeds the size limit." };
    }
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const data = parseMapContext(parsed, slug);
    if (!data) {
      return { status: "cache-miss", reason: "invalid", message: "Map cache JSON failed schema validation." };
    }
    const ageMs = Math.max(0, (options.now ?? new Date()).getTime() - Date.parse(data.checkedAt));
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      return { status: "cache-miss", reason: "invalid", message: "Map cache age setting is invalid." };
    }
    return ageMs > maxAgeMs
      ? { status: "stale", data, stale: true, ageMs }
      : { status: "ok", data, stale: false, ageMs };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { status: "cache-miss", reason: "not-found", message: "No cached map context is available for this destination." };
    }
    return { status: "cache-miss", reason: "invalid", message: "Map cache could not be read or parsed." };
  }
}