export type ProviderStatus = "available" | "unavailable";

export type WeatherDay = {
  date: string;
  temperatureMaxC: number;
  temperatureMinC: number;
  precipitationMm: number;
  weatherCode: number;
};

export type WeatherResult = {
  status: ProviderStatus;
  source: "Open-Meteo";
  date: string | null;
  current: {
    temperatureC: number;
    precipitationMm: number;
    windSpeedKmh: number;
    weatherCode: number;
    time: string;
  } | null;
  outlook: WeatherDay[];
  travelAdvice: string;
  travelDates: string | null;
  forecastAppliesToTravelDates: false;
  notice: string;
};

export type PlaceDescriptionResult = {
  status: ProviderStatus;
  extract: string | null;
  sourceUrl: string | null;
  attribution: string | null;
};

export type ExchangeRateResult = {
  status: ProviderStatus;
  base: string;
  target: string;
  rate: number | null;
  date: string | null;
  source: string;
};

export type OffsetProgrammeContext = {
  status: "curated-demo";
  source: "Curated static programme directories";
  checkedAt: null;
  notice: string;
  programmes: Array<{
    id: string;
    name: string;
    organization: string;
    sourceUrl: string;
    evidenceType: "official programme directory";
    checkedAt: null;
    limitations: string;
  }>;
};

/**
 * Official programme directories are useful starting points, not verified
 * project recommendations. These static links are deliberately not presented
 * as current credit inventory or evidence that a particular project qualifies.
 */
export function getOffsetProgrammeContext(): OffsetProgrammeContext {
  return {
    status: "curated-demo",
    source: "Curated static programme directories",
    checkedAt: null,
    notice: "Curated directory references only; these are not live offers, project-level due-diligence results, or a claim that offsets neutralise travel emissions. Check current project documents, methodology, additionality, permanence, leakage, safeguards, price, and retirement evidence directly.",
    programmes: [
      {
        id: "gold-standard-marketplace",
        name: "Gold Standard Marketplace",
        organization: "Gold Standard",
        sourceUrl: "https://marketplace.goldstandard.org/collections/projects",
        evidenceType: "official programme directory",
        checkedAt: null,
        limitations: "Official marketplace directory link; no project, credit quantity, price, or availability was checked.",
      },
      {
        id: "plan-vivo-project-network",
        name: "Plan Vivo Project Network",
        organization: "Plan Vivo Foundation",
        sourceUrl: "https://www.planvivo.org/project-network",
        evidenceType: "official programme directory",
        checkedAt: null,
        limitations: "Official project-network directory link; this listing is not a current credit offer or an independent project assessment.",
      },
      {
        id: "verra-vcs-registry",
        name: "Verified Carbon Standard project registry",
        organization: "Verra",
        sourceUrl: "https://registry.verra.org/app/search/VCS",
        evidenceType: "official programme directory",
        checkedAt: null,
        limitations: "Official registry search link; a registry entry alone does not establish current availability, suitability, or the quality of a specific purchase.",
      },
    ],
  };
}

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 2_500;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheValue<T>(key: string, value: T): T {
  if (cache.size >= CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function unavailableWeather(travelDates: string | undefined, notice: string): WeatherResult {
  return {
    status: "unavailable",
    source: "Open-Meteo",
    date: null,
    current: null,
    outlook: [],
    travelAdvice: "Weather-based advice is unavailable; check a current local forecast before travel.",
    travelDates: travelDates ?? null,
    forecastAppliesToTravelDates: false,
    notice,
  };
}

/** Open-Meteo's outlook is the next three forecast days, never a forecast for a later trip date. */
export async function getWeather(
  lat: number,
  lon: number,
  travelDates?: string,
): Promise<WeatherResult> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
    !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return unavailableWeather(travelDates, "Valid latitude and longitude are required.");
  }
  const key = `weather:${lat}:${lon}`;
  const prior = cached<WeatherResult>(key);
  if (prior) return { ...prior, travelDates: travelDates ?? null };
  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,precipitation,wind_speed_10m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    forecast_days: "3",
    timezone: "auto",
  });
  const root = asRecord(await fetchJson(`${OPEN_METEO_URL}?${query}`));
  const current = asRecord(root?.current);
  const daily = asRecord(root?.daily);
  const currentTemp = finiteNumber(current?.temperature_2m);
  const currentPrecipitation = finiteNumber(current?.precipitation);
  const currentWindSpeed = finiteNumber(current?.wind_speed_10m);
  const currentCode = finiteNumber(current?.weather_code);
  const currentTime = typeof current?.time === "string" ? current.time : null;
  const dates = Array.isArray(daily?.time) ? daily.time : [];
  const maxValues = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max : [];
  const minValues = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min : [];
  const precipitationValues = Array.isArray(daily?.precipitation_sum) ? daily.precipitation_sum : [];
  const codes = Array.isArray(daily?.weather_code) ? daily.weather_code : [];
  if (
    currentTemp === null || currentPrecipitation === null || currentWindSpeed === null ||
    currentCode === null || !currentTime ||
    dateString(currentTime.slice(0, 10)) === null ||
    dates.length !== 3 || maxValues.length !== 3 || minValues.length !== 3 ||
    precipitationValues.length !== 3 || codes.length !== 3
  ) {
    return unavailableWeather(travelDates, "Open-Meteo is unavailable or returned an invalid forecast.");
  }
  const outlook: WeatherDay[] = [];
  for (let index = 0; index < 3; index++) {
    const date = dateString(dates[index]);
    const temperatureMaxC = finiteNumber(maxValues[index]);
    const temperatureMinC = finiteNumber(minValues[index]);
    const precipitationMm = finiteNumber(precipitationValues[index]);
    const weatherCode = finiteNumber(codes[index]);
    if (
      date === null || temperatureMaxC === null || temperatureMinC === null ||
      precipitationMm === null || weatherCode === null
    ) {
      return unavailableWeather(travelDates, "Open-Meteo returned an invalid forecast day.");
    }
    outlook.push({ date, temperatureMaxC, temperatureMinC, precipitationMm, weatherCode });
  }
  const firstDay = outlook[0];
  const considerations: string[] = [];
  if (firstDay.precipitationMm > 5) considerations.push("rain is possible, so consider rain protection");
  if (firstDay.temperatureMinC < 5) considerations.push("cool conditions are forecast, so consider warm layers");
  if (firstDay.temperatureMaxC > 30) considerations.push("high temperatures are forecast, so consider shade and hydration");
  const travelAdvice = considerations.length
    ? `For ${firstDay.date}, ${considerations.join("; ")}. Forecasts can change; check local conditions and advisories. This is not a safety guarantee.`
    : `No rain or temperature threshold is flagged for ${firstDay.date}; conditions can change, so check the local forecast and advisories. This is not a safety guarantee.`;
  const result: WeatherResult = {
    status: "available",
    source: "Open-Meteo",
    date: currentTime.slice(0, 10),
    current: {
      temperatureC: currentTemp,
      precipitationMm: currentPrecipitation,
      windSpeedKmh: currentWindSpeed,
      weatherCode: currentCode,
      time: currentTime,
    },
    outlook,
    travelAdvice,
    travelDates: travelDates ?? null,
    forecastAppliesToTravelDates: false,
    notice: "The outlook covers the next three forecast days only; it is not a forecast for future travel dates.",
  };
  return cacheValue(key, result);
}

function normalizeWikipediaTitle(input: string): string | null {
  let title = input.trim();
  if (title.startsWith("wikipedia:")) title = title.slice("wikipedia:".length);
  if (/^[a-z]{2,3}:/i.test(title)) {
    const [language, ...remainder] = title.split(":");
    if (language?.toLowerCase() !== "en") return null;
    title = remainder.join(":");
  }
  title = title.replace(/_/g, " ");
  if (
    !title || title.length > 160 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} .,'’()&-]*$/u.test(title)
  ) return null;
  return title.replace(/\s+/g, " ").trim();
}

function plainShortExtract(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const plain = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  if (plain.length <= 500) return plain;
  const sentenceEnd = plain.slice(0, 500).lastIndexOf(". ");
  return plain.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : 497).trimEnd() + (sentenceEnd > 120 ? "" : "…");
}

function wikiFailure(): PlaceDescriptionResult {
  return { status: "unavailable", extract: null, sourceUrl: null, attribution: null };
}

/** Only accepts article titles / en: titles, and always contacts the fixed English Wikipedia API host. */
export async function getPlaceDescription(wikipediaTagOrTitle: string): Promise<PlaceDescriptionResult> {
  if (typeof wikipediaTagOrTitle !== "string") return wikiFailure();
  const title = normalizeWikipediaTitle(wikipediaTagOrTitle);
  if (!title) return wikiFailure();
  const key = `wikipedia:${title.toLowerCase()}`;
  const prior = cached<PlaceDescriptionResult>(key);
  if (prior) return prior;
  const query = new URLSearchParams({
    action: "query",
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2",
  });
  const root = asRecord(await fetchJson(`${WIKIPEDIA_API_URL}?${query}`, {
    "User-Agent": "EcoTravelAdvisor/1.0 (travel context provider)",
  }));
  const queryResult = asRecord(root?.query);
  const pages = Array.isArray(queryResult?.pages) ? queryResult.pages : [];
  const page = asRecord(pages[0]);
  const extract = plainShortExtract(page?.extract);
  const resolvedTitle = typeof page?.title === "string" ? page.title : title;
  if (page?.missing !== undefined || !extract) return wikiFailure();
  const result: PlaceDescriptionResult = {
    status: "available",
    extract,
    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, "_"))}`,
    attribution: "Text from Wikipedia, available under the Creative Commons Attribution-ShareAlike License.",
  };
  return cacheValue(key, result);
}

function unavailableRate(base: string, target: string, source = "Frankfurter"): ExchangeRateResult {
  return { status: "unavailable", base, target, rate: null, date: null, source };
}

/** Returns a latest reference rate; currency codes must be three uppercase ISO-style letters. */
export async function getExchangeRate(base: string, target: string): Promise<ExchangeRateResult> {
  if (typeof base !== "string" || typeof target !== "string") {
    return unavailableRate(String(base), String(target));
  }
  const normalizedBase = base.trim().toUpperCase();
  const normalizedTarget = target.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedBase) || !/^[A-Z]{3}$/.test(normalizedTarget)) {
    return unavailableRate(normalizedBase, normalizedTarget);
  }
  if (normalizedBase === normalizedTarget) {
    return {
      status: "available",
      base: normalizedBase,
      target: normalizedTarget,
      rate: 1,
      date: new Date().toISOString().slice(0, 10),
      source: "Identity rate (no conversion required)",
    };
  }
  const key = `rate:${normalizedBase}:${normalizedTarget}`;
  const prior = cached<ExchangeRateResult>(key);
  if (prior) return prior;
  const query = new URLSearchParams({ base: normalizedBase, symbols: normalizedTarget });
  const root = asRecord(await fetchJson(`${FRANKFURTER_URL}?${query}`));
  const rates = asRecord(root?.rates);
  const rate = finiteNumber(rates?.[normalizedTarget]);
  const date = dateString(root?.date);
  if (!rate || rate <= 0 || !date || root?.base !== normalizedBase) {
    return unavailableRate(normalizedBase, normalizedTarget);
  }
  return cacheValue(key, {
    status: "available",
    base: normalizedBase,
    target: normalizedTarget,
    rate,
    date,
    source: "Frankfurter",
  });
}