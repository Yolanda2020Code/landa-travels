import { Router, type IRouter } from "express";
import { GetTravelContextQueryParams, GetTravelContextResponse } from "@workspace/api-zod";
import { getExchangeRate, getOffsetProgrammeContext, getPlaceDescription, getWeather } from "../services/travel-context-providers";
import { getDestinationFeedContext } from "../services/destination-feeds";
import { getNearbyMapContext, loadMapContext, type NearbyLocationInput } from "../services/map-context";
import { getCertifiedStaysFeed } from "../services/certification-registry";

const router: IRouter = Router();
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

router.get("/travel-context", async (req, res): Promise<void> => {
  if (typeof req.query.destination !== "string"
    || (req.query.currency !== undefined && typeof req.query.currency !== "string")
    || (req.query.travelDates !== undefined && typeof req.query.travelDates !== "string")
    || (req.query.locationMode !== undefined && typeof req.query.locationMode !== "string")
    || (req.query.locationCity !== undefined && typeof req.query.locationCity !== "string")
    || (req.query.locationLat !== undefined && typeof req.query.locationLat !== "string")
    || (req.query.locationLon !== undefined && typeof req.query.locationLon !== "string")) {
    res.status(400).json({ error: "destination is required and query parameters must be single strings." });
    return;
  }
  const query = GetTravelContextQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const nearbyInput = parseNearbyLocation(req.query);
  if (!nearbyInput) {
    res.status(400).json({
      error: "Location must be skip, a supported manual city, or GPS coordinates rounded to at most two decimal places.",
    });
    return;
  }

  const { destination, currency, travelDates } = query.data;
  const mapResult = await loadMapContext(destination);
  const nearbyContext = await getNearbyMapContext(nearbyInput);
  const certifiedStays = getCertifiedStaysFeed(destination, travelDates);
  const cached = mapResult.status === "cache-miss" ? null : mapResult.data;
  const attractions = cached?.records.filter((place) => place.category === "attraction") ?? [];
  const wikiCandidates = attractions
    .filter((place) => place.wikipedia && /^en:[\p{L}\p{N}][\p{L}\p{N} .,'’()&_-]{0,118}$/iu.test(place.wikipedia))
    .slice(0, 2);

  const [weather, exchange, descriptions, localFeeds] = await Promise.all([
    cached
      ? getWeather(cached.destination.latitude, cached.destination.longitude, travelDates)
      : Promise.resolve({
        status: "unavailable" as const,
        source: "Open-Meteo" as const,
        date: null,
        current: null,
        outlook: [],
        travelAdvice: "Weather-based advice is unavailable; check a current local forecast before travel.",
        travelDates: travelDates ?? null,
        forecastAppliesToTravelDates: false as const,
        notice: "Weather is unavailable because this destination has no cached coordinates.",
      }),
    getExchangeRate("EUR", currency),
    Promise.all(wikiCandidates.map(async (place) => ({
      place,
      description: await getPlaceDescription(place.wikipedia!),
    }))),
    getDestinationFeedContext(destination, travelDates),
  ]);

  const successfulDescriptions = descriptions
    .filter(({ description }) => description.status === "available"
      && description.extract && description.sourceUrl && description.attribution);
  const descriptionByObjectId = new Map(
    successfulDescriptions.map(({ place, description }) => [place.osmObjectId, {
      extract: description.extract!,
      articleUrl: description.sourceUrl!,
      attribution: description.attribution!,
    }]),
  );
  const map = {
    status: mapResult.status === "cache-miss" ? "cache-miss" as const : mapResult.status,
    checkedAt: cached?.checkedAt ?? null,
    attribution: OSM_ATTRIBUTION,
    wikipediaStatus: getWikipediaStatus(Boolean(cached), wikiCandidates.length, successfulDescriptions.length),
    hotels: cached?.records.filter((place) => place.category === "hotel").map(mapItem) ?? [],
    transit: cached?.records.filter((place) => place.category === "transit").map(mapItem) ?? [],
    attractions: attractions.map((place) => {
      const item = mapItem(place);
      const wikipedia = descriptionByObjectId.get(place.osmObjectId);
      return wikipedia ? { ...item, wikipedia } : item;
    }),
  };

  const offsetProgrammes = getOffsetProgrammeContext();
  const validated = GetTravelContextResponse.parse({
    destination,
    map,
    weather,
    exchange,
    ...localFeeds,
    certifiedStays,
    nearbyContext,
    offsetProgrammes,
  });
  res.json(validated);
});

function parseNearbyLocation(query: Record<string, unknown>): NearbyLocationInput | null {
  const mode = query.locationMode ?? "skip";
  const city = query.locationCity;
  const latitude = query.locationLat;
  const longitude = query.locationLon;

  if (mode === "skip") {
    return city === undefined && latitude === undefined && longitude === undefined
      ? { mode: "skip" }
      : null;
  }
  if (mode === "manual") {
    return typeof city === "string" && city.trim().length > 0 && city.trim().length <= 100
      && latitude === undefined && longitude === undefined
      ? { mode: "manual", city: city.trim() }
      : null;
  }
  if (mode !== "gps" || city !== undefined || typeof latitude !== "string" || typeof longitude !== "string") {
    return null;
  }
  // A decimal-only grammar rejects exponent notation and more than two
  // fractional digits before values enter the request-scoped location lookup.
  const roundedCoordinate = /^-?(?:\d{1,3})(?:\.\d{1,2})?$/;
  if (!roundedCoordinate.test(latitude) || !roundedCoordinate.test(longitude)) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return null;
  }
  return { mode: "gps", latitude: lat, longitude: lon };
}

function mapItem(place: {
  name: string;
  sourceUrl: string;
  osmObjectId: string;
  latitude: number;
  longitude: number;
}) {
  return {
    name: place.name,
    sourceUrl: place.sourceUrl,
    objectId: place.osmObjectId,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

export function getWikipediaStatus(
  hasMap: boolean,
  candidateCount: number,
  successfulLookupCount: number,
): "available" | "no-english-tag" | "lookup-unavailable" | "no-map" {
  if (!hasMap) return "no-map";
  if (candidateCount === 0) return "no-english-tag";
  if (successfulLookupCount === 0) return "lookup-unavailable";
  return "available";
}

export default router;