import { useId, useState } from "react";
import { CloudSun, ExternalLink, MapPin, RefreshCw, TrainFront, Hotel, Landmark, ArrowRightLeft, CalendarDays } from "lucide-react";
import { getGetTravelContextQueryKey, useGetTravelContext } from "@workspace/api-client-react";
import type { GetTravelContextCurrency, GetTravelContextParams, MapAttraction, MapContextItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useCertificationClock } from "@/hooks/use-certification-clock";
import { isCertificationEvidenceFresh } from "@/lib/certification-evidence";

type DestinationSnapshot = {
  destination: string;
  dateRange: string | null;
  locationMode?: "skip" | "manual" | "gps";
  locationCity?: string | null;
};
type ApproximateCoordinates = { latitude: number; longitude: number };

type CertificationEvidence = {
  scheme: string;
  licenceNumber: string;
  validUntil: string;
  checkedAt: string;
  registryUrl: string;
  hotelUrl: string | null;
  address: string;
};
type CertifiedStay = {
  id: string;
  name: string;
  city: string;
  country: string;
  address: string;
  certificationEvidence: CertificationEvidence;
};
type CertifiedStaysFeed = {
  status: "available" | "unavailable" | "not-covered";
  checkedAt: string | null;
  source: string;
  sourceUrl: string;
  attribution: string;
  notice: string;
  stays: CertifiedStay[];
};

type NearbyMapItem = { name: string; objectId: string; sourceUrl: string; distanceKm: number };
type NearbyMapContext = {
  status: "available" | "unavailable" | "skipped";
  mode: "skip" | "manual" | "gps";
  label: string | null;
  checkedAt: string | null;
  stale: boolean;
  attribution: string | null;
  hotels: NearbyMapItem[];
  transit: NearbyMapItem[];
  attractions: NearbyMapItem[];
  notice: string;
};
type OffsetProgrammeContext = {
  status: "curated-demo";
  source: string;
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
type LocationQuery = GetTravelContextParams & {
  locationMode: "skip" | "manual" | "gps";
  locationCity?: string;
  locationLat?: string;
  locationLon?: string;
};

const weatherDescription = (code: number) => {
  if (code === 0) return "Clear";
  if ([1, 2, 3].includes(code)) return "Cloudy intervals";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([80, 81, 82].includes(code)) return "Showers";
  if ([95, 96, 99].includes(code)) return "Thunderstorms";
  return `Weather code ${code}`;
};
const safeLink = (url: string) => /^https:\/\//i.test(url) ? url : undefined;
const isCurrentEvidence = (evidence: CertificationEvidence, now: number) =>
  /eu ecolabel/i.test(evidence.scheme) && isCertificationEvidenceFresh(evidence.validUntil, evidence.checkedAt, now);
const dateLabel = (date: string) => {
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const safeDateLabel = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { dateStyle: "medium" });
};
const timestampLabel = (timestamp: string, timeZone?: string) => {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  });
};

function LocationList({ title, items, kind, note }: {
  title: string; items: (MapContextItem | MapAttraction)[]; kind: "hotels" | "transit" | "attractions"; note: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 3);
  const Icon = kind === "hotels" ? Hotel : kind === "transit" ? TrainFront : Landmark;
  return (
    <section className="min-w-0 border-t border-border/60 pt-4" aria-label={title}>
      <div className="flex items-center gap-2">
        <Icon size={17} className="shrink-0 text-primary" aria-hidden="true" />
        <h4 className="font-semibold text-sm">{title} <span className="font-normal text-muted-foreground">({items.length})</span></h4>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p>
      {items.length === 0 ? <p className="mt-3 text-xs text-muted-foreground">No mapped locations available in this category.</p> : (
        <>
          <ul className="mt-3 space-y-2">
            {visible.map((item) => {
              const attraction = "wikipedia" in item ? item.wikipedia : undefined;
              return (
                <li key={item.objectId} className="min-w-0 rounded-lg border border-border/60 bg-background/70 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <MapPin size={13} className="mt-0.5 shrink-0 text-primary/70" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">{item.name}</span>
                      <span className="block break-all text-[11px] text-muted-foreground">
                        {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)} · OSM {item.objectId}
                      </span>
                      {safeLink(item.sourceUrl) && <a data-testid={`link-osm-${kind}-${item.objectId}`} href={safeLink(item.sourceUrl)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/75">Open map record <ExternalLink size={11} aria-hidden="true" /></a>}
                      {attraction?.extract && (
                        <div className="mt-2 text-xs leading-relaxed text-foreground/80">
                          <p>{attraction.extract}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {attraction.attribution}
                            {safeLink(attraction.articleUrl) && <> · <a data-testid={`link-wikipedia-${item.objectId}`} href={safeLink(attraction.articleUrl)} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Read article <ExternalLink size={10} className="inline" aria-hidden="true" /></a></>}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {items.length > 3 && <Button data-testid={`button-toggle-${kind}`} type="button" variant="ghost" size="sm" className="mt-2 h-8 px-2 text-xs" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer" : `Show all ${items.length}`}</Button>}
        </>
      )}
    </section>
  );
}

function NearbyPlaceList({ title, items }: { title: string; items: NearbyMapItem[] }) {
  return (
    <section className="min-w-0">
      <h5 className="text-xs font-semibold">{title} <span className="font-normal text-muted-foreground">({items.length})</span></h5>
      {items.length ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item.objectId} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 rounded-md border border-border/50 bg-background/70 px-2.5 py-2 text-xs">
              <span className="min-w-0 break-words font-medium">{item.name}</span>
              <span className="shrink-0 text-muted-foreground">≈ {item.distanceKm.toFixed(1)} km</span>
              {safeLink(item.sourceUrl) && <a href={safeLink(item.sourceUrl)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary underline underline-offset-2">OSM source <ExternalLink size={9} className="inline" aria-hidden="true" /></a>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">No nearby mapped records in this category.</p>}
    </section>
  );
}

export function DestinationContext({ snapshot, gpsCoordinates }: {
  snapshot: DestinationSnapshot;
  gpsCoordinates?: ApproximateCoordinates | null;
}) {
  const evidenceNow = useCertificationClock();
  const currencyId = useId();
  const amountId = useId();
  const amountHelpId = useId();
  const [currency, setCurrency] = useState<Exclude<GetTravelContextCurrency, "EUR">>("GBP");
  const [amount, setAmount] = useState("100");
  const parsedAmount = Number(amount);
  const amountValid = /^\d+(?:\.\d{1,2})?$/.test(amount.trim()) && Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount <= 1_000_000;
  const locationMode = snapshot.locationMode ?? "skip";
  const hasApproximateGps = locationMode === "gps"
    && typeof gpsCoordinates?.latitude === "number" && Number.isFinite(gpsCoordinates.latitude)
    && typeof gpsCoordinates?.longitude === "number" && Number.isFinite(gpsCoordinates.longitude);
  const effectiveLocationMode = locationMode === "manual" && snapshot.locationCity?.trim()
    ? "manual"
    : hasApproximateGps ? "gps" : "skip";
  const params: LocationQuery = {
    destination: snapshot.destination,
    ...(snapshot.dateRange ? { travelDates: snapshot.dateRange } : {}),
    currency,
    locationMode: effectiveLocationMode,
    ...(effectiveLocationMode === "manual" ? { locationCity: snapshot.locationCity!.trim() } : {}),
    ...(effectiveLocationMode === "gps"
      ? { locationLat: gpsCoordinates!.latitude.toFixed(2), locationLon: gpsCoordinates!.longitude.toFixed(2) }
      : {}),
  };
  const { data, isPending, isError, refetch, isFetching } = useGetTravelContext(params, {
    query: {
      enabled: true,
      queryKey: getGetTravelContextQueryKey(params),
      staleTime: 1000 * 60 * 5,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });
  const rateMatchesSelection = data?.exchange.target === currency;
  const rate = rateMatchesSelection && data?.exchange.status === "available" && data.exchange.rate !== null && Number.isFinite(data.exchange.rate) && data.exchange.rate > 0 ? data.exchange.rate : null;
  // This field is optional for clients serving responses generated before registry support.
  const certifiedStays = (data as (typeof data & { certifiedStays?: CertifiedStaysFeed | null }) | undefined)?.certifiedStays;
  const nearbyContext = (data as (typeof data & { nearbyContext?: NearbyMapContext }) | undefined)?.nearbyContext;
  const offsetProgrammes = (data as (typeof data & { offsetProgrammes?: OffsetProgrammeContext }) | undefined)?.offsetProgrammes;

  return (
    <section data-testid="panel-destination-context" aria-label={`Destination context for ${snapshot.destination}`} className="mt-5 min-w-0 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Around your destination</span>
          <h3 className="mt-1 break-words font-serif text-lg font-bold">{data?.destination || snapshot.destination}</h3>
          {snapshot.dateRange && <p className="text-xs text-muted-foreground">Trip dates: {snapshot.dateRange}</p>}
        </div>
        {data && <span className="rounded-full border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground">Reference only</span>}
      </div>
      <section aria-label="Approximate location tailoring" className="mt-4 rounded-lg border border-border/70 bg-background/70 p-3">
        <h4 className="text-sm font-semibold">Nearby tailoring from your planning choice</h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {locationMode === "skip"
            ? "Location tailoring was skipped. This panel does not request device location."
            : effectiveLocationMode === "manual"
              ? `Using approximate city: ${snapshot.locationCity}. No home address is used.`
              : effectiveLocationMode === "gps"
                ? "Using your consented approximate device location rounded to two decimal places. Only this rounded pair is sent for this request and it is not returned or persisted."
                : "Approximate device location is unavailable in this session, so no coordinates are sent and nearby tailoring is unavailable."}
        </p>
      </section>
      {isPending ? (
        <div role="status" aria-label="Loading destination context" className="mt-5 space-y-3 animate-pulse">
          <div className="h-4 w-2/3 rounded bg-muted" /><div className="h-16 rounded-lg bg-muted" /><div className="h-16 rounded-lg bg-muted" />
          <span className="sr-only">Loading local map, weather and exchange references</span>
        </div>
      ) : isError && !data ? (
        <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p>Destination references could not be loaded. Your recommendations are unaffected.</p>
          <Button data-testid="button-retry-destination-context" type="button" variant="outline" size="sm" className="mt-3 gap-2" onClick={() => void refetch()}><RefreshCw size={13} aria-hidden="true" /> Try again</Button>
        </div>
      ) : data ? (
        <div className="mt-4 space-y-5">
          {isError && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">Could not refresh destination references. Showing the last available snapshot. <button type="button" data-testid="button-retry-context-refresh" className="font-semibold underline underline-offset-2" onClick={() => void refetch()}>Retry</button></p>}
          {certifiedStays && (
            <section data-testid="section-certified-stays" aria-label="Official EU Ecolabel certified stays" className="min-w-0 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Hotel size={17} className="shrink-0 text-primary" aria-hidden="true" />
                <h4 className="text-sm font-semibold">Official EU Ecolabel stays</h4>
                <span data-testid="status-certified-stays" className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                  {certifiedStays.status === "available" ? "Registry checked" : certifiedStays.status === "unavailable" ? "Registry unavailable" : "Not covered"}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{certifiedStays.notice}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Verification reflects a registry snapshot checked within the last 24 hours and the listed licence expiry; it does not guarantee eligibility on your booking dates. Registry records do not show live room availability or prices. Live hotel inventory is unavailable because no Stays inventory access is connected.</p>
              {certifiedStays.status === "available" && certifiedStays.stays.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {certifiedStays.stays.map((stay) => {
                    const evidence = stay.certificationEvidence;
                    const verified = isCurrentEvidence(evidence, evidenceNow);
                    const recordUrl = safeLink(evidence.registryUrl);
                    const hotelUrl = evidence.hotelUrl ? safeLink(evidence.hotelUrl) : undefined;
                    return (
                      <li key={stay.id} data-testid={`certified-stay-${stay.id}`} className="min-w-0 rounded-lg border border-primary/20 bg-background/80 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="break-words text-sm">{stay.name}</strong>
                          {verified ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-600/25 bg-emerald-600/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">EU Ecolabel · verified in registry snapshot</span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-amber-600/25 bg-amber-600/10 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">Historical registry evidence · needs recheck</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{evidence.address || stay.address}{stay.city ? `, ${stay.city}` : ""}{stay.country ? `, ${stay.country}` : ""}</p>
                        <p className="mt-2 text-xs leading-relaxed">
                          <span className="block"><strong>Scheme:</strong> {evidence.scheme}</span>
                          <span className="block"><strong>Licence:</strong> {evidence.licenceNumber}</span>
                          <span className="block"><strong>Valid until:</strong> {safeDateLabel(evidence.validUntil)}</span>
                          <span className="block"><strong>Evidence checked:</strong> {timestampLabel(evidence.checkedAt)}</span>
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {recordUrl && <a data-testid={`link-certified-stay-record-${stay.id}`} href={recordUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">Official registry record <ExternalLink size={11} aria-hidden="true" /></a>}
                          {hotelUrl && <a data-testid={`link-certified-stay-hotel-${stay.id}`} href={hotelUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">Hotel website <ExternalLink size={11} aria-hidden="true" /></a>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : certifiedStays.status === "available" ? (
                <p className="mt-3 rounded-lg border border-border bg-background/70 p-3 text-xs text-muted-foreground">No matching EU Ecolabel registry records were returned for this destination. This does not mean that no certified stays exist.</p>
              ) : null}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {certifiedStays.source}
                {certifiedStays.checkedAt ? ` · Registry checked ${timestampLabel(certifiedStays.checkedAt)}` : " · Registry check date unavailable"}
                {certifiedStays.attribution ? ` · ${certifiedStays.attribution}` : ""}
                {safeLink(certifiedStays.sourceUrl) && <> · <a data-testid="link-certified-stays-source" href={safeLink(certifiedStays.sourceUrl)} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Source <ExternalLink size={10} className="inline" aria-hidden="true" /></a></>}
              </p>
            </section>
          )}
          {nearbyContext && (
            <section data-testid="section-nearby-map-context" aria-label="Nearby locations based on optional approximate location" className="min-w-0 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <MapPin size={17} className="shrink-0 text-primary" aria-hidden="true" />
                <h4 className="text-sm font-semibold">Nearby mapped places</h4>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                  {nearbyContext.status === "available" ? nearbyContext.stale ? "Older map snapshot" : nearbyContext.mode === "gps" ? "Approximate GPS" : "Approximate city" : nearbyContext.status === "skipped" ? "Skipped" : "Unavailable"}
                </span>
              </div>
              {nearbyContext.label && <p className="mt-1 text-xs text-muted-foreground">{nearbyContext.label}</p>}
              {nearbyContext.stale && <p role="note" className="mt-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs">This nearby map snapshot is older than 30 days and may be out of date; confirm each place directly.</p>}
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{nearbyContext.notice}</p>
              {nearbyContext.status === "available" && (
                <>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <NearbyPlaceList title="Mapped hotels" items={nearbyContext.hotels} />
                    <NearbyPlaceList title="Mapped transit stops" items={nearbyContext.transit} />
                    <NearbyPlaceList title="Mapped attractions" items={nearbyContext.attractions} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {nearbyContext.attribution ?? "OpenStreetMap source unavailable"}
                    {nearbyContext.checkedAt ? ` · Snapshot checked ${dateLabel(nearbyContext.checkedAt)}` : ""}
                  </p>
                </>
              )}
            </section>
          )}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">OpenStreetMap places</h4>
              <span data-testid="status-map-context" className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                {data.map.status === "ok" ? "Map snapshot available" : data.map.status === "stale" ? "Older map snapshot" : "Map snapshot unavailable"}
              </span>
            </div>
            {data.map.status === "cache-miss" ? (
              <p className="rounded-lg border border-border bg-background/70 p-3 text-xs text-muted-foreground">No cached map places for this destination yet. This is not a statement about what exists locally.</p>
            ) : (
              <>
                {data.map.status === "stale" && <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">This map snapshot may be out of date. Check each location directly before relying on it.</p>}
                <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                  <div className="min-w-0">
                    <LocationList title="Mapped hotels (certification not verified)" kind="hotels" items={data.map.hotels} note="OpenStreetMap locations only. These map listings are not matched to the official certification records above. Live hotel inventory, prices and availability are unavailable without Stays provider access." />
                  </div>
                  <LocationList title="Nearby transit stops" kind="transit" items={data.map.transit} note="Stations are not timetables or proof that a route is feasible." />
                </div>
                <LocationList title="Places to explore" kind="attractions" items={data.map.attractions} note="Map references, not bookings or opening-hour information." />
              </>
            )}
            <p data-testid="status-wikipedia-context" role="note" className="text-[11px] leading-relaxed text-muted-foreground">
              {data.map.wikipediaStatus === "available" ? "Wikipedia summaries appear only for attractions with a linked English article."
                : data.map.wikipediaStatus === "no-english-tag" ? "No English Wikipedia article tags were found for these mapped attractions."
                : data.map.wikipediaStatus === "lookup-unavailable" ? "Wikipedia lookup is unavailable; some article summaries may be missing."
                : "Wikipedia references are unavailable without a map snapshot."}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{data.map.attribution}{data.map.checkedAt ? ` · Map checked ${dateLabel(data.map.checkedAt)}` : " · Map check date unavailable"}</p>
          </div>
          <div className="grid min-w-0 gap-4 border-t border-border/60 pt-4 xl:grid-cols-2">
            <section aria-label="Transit departures and schedules" className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold"><TrainFront size={17} className="text-primary" aria-hidden="true" /> Transit departures &amp; schedules</h4>
                <span data-testid="status-transit-feed" className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                  {data.transitFeed.status === "available" ? "Feed available" : data.transitFeed.status === "unavailable" ? "Feed unavailable" : "Not covered"}
                </span>
              </div>
              {data.transitFeed.status === "available" && data.transitFeed.departures.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {data.transitFeed.departures.slice(0, 5).map((departure, index) => (
                    <li key={`${departure.stop}-${departure.line}-${departure.departureAt}-${index}`} className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs">
                      <strong>{departure.line}</strong> to {departure.destination} · {timestampLabel(departure.departureAt, "Europe/Oslo")}
                      <span className="block text-muted-foreground">{departure.stop} · {departure.timing === "real-time" ? "Real-time estimate" : "Scheduled time"}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {data.transitFeed.status === "available" && data.transitFeed.departures.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Entur returned no departures within its one-hour window.</p>}
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{data.transitFeed.notice}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {data.transitFeed.source ?? "No source connected"}
                {data.transitFeed.checkedAt ? ` · Checked ${timestampLabel(data.transitFeed.checkedAt)}` : " · No feed check performed"}
                {data.transitFeed.attribution ? ` · ${data.transitFeed.attribution}` : ""}
                {safeLink(data.transitFeed.sourceUrl ?? "") && <> · <a href={safeLink(data.transitFeed.sourceUrl ?? "")} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Source <ExternalLink size={10} className="inline" aria-hidden="true" /></a></>}
              </p>
            </section>
            <section aria-label="Current cultural events" className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold"><CalendarDays size={17} className="text-primary" aria-hidden="true" /> Current cultural events</h4>
                <span data-testid="status-cultural-events" className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                  {data.culturalEvents.status === "available" ? "Listings available" : data.culturalEvents.status === "unavailable" ? "Listings unavailable" : "Not covered"}
                </span>
              </div>
              {data.culturalEvents.status === "available" && data.culturalEvents.events.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {data.culturalEvents.events.slice(0, 5).map((event) => (
                    <li key={`${event.title}-${event.startAt}`} className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs">
                      <strong>{event.title}</strong> · {timestampLabel(event.startAt, "Europe/Paris")}
                      <span className="block text-muted-foreground">{event.venue}{event.category ? ` · ${event.category}` : ""}</span>
                      {safeLink(event.sourceUrl) && <a href={safeLink(event.sourceUrl)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary underline underline-offset-2">Event details <ExternalLink size={10} aria-hidden="true" /></a>}
                    </li>
                  ))}
                </ul>
              ) : null}
              {data.culturalEvents.status === "available" && data.culturalEvents.events.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No in-person events meeting this date window were returned.</p>}
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{data.culturalEvents.notice}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {data.culturalEvents.source ?? "No source connected"}
                {data.culturalEvents.checkedAt ? ` · Checked ${timestampLabel(data.culturalEvents.checkedAt)}` : " · No feed check performed"}
                {data.culturalEvents.attribution ? ` · ${data.culturalEvents.attribution}` : ""}
                {safeLink(data.culturalEvents.sourceUrl ?? "") && <> · <a href={safeLink(data.culturalEvents.sourceUrl ?? "")} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Source <ExternalLink size={10} className="inline" aria-hidden="true" /></a></>}
              </p>
            </section>
          </div>
          {offsetProgrammes && (
            <section data-testid="section-offset-programmes" aria-label="Curated offset programme directories" className="min-w-0 border-t border-border/60 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold">Carbon offset programme directories</h4>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium">Curated static demo</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{offsetProgrammes.notice}</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {offsetProgrammes.programmes.map((programme) => (
                  <li key={programme.id} className="min-w-0 rounded-lg border border-border/60 bg-background/70 p-3">
                    <strong className="text-sm">{programme.name}</strong>
                    <span className="block text-xs text-muted-foreground">{programme.organization} · {programme.evidenceType} · not live-checked</span>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{programme.limitations}</p>
                    {safeLink(programme.sourceUrl) && <a href={safeLink(programme.sourceUrl)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">Official directory <ExternalLink size={10} aria-hidden="true" /></a>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">{offsetProgrammes.source}; links have no live check date. Offsets are a separate climate contribution, not a substitute for reducing emissions or a claim of carbon neutrality.</p>
            </section>
          )}
          <div className="grid min-w-0 gap-4 border-t border-border/60 pt-4 xl:grid-cols-2">
            <section aria-label="Current weather" className="min-w-0">
              <h4 className="flex items-center gap-2 text-sm font-semibold"><CloudSun size={17} className="text-primary" aria-hidden="true" /> Weather nearby</h4>
              {data.weather.status === "available" && data.weather.current ? (
                <p data-testid="text-current-weather" className="mt-2 text-sm"><strong className="font-serif text-2xl">{Math.round(data.weather.current.temperatureC)}°C</strong> · {weatherDescription(data.weather.current.weatherCode)} <span className="block text-xs text-muted-foreground">Rain: {data.weather.current.precipitationMm.toLocaleString(undefined, { maximumFractionDigits: 1 })} mm · Wind: {data.weather.current.windSpeedKmh.toLocaleString(undefined, { maximumFractionDigits: 1 })} km/h</span><span className="block text-xs text-muted-foreground">Current model conditions at {data.weather.current.time}</span></p>
              ) : <p className="mt-2 text-xs text-muted-foreground">Current weather is unavailable.</p>}
              {data.weather.outlook.length > 0 && <ul className="mt-3 divide-y divide-border/60 text-xs">{data.weather.outlook.slice(0, 3).map((day) => <li key={day.date} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-2"><span>{dateLabel(day.date)} · {weatherDescription(day.weatherCode)} <span className="block text-muted-foreground">Rain: {day.precipitationMm.toLocaleString(undefined, { maximumFractionDigits: 1 })} mm</span></span><span className="font-semibold">{Math.round(day.temperatureMinC)}–{Math.round(day.temperatureMaxC)}°C</span></li>)}</ul>}
              {data.weather.travelAdvice && <p data-testid="text-weather-travel-advice" className="mt-2 rounded-lg bg-background/70 px-3 py-2 text-xs leading-relaxed"><strong>For planning:</strong> {data.weather.travelAdvice}</p>}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{data.weather.source}{data.weather.date ? ` · Updated ${dateLabel(data.weather.date)}` : ""}. {data.weather.notice} This is current and near-term weather, never a forecast for your future travel dates{data.weather.travelDates ? ` (${data.weather.travelDates})` : ""}. {data.weather.forecastAppliesToTravelDates === false ? "Travel dates are not covered by this forecast." : ""}</p>
            </section>
            <section aria-label="Currency reference" className="min-w-0">
              <h4 className="flex items-center gap-2 text-sm font-semibold"><ArrowRightLeft size={16} className="text-primary" aria-hidden="true" /> Currency reference</h4>
              <label htmlFor={currencyId} className="mt-3 block text-xs font-medium">Compare EUR with</label>
               <select data-testid="select-context-currency" id={currencyId} value={currency} onChange={(event) => setCurrency(event.target.value === "USD" ? "USD" : "GBP")} className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                 <option value="GBP">GBP</option><option value="USD">USD</option>
              </select>
              <label htmlFor={amountId} className="mt-3 block text-xs font-medium">Amount in EUR</label>
              <input data-testid="input-context-eur-amount" id={amountId} type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} aria-describedby={amountHelpId} aria-invalid={!amountValid} className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
              <p id={amountHelpId} className={`mt-1 text-[11px] ${amountValid ? "text-muted-foreground" : "text-destructive"}`}>
                {amountValid ? "Enter up to €1,000,000 with at most two decimal places." : Number.isFinite(parsedAmount) && parsedAmount === 0 && amount.trim() !== "" ? "Enter an amount greater than zero." : "Enter a valid EUR amount above zero, up to 1,000,000 with at most two decimal places."}
              </p>
              {!rateMatchesSelection ? <p role="status" className="mt-2 text-xs text-muted-foreground">Loading {currency} rate…</p> : isFetching && <p role="status" className="mt-2 text-xs text-muted-foreground">Refreshing {currency} rate…</p>}
              {rate !== null ? (
                <p data-testid="text-exchange-rate" className="mt-3 text-sm"><strong>1 {data.exchange.base} = {rate.toLocaleString(undefined, { maximumFractionDigits: 5 })} {data.exchange.target}</strong></p>
              ) : rateMatchesSelection && <p className="mt-3 text-xs text-muted-foreground">Rate unavailable. Check with your payment provider.</p>}
              <p data-testid="text-converted-amount" role="status" aria-live="polite" className="mt-2 text-sm font-semibold">
                {!amountValid ? "Conversion paused until a valid amount is entered." : !rateMatchesSelection ? "Waiting for selected rate…" : rate === null ? "Conversion unavailable without a rate." : `${new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(parsedAmount)} ≈ ${new Intl.NumberFormat(undefined, { style: "currency", currency }).format(parsedAmount * rate)}`}
              </p>
              {rateMatchesSelection && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{data.exchange.source}{data.exchange.date ? ` · Rate dated ${dateLabel(data.exchange.date)}` : " · Rate date unavailable"}. Reference rate only; card prices and recommendation order remain unchanged.</p>}
            </section>
          </div>
        </div>
      ) : null}
    </section>
  );
}