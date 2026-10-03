import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { basename, dirname, resolve } from "node:path";
import { logger } from "../lib/logger";
import { normalizeMapDestinationSlug } from "./map-context";
import type { Recommendation } from "@workspace/api-zod";

export const EU_ECOLABEL_SOURCE = "EU Ecolabel — European Commission";
export const EU_ECOLABEL_CATALOGUE_URL = "https://environment.ec.europa.eu/app/ecolabel-product-catalogue";
export const EU_ECOLABEL_API_URL = "https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/services";
export const EU_ECOLABEL_ATTRIBUTION =
  "European Commission, EU Ecolabel; normalized subset of official records. Reuse under CC BY 4.0 unless otherwise noted.";
export const EU_ECOLABEL_NOTICE =
  "Registry evidence reflects the latest fresh official snapshot and is not an endorsement, booking offer, or guarantee of availability. Confirm current certification with the European Commission before booking.";
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 8_000;
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_CITY = 5;
const TOURIST_ACCOMMODATION_LICENCE = /^[A-Z]{2}(?:-[A-Z]{2,6})?\/051\/[A-Z0-9-]+$/i;

export interface RegistryRecord {
  licenceNumber: string;
  expirationDate: string;
  name: string;
  serviceType: string;
  groupName: string;
  street: string;
  city: string;
  country: string;
  website: string | null;
}

export interface RegistrySnapshot {
  schemaVersion: 1;
  checkedAt: string;
  records: RegistryRecord[];
}

interface DestinationRegistryConfig {
  cityAliases: string[];
  countryAliases: string[];
}

export const SUPPORTED_REGISTRY_DESTINATIONS: Record<string, DestinationRegistryConfig> = {
  amsterdam: { cityAliases: ["Amsterdam"], countryAliases: ["Netherlands", "Nederland"] },
  barcelona: { cityAliases: ["Barcelona"], countryAliases: ["Spain", "España"] },
  berlin: { cityAliases: ["Berlin"], countryAliases: ["Germany", "Deutschland"] },
  copenhagen: { cityAliases: ["Copenhagen", "København"], countryAliases: ["Denmark", "Danmark"] },
  edinburgh: { cityAliases: ["Edinburgh"], countryAliases: ["United Kingdom", "United Kingdom of Great Britain and Northern Ireland"] },
  lisbon: { cityAliases: ["Lisbon", "Lisboa"], countryAliases: ["Portugal"] },
  oslo: { cityAliases: ["Oslo"], countryAliases: ["Norway", "Norge"] },
  paris: { cityAliases: ["Paris"], countryAliases: ["France"] },
  "san-jose": { cityAliases: ["San José", "San Jose"], countryAliases: ["Costa Rica"] },
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = resolve(
  moduleDirectory,
  basename(moduleDirectory) === "services" ? "../../data/certified-stays.json" : "../data/certified-stays.json",
);
const initialSnapshot = readBundledSnapshot();
let currentSnapshot = initialSnapshot;
let refreshPromise: Promise<RegistrySnapshot> | null = null;

function readBundledSnapshot(): RegistrySnapshot | null {
  try {
    return parseSnapshot(JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")));
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown): RegistrySnapshot | null {
  const root = asRecord(value);
  if (root?.schemaVersion !== 1 || typeof root.checkedAt !== "string" || !Number.isFinite(Date.parse(root.checkedAt)) || !Array.isArray(root.records)) return null;
  const records = root.records.flatMap((item): RegistryRecord[] => {
    const record = asRecord(item);
    if (!record) return [];
    const licenceNumber = text(record.licenceNumber, 80);
    const expirationDate = validDate(record.expirationDate);
    const name = text(record.name, 200);
    const city = text(record.city, 120);
    const country = text(record.country, 120);
    const street = text(record.street, 240);
    const serviceType = text(record.serviceType, 100);
    const groupName = text(record.groupName, 120);
    const website = record.website === null ? null : validWebsite(record.website);
    if (!licenceNumber || !TOURIST_ACCOMMODATION_LICENCE.test(licenceNumber)
      || !expirationDate || !name || !city || !country || !street || !serviceType || !groupName) return [];
    return [{ licenceNumber, expirationDate, name, city, country, street, serviceType, groupName, website }];
  });
  return { schemaVersion: 1, checkedAt: root.checkedAt, records };
}

export function normalizeOfficialRecord(
  input: unknown,
  now = new Date(),
): RegistryRecord | null {
  const row = asRecord(input);
  if (!row) return null;
  const licenceNumber = text(row.licence_number, 80);
  const expirationDate = validDate(row.expiration_date);
  const name = text(row.service_name, 200);
  const serviceType = text(row.service_type, 100);
  const groupName = text(row.group_name, 120);
  const street = text(row.service_street, 240);
  const city = text(row.service_city, 120);
  const country = text(row.service_country, 120);
  if (!licenceNumber || !TOURIST_ACCOMMODATION_LICENCE.test(licenceNumber)
    || !expirationDate || expirationDate <= now.toISOString().slice(0, 10)
    || !name || !serviceType || serviceType.toLowerCase() !== "hotel"
    || !groupName || groupName.toLowerCase() !== "tourist accommodation"
    || !street || !city || !country) return null;
  return {
    licenceNumber, expirationDate, name, serviceType, groupName, street, city, country,
    website: validWebsite(row.service_website),
  };
}

export function validWebsite(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000 || value.trim() !== value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")
      || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function registryUrlForLicence(licenceNumber: string): string {
  const query = new URLSearchParams({ licence_number: licenceNumber });
  return `${EU_ECOLABEL_API_URL}?${query.toString()}`;
}

export function normalizedText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function destinationConfig(destination: string): { slug: string; config: DestinationRegistryConfig } | null {
  const slug = normalizeMapDestinationSlug(destination);
  const config = slug ? SUPPORTED_REGISTRY_DESTINATIONS[slug] : undefined;
  return config ? { slug: slug!, config } : null;
}

function matchesDestination(record: RegistryRecord, config: DestinationRegistryConfig): boolean {
  return config.cityAliases.some((city) => normalizedText(city) === normalizedText(record.city))
    && config.countryAliases.some((country) => normalizedText(country) === normalizedText(record.country));
}

export interface CertificationEvidence {
  scheme: string;
  licenceNumber: string;
  validUntil: string;
  checkedAt: string;
  registryUrl: string;
  hotelUrl: string | null;
  address: string;
}

export interface CertifiedStay {
  id: string;
  name: string;
  city: string;
  country: string;
  address: string;
  certificationEvidence: CertificationEvidence;
}

export interface CertifiedStaysFeed {
  status: "available" | "unavailable" | "not-covered";
  checkedAt: string | null;
  source: string;
  sourceUrl: string;
  attribution: string;
  notice: string;
  stays: CertifiedStay[];
}

export function getCertifiedStaysFeed(
  destination: string,
  travelDates?: string,
  now = new Date(),
  snapshot = currentSnapshot,
): CertifiedStaysFeed {
  const configured = destinationConfig(destination);
  if (!configured) {
    return {
      status: "not-covered", checkedAt: null, source: EU_ECOLABEL_SOURCE,
      sourceUrl: EU_ECOLABEL_CATALOGUE_URL, attribution: EU_ECOLABEL_ATTRIBUTION,
      notice: `The EU Ecolabel hotel registry feed is not covered for ${destination}. No certification is inferred from map or booking data.`,
      stays: [],
    };
  }
  const checkedAt = snapshot?.checkedAt ?? null;
  const ageMs = checkedAt ? now.getTime() - Date.parse(checkedAt) : Infinity;
  if (!snapshot || ageMs < 0 || ageMs > SNAPSHOT_MAX_AGE_MS) {
    return {
      status: "unavailable", checkedAt, source: EU_ECOLABEL_SOURCE,
      sourceUrl: EU_ECOLABEL_CATALOGUE_URL, attribution: EU_ECOLABEL_ATTRIBUTION,
      notice: "The official EU Ecolabel registry snapshot is missing or older than 24 hours. No hotel is presented as currently certified.",
      stays: [],
    };
  }
  const travelEnd = tripEndDate(travelDates);
  if (!travelEnd) {
    return {
      status: "available", checkedAt, source: EU_ECOLABEL_SOURCE,
      sourceUrl: EU_ECOLABEL_CATALOGUE_URL, attribution: EU_ECOLABEL_ATTRIBUTION,
      notice: "Registry data is fresh, but travel dates could not be validated. Hotels are withheld because certification cannot be confirmed through the trip end date.",
      stays: [],
    };
  }
  const stays = snapshot.records
    .filter((record) => matchesDestination(record, configured.config)
      && record.serviceType.toLowerCase() === "hotel"
      && record.groupName.toLowerCase() === "tourist accommodation"
      && record.expirationDate > now.toISOString().slice(0, 10)
      && record.expirationDate >= travelEnd)
    .map((record): CertifiedStay => ({
      id: `eu-ecolabel-${record.licenceNumber}`,
      name: record.name,
      city: record.city,
      country: record.country,
      address: record.street,
      certificationEvidence: {
        scheme: "EU Ecolabel",
        licenceNumber: record.licenceNumber,
        validUntil: record.expirationDate,
        checkedAt: snapshot.checkedAt,
        registryUrl: registryUrlForLicence(record.licenceNumber),
        hotelUrl: record.website,
        address: record.street,
      },
    }));
  return {
    status: "available", checkedAt, source: EU_ECOLABEL_SOURCE,
    sourceUrl: EU_ECOLABEL_CATALOGUE_URL, attribution: EU_ECOLABEL_ATTRIBUTION,
    notice: stays.length
      ? EU_ECOLABEL_NOTICE
      : "The fresh official snapshot contains no matching EU Ecolabel hotels whose licence remains valid through the end of the trip. No other accommodation is inferred to be certified.",
    stays,
  };
}

export function applyCertifiedStaysToRecommendations(
  recommendations: Recommendation[],
  destination: string | null,
  travelDates: string | null,
  now = new Date(),
  snapshot = currentSnapshot,
): { recommendations: Recommendation[]; notice: string | null } {
  const unclaimed = recommendations.map((item) => {
    if (item.type !== "stay") return item;
    const { certificationEvidence: _discardedEvidence, ...withoutEvidence } = item;
    return {
      ...withoutEvidence,
      certification: null,
      description: item.description.replace(/[^.!?]*\b(?:certif(?:ied|ication)?|eco[- ]?label)[^.!?]*[.!?]?/gi, "").trim()
        || "Accommodation option; no certification evidence is available for this listing.",
      tags: item.tags.filter((tag) => !/certif|eco[- ]?certified/i.test(tag)),
    };
  });
  if (!destination || !recommendations.some((item) => item.type === "stay")) {
    return { recommendations: unclaimed, notice: null };
  }
  const feed = getCertifiedStaysFeed(destination, travelDates ?? undefined, now, snapshot);
  if (feed.status !== "available" || feed.stays.length === 0) {
    return { recommendations: unclaimed, notice: null };
  }

  const countryAverage = recommendations.find((item) =>
    item.type === "stay" && Number.isFinite(item.carbonKg)
    && /country[- ]average.*hotel|hotel[- ]night.*country[- ]average|country hotel-night factor/i.test(item.source),
  );
  const certified = feed.stays.map((stay): Recommendation => ({
    id: stay.id,
    type: "stay",
    name: stay.name,
    location: `${stay.city}, ${stay.country}`,
    description: `Official EU Ecolabel tourist accommodation record; licence ${stay.certificationEvidence.licenceNumber}, valid until ${stay.certificationEvidence.validUntil}. Registry listings do not provide booking availability or prices.`,
    price: "Not provided by the official registry",
    carbonKg: countryAverage?.carbonKg ?? null,
    carbonLabel: countryAverage?.carbonLabel ?? null,
    score: countryAverage?.score ?? 50,
    certification: "EU Ecolabel",
    certificationEvidence: {
      ...stay.certificationEvidence,
      validUntil: new Date(`${stay.certificationEvidence.validUntil}T00:00:00.000Z`),
      checkedAt: new Date(stay.certificationEvidence.checkedAt),
    },
    source: countryAverage
      ? `${feed.source}; emissions are an indicative country-average estimate from ${countryAverage.source}, not a property-specific measurement.`
      : `${feed.source}; no suitable country-average stay emissions estimate is available.`,
    verifiedAt: stay.certificationEvidence.checkedAt,
    tags: ["EU Ecolabel"],
  }));
  return {
    recommendations: [...unclaimed.filter((item) => item.type !== "stay"), ...certified],
    notice: `${feed.notice} Any displayed stay carbon figure is an indicative country-average estimate, not a property-specific measurement. Prices and availability are not supplied by this registry.`,
  };
}

function tripEndDate(travelDates: string | undefined): string | null {
  if (travelDates === undefined || travelDates.trim() === "") return null;
  const dates = travelDates.trim().split(/\s+(?:\/|to)\s+/i);
  const start = validDate(dates[0]);
  const end = validDate(dates[1]);
  if (!start || !end || end < start) return null;
  return end;
}

export async function refreshCertificationRegistry(
  options: { fetcher?: typeof fetch; now?: Date; snapshotPath?: string } = {},
): Promise<RegistrySnapshot> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchOfficialSnapshot(options).then(async (snapshot) => {
    const filePath = options.snapshotPath ?? SNAPSHOT_PATH;
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
    currentSnapshot = snapshot;
    return snapshot;
  }).catch((error: unknown) => {
    logger.warn({ err: error }, "EU Ecolabel registry refresh failed; retaining the previous snapshot");
    throw error;
  }).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function fetchOfficialSnapshot(options: { fetcher?: typeof fetch; now?: Date }): Promise<RegistrySnapshot> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  const rows: unknown[] = [];
  const queryPairs = new Set<string>();
  for (const config of Object.values(SUPPORTED_REGISTRY_DESTINATIONS)) {
    for (const city of config.cityAliases) {
      const normalizedCity = normalizedText(city);
      if (queryPairs.has(normalizedCity)) continue;
      queryPairs.add(normalizedCity);
      for (let page = 0; page < MAX_PAGES_PER_CITY; page++) {
        const query = new URLSearchParams({
          service_city__icontains: city,
          limit: String(PAGE_LIMIT),
          offset: String(page * PAGE_LIMIT),
        });
        const response = await fetcher(`${EU_ECOLABEL_API_URL}?${query.toString()}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`EU Ecolabel API returned HTTP ${response.status}.`);
        const payload = asRecord(await response.json());
        const data = payload && Array.isArray(payload.data) ? payload.data : null;
        if (!data) throw new Error("EU Ecolabel API returned an invalid service response.");
        rows.push(...data);
        const meta = asRecord(payload?.meta);
        const total = typeof meta?.total === "number" ? meta.total : data.length;
        if (data.length < PAGE_LIMIT || (page + 1) * PAGE_LIMIT >= total) break;
      }
    }
  }

  const countryConfig = new Map<string, DestinationRegistryConfig>();
  Object.values(SUPPORTED_REGISTRY_DESTINATIONS).forEach((config) => {
    config.cityAliases.forEach((city) => countryConfig.set(normalizedText(city), config));
  });
  const deduplicated = new Map<string, RegistryRecord>();
  for (const row of rows) {
    const normalized = normalizeOfficialRecord(row, now);
    if (!normalized) continue;
    const config = countryConfig.get(normalizedText(normalized.city));
    if (!config || !matchesDestination(normalized, config)) continue;
    if (!deduplicated.has(normalized.licenceNumber)) deduplicated.set(normalized.licenceNumber, normalized);
  }
  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    records: [...deduplicated.values()].sort((left, right) =>
      normalizedText(left.city).localeCompare(normalizedText(right.city)) || left.name.localeCompare(right.name),
    ),
  };
}

export function startCertificationRegistryRefresh(): void {
  void refreshCertificationRegistry().catch(() => undefined);
  const timer = setInterval(() => {
    void refreshCertificationRegistry().catch(() => undefined);
  }, REFRESH_INTERVAL_MS);
  timer.unref();
}

export function parseSnapshotForTests(value: unknown): RegistrySnapshot | null {
  return parseSnapshot(value);
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}