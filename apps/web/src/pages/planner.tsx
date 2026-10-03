import { useEffect, useMemo, useRef, useState } from "react";
import { useAppAuth } from "@/lib/app-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getListSavedTripsQueryKey,
  AssistantQuickReply,
  Recommendation,
  TripContext,
  useCreateSavedTrip,
  useListSavedTrips,
  useSendAssistantMessage,
  useUpdateSavedTrip,
  useRequestAdvisorHandover,
  getGuestHandoverStatus,
} from "@workspace/api-client-react";
import {
  Accessibility, BedDouble, Bot, CalendarDays, Check, ChevronLeft, ChevronRight, CloudOff, ExternalLink,
  HeartHandshake, Leaf, Loader2, MapPin, Minus, RefreshCw,
  Mic, MicOff, Plane, Plus, Save, Send, Sparkles, Users, Volume2, VolumeX, Wallet, Bus, Train, Car, Pencil, UserRound
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useCertificationClock } from "@/hooks/use-certification-clock";
import { DestinationContext } from "@/components/destination-context";
import { isCertificationEvidenceFresh } from "@/lib/certification-evidence";

type Message = {
  id: string;
  role: "user" | "assistant" | "human";
  text: string;
  recommendations?: Recommendation[];
  destinationSnapshot?: {
    destination: string;
    dateRange: string | null;
    locationMode: "skip" | "manual" | "gps";
    locationCity: string | null;
    gpsContextId?: string;
  };
  handoverRecommendation?: { recommended: boolean; reason: string | null; message: string | null };
};

type SaveState = "local" | "saving" | "saved" | "offline" | "error";

type SpeechRecognitionResultEvent = Event & {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionErrorEvent = Event & { error: string };

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

const EMPTY_CONTEXT: TripContext = {
  origin: null, destination: null, currentLocation: null, stopovers: [], dateRange: null,
  travellerCount: null, budget: null, transportPreferences: [], accessibilityNeeds: [],
  sustainabilityPriority: null, accommodationNeeds: [], locationConsentMode: null,
  reviewConfirmation: null, handoverRequested: false,
};

const PLACES = [
  { city: "Berlin", code: "BER", detail: "Berlin Brandenburg, Germany", aliases: "berlin brandenburg germany" },
  { city: "Paris", code: "PAR", detail: "Paris area airports, France", aliases: "paris cdg ory charles de gaulle orly france pari" },
  { city: "Lisbon", code: "LIS", detail: "Humberto Delgado, Portugal", aliases: "lisbon lisboa portugal" },
  { city: "Amsterdam", code: "AMS", detail: "Schiphol, Netherlands", aliases: "amsterdam netherlands holland" },
  { city: "Barcelona", code: "BCN", detail: "El Prat, Spain", aliases: "barcelona spain" },
  { city: "Copenhagen", code: "CPH", detail: "Kastrup, Denmark", aliases: "copenhagen denmark" },
  { city: "Oslo", code: "OSL", detail: "Gardermoen, Norway", aliases: "oslo norway" },
  { city: "Edinburgh", code: "EDI", detail: "Edinburgh Airport, Scotland", aliases: "edinburgh scotland uk" },
  { city: "San José", code: "SJO", detail: "Juan Santamaría, Costa Rica", aliases: "san jose costa rica" },
];

const TRANSPORT_OPTIONS = [
  { id: "rail", title: "Train", detail: "Lower impact, scenic", icon: Train },
  { id: "coach", title: "Bus / Coach", detail: "Cost effective", icon: Bus },
  { id: "flight", title: "Flight", detail: "For long distances", icon: Plane },
  { id: "flexible", title: "Compare all", detail: "Show practical alternatives", icon: Car },
];

const ACCOMMODATION_OPTIONS = [
  { id: "eco-hotel", title: "Eco-certified Hotel", detail: "Explore sourced certification claims", icon: Leaf },
  { id: "guesthouse", title: "Local Guesthouse", detail: "Support local economy", icon: HeartHandshake },
  { id: "apartment", title: "Apartment", detail: "Self-catering", icon: BedDouble },
];

const ACCESSIBILITY_OPTIONS = [
  { id: "none", title: "No specific needs", detail: "Standard options are fine", icon: Sparkles },
  { id: "wheelchair", title: "Wheelchair access", detail: "Step-free required", icon: Accessibility },
  { id: "mobility", title: "Limited mobility", detail: "Minimise walking/stairs", icon: Users },
];

const SUSTAINABILITY_OPTIONS = [
  { id: "climate-first", title: "Climate-first", detail: "Prioritise lower-carbon options", icon: Leaf },
  { id: "balanced", title: "Balanced", detail: "Good eco-choices within reason", icon: Check },
  { id: "comfort-first", title: "Comfort-first", detail: "Prioritise convenience and comfort", icon: Minus },
];

const newId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
const httpStatus = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const status = "status" in error ? (error as { status?: unknown }).status : null;
  if (typeof status === "number") return status;
  const response = "response" in error ? (error as { response?: unknown }).response : null;
  return response && typeof response === "object" && "status" in response &&
    typeof (response as { status?: unknown }).status === "number"
    ? (response as { status: number }).status
    : null;
};
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
const evidenceDateLabel = (value: string, dateOnly = false) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" });
};
const parseDateRange = (value: string | null) => {
  const [depart = "", returnDate = ""] = value?.split(/\s+(?:\/|to)\s+/i) ?? [];
  if (isIsoDate(depart) && (isIsoDate(returnDate) || returnDate === "Flexible return")) {
    return { depart, returnDate, natural: "" };
  }
  return { depart: "", returnDate: "", natural: value ?? "" };
};
const asContext = (value: unknown): TripContext => {
  const context = { ...EMPTY_CONTEXT, ...((value ?? {}) as Partial<TripContext>) } as TripContext & { activityPreferences?: string[] };
  if (context.locationConsentMode !== "manual") context.currentLocation = null;
  if (!Array.isArray(context.activityPreferences)) context.activityPreferences = [];
  return context;
};
const activityPreferencesOf = (value: TripContext) =>
  ((value as TripContext & { activityPreferences?: string[] }).activityPreferences ?? []);
const withActivityPreferences = (value: TripContext, activityPreferences: string[]) =>
  ({ ...value, activityPreferences } as TripContext);

const REQUESTED_SLOT_PREFIX = "__planner_slot__:";
const hiddenRequestedSlot = (replies: AssistantQuickReply[]) =>
  replies.find((reply) => reply.payload.startsWith(REQUESTED_SLOT_PREFIX))?.payload.slice(REQUESTED_SLOT_PREFIX.length) ?? null;
const visibleReplies = (replies: AssistantQuickReply[]) =>
  replies.filter((reply) =>
    !reply.payload.startsWith(REQUESTED_SLOT_PREFIX) &&
    !(/"location_mode"\s*:\s*"gps"/.test(reply.payload)));

function PlaceField({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const inputId = `place-${label.toLowerCase().replace(/\s+/g, "-")}`;
  useEffect(() => setQuery(value ?? ""), [value]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PLACES.slice(0, 5);
    return PLACES.filter((place) => `${place.city} ${place.code} ${place.detail} ${place.aliases}`.toLowerCase().includes(q.slice(0, Math.max(2, q.length - 1)))).slice(0, 5);
  }, [query]);
  return (
    <div className="relative space-y-1.5">
      <Label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="relative">
        <MapPin className="absolute left-3 top-3.5 text-primary/60" size={16} />
        <Input id={inputId} value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 200)} className="h-11 pl-10 rounded-xl bg-background border-border shadow-sm focus-visible:ring-primary" placeholder="City or airport" />
      </div>
      {open && (
        <div className="absolute z-50 top-[68px] left-0 right-0 rounded-xl border border-border bg-popover shadow-xl overflow-hidden">
          {matches.map((place) => (
            <button key={place.code} type="button" onMouseDown={() => { const next = `${place.city} (${place.code})`; setQuery(next); onChange(next); setOpen(false); }} className="w-full px-4 py-2.5 text-left hover:bg-primary/5 flex items-center gap-3 border-b border-border/40 last:border-0 transition-colors">
              <span className="w-10 font-bold text-primary text-sm">{place.code}</span>
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"><strong className="block text-sm font-semibold">{place.city}</strong><span className="block text-[11px] text-muted-foreground truncate">{place.detail}</span></span>
            </button>
          ))}
          <button type="button" onMouseDown={() => { onChange(query.trim()); setOpen(false); }} className="w-full px-4 py-2 text-left text-[11px] font-semibold text-muted-foreground hover:bg-muted bg-muted/30 transition-colors">Use “{query || "manual location"}” as entered</button>
        </div>
      )}
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-background p-3">
      <span className="font-semibold text-sm">{label}</span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon" aria-label={`Decrease ${label}`} className="h-7 w-7 rounded-full" disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={14}/></Button>
        <span className="w-4 text-center font-bold text-sm">{value}</span>
        <Button type="button" variant="outline" size="icon" aria-label={`Increase ${label}`} className="h-7 w-7 rounded-full" disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={14}/></Button>
      </div>
    </div>
  );
}

function ChoiceCard({ active, title, detail, icon: Icon, onClick }: { active: boolean; title: string; detail: string; icon: any; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`w-full text-left rounded-xl border p-3 transition-all flex items-center gap-3 ${active ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border/60 bg-transparent hover:border-primary/40 hover:bg-muted/50"}`}>
      <div className={`p-2 rounded-full transition-colors ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
        <Icon size={18} />
      </div>
      <div>
        <strong className="block text-sm font-semibold">{title}</strong>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </div>
    </button>
  );
}

function RecommendationCard({
  rec,
  selected = false,
  onSelect,
}: {
  rec: Recommendation;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const evidenceNow = useCertificationClock();
  const isLow = (rec.carbonLabel ?? "moderate").toLowerCase() === "low";
  const isHigh = (rec.carbonLabel ?? "moderate").toLowerCase() === "high";
  const priceUnavailable = /not available|unavailable/i.test(rec.price);
  const carbonClass = isLow ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900" : isHigh ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-200 dark:border-red-900" : "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900";
  const certificationEvidence = (rec as Recommendation & { certificationEvidence?: {
    scheme: string; licenceNumber: string; validUntil: string; checkedAt: string;
    registryUrl: string; hotelUrl: string | null; address: string;
  } | null }).certificationEvidence;
  const verifiedCertification = Boolean(
    certificationEvidence &&
    /eu ecolabel/i.test(certificationEvidence.scheme) &&
    isCertificationEvidenceFresh(certificationEvidence.validUntil, certificationEvidence.checkedAt, evidenceNow),
  );
  const evidenceRecordUrl = certificationEvidence && /^https:\/\//i.test(certificationEvidence.registryUrl) ? certificationEvidence.registryUrl : undefined;
  const carbonBasisText = `${rec.description} ${(rec.tags ?? []).join(" ")}`.toLowerCase();
  const carbonBasis = /property.?specific|measured at (this )?property|property.?level measured/.test(carbonBasisText)
    ? "Property-specific measured emissions"
    : /country.?average|indicative.*carbon|carbon.*indicative/.test(carbonBasisText) || rec.type === "stay"
      ? "Indicative country-average; not measured at this property"
      : "Estimate basis not specified";
  const optionalDetails = rec as Recommendation & {
    durationMinutes?: number | null;
    changes?: number;
    rankingExplanation?: string | null;
  };

  return (
    <Card data-testid={`card-recommendation-${rec.id}`} className="h-full rounded-2xl border border-border shadow-sm overflow-hidden">
      <CardContent className="p-4 md:p-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-3 mb-3">
          <div>
            <Badge variant="secondary" className="mb-2 uppercase tracking-wider text-[10px] font-bold">{rec.type}</Badge>
            <h3 className="font-serif text-lg md:text-xl font-bold leading-tight">{rec.name}</h3>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1"><MapPin size={12}/>{rec.location}</p>
            {optionalDetails.durationMinutes != null && <p className="mt-1 text-xs text-muted-foreground">Approx. {optionalDetails.durationMinutes} min</p>}
          </div>
          {onSelect && (
            <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={selected} onChange={() => onSelect(rec.id)} aria-label={`Include ${rec.name} in advisor request`} />
              Include in advisor request
            </label>
          )}
          <Badge variant="outline" className={`shrink-0 border whitespace-nowrap ${carbonClass}`}>
            {rec.carbonLabel ? `${rec.carbonLabel} impact` : "Carbon not estimated"}
          </Badge>
        </div>
        <p className="text-sm text-foreground/80 leading-relaxed mb-4">{rec.description}</p>
        {optionalDetails.rankingExplanation && (
          <p className="mb-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground"><strong className="text-foreground">Why this ranked:</strong> {optionalDetails.rankingExplanation}</p>
        )}
        {typeof optionalDetails.changes === "number" && (
          <p className="mb-3 text-xs text-muted-foreground"><strong className="text-foreground">Changes:</strong> {optionalDetails.changes === 0 ? "Direct" : `${optionalDetails.changes} connection${optionalDetails.changes === 1 ? "" : "s"}`}</p>
        )}

        {isHigh && (
          <div role="note" aria-label={`High-carbon warning for ${rec.name}`} className="mb-4 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
            <strong className="block font-bold">High-carbon option</strong>
            <span>{rec.carbonKg === null ? "A numeric carbon estimate is unavailable." : `This option has a high estimated impact: ${rec.carbonKg.toFixed(1)} kg CO₂e.`} Consider a lower-carbon alternative if practical.</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-border/60">
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1"><Wallet size={12}/>{priceUnavailable ? "Price availability" : "Price shown"}</span>
            <strong className="block mt-1 text-sm">{rec.price}</strong>
            <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">
              {priceUnavailable ? "No price supplied; check directly with the source." : "Pricing can change; confirm directly with the source."}
            </span>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1"><Leaf size={12}/> Carbon</span>
            <strong className="block mt-1 text-sm">{rec.carbonKg === null ? "Not available" : `${rec.carbonKg} kg CO₂e`}</strong>
            <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{carbonBasis}</span>
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-muted/40 p-2.5 text-[11px] text-muted-foreground flex flex-col gap-1">
          <span className="break-words"><strong className="text-foreground">Source:</strong> {rec.source.startsWith("https://") ? <a className="underline underline-offset-2 hover:text-primary" href={rec.source} target="_blank" rel="noopener noreferrer" aria-label={`Open source record for ${rec.name}`}>{rec.source}</a> : rec.source}</span>
          <span><strong className="text-foreground">Source checked:</strong> {new Date(rec.verifiedAt).toLocaleDateString()}</span>
          {certificationEvidence ? (
            <span data-testid={`${verifiedCertification ? "verified" : "unverified"}-certification-${rec.id}`} className="break-words">
              <strong className="text-foreground">{verifiedCertification ? "Verified in EU Ecolabel registry snapshot" : "Historical registry evidence · needs recheck"}</strong>
              <span className="block">Licence: {certificationEvidence.licenceNumber} · Valid until {evidenceDateLabel(certificationEvidence.validUntil, true)}</span>
              <span className="block">Evidence checked: {evidenceDateLabel(certificationEvidence.checkedAt)}</span>
              <span className="block">Snapshot verification is not a guarantee for your booking dates; confirm status directly before booking.</span>
              {evidenceRecordUrl && <a href={evidenceRecordUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-primary underline underline-offset-2">Official registry record <ExternalLink size={10} aria-hidden="true" /></a>}
            </span>
          ) : rec.certification && <span className="break-words"><strong className="text-foreground">Unverified certification claim:</strong> {rec.certification} <span className="block">No current official EU Ecolabel evidence is attached to this recommendation.</span></span>}
        </div>
      </CardContent>
    </Card>
  );
}

function StayRecommendationCarousel({
  recommendations,
  selectedIds,
  onSelect,
}: {
  recommendations: Recommendation[];
  selectedIds: string[];
  onSelect: (id: string) => void;
}) {
  const carouselRef = useRef<HTMLUListElement>(null);
  const carouselId = `stay-options-${recommendations[0]?.id ?? "recommendations"}`;
  const scroll = (direction: -1 | 1) => {
    const carousel = carouselRef.current;
    if (carousel) carousel.scrollBy({ left: direction * carousel.clientWidth * 0.85, behavior: "auto" });
  };

  return (
    <section aria-label="Hotel and stay recommendations" className="stay-carousel min-w-0 w-full">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{recommendations.length > 1 ? "Stay options · scroll horizontally or use the navigation buttons" : "Stay option"}</p>
        {recommendations.length > 1 && (
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="Scroll to previous stay recommendations" aria-controls={carouselId} data-testid={`button-previous-stays-${recommendations[0]?.id}`} className="h-8 w-8 rounded-full" onClick={() => scroll(-1)}>
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" aria-label="Scroll to next stay recommendations" aria-controls={carouselId} data-testid={`button-next-stays-${recommendations[0]?.id}`} className="h-8 w-8 rounded-full" onClick={() => scroll(1)}>
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      <ul id={carouselId} ref={carouselRef} tabIndex={0} role="list" aria-label="Hotel and stay options; horizontally scrollable" className="stay-carousel-track">
        {recommendations.map((rec) => (
          <li key={rec.id} className="stay-carousel-item" aria-label={`${rec.type} recommendation: ${rec.name}`}>
            <RecommendationCard rec={rec} selected={selectedIds.includes(rec.id)} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssistantMessageText({ text }: { text: string }) {
  const isFootprint = text.startsWith("Estimated trip footprint:");
  if (!isFootprint) return <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>;

  const [headline, ...details] = text.split("\n\n");
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-400">
          <Leaf size={14} />
          Estimated footprint
        </span>
        <p className="mt-2 font-serif text-xl font-bold leading-snug">{headline.replace("Estimated trip footprint: ", "")}</p>
      </div>
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/80">{details.join("\n\n")}</div>
    </div>
  );
}

function SummarySection({ icon: Icon, title, value, onEdit }: { icon: any, title: string, value: string, onEdit: () => void }) {
  return (
    <button type="button" onClick={onEdit} className="group flex w-full items-start gap-3 rounded-xl p-2 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <div className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary shrink-0">
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{title}</div>
        <div className={`text-sm mt-0.5 truncate ${value === "Not set" ? "text-muted-foreground italic" : "text-foreground font-medium"}`}>{value}</div>
      </div>
      <Pencil size={13} className="mt-2 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      <span className="sr-only">Edit {title}</span>
    </button>
  );
}

function PlannerSummary({ context, adults, children, saveState, onHandover, onEdit, handoverOpen, handoverConsent, onConsentChange, onRequestHandover, handoverPending, handoverMessage, canRequestHandover, guestEmail, onGuestEmailChange, guestStatus }: {
  context: TripContext, adults: number, children: number, saveState: string, onHandover: () => void, onEdit: (step: string) => void,
  handoverOpen: boolean, handoverConsent: boolean, onConsentChange: (consent: boolean) => void,
  onRequestHandover: () => void, handoverPending: boolean, handoverMessage: string, canRequestHandover: boolean
  guestEmail?: string, onGuestEmailChange: (email: string) => void, guestStatus: React.ReactNode
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-6">
        <h3 className="font-serif text-lg font-bold">Trip Summary</h3>
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-background px-2 py-1 rounded-full border shadow-sm">
          {saveState === "saving" ? <Loader2 size={12} className="animate-spin text-primary" /> : saveState === "saved" ? <Check size={12} className="text-primary" /> : saveState === "offline" ? <CloudOff size={12} /> : <Save size={12} />}
           <span>{saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : saveState === "offline" ? "Offline" : saveState === "error" ? "Error" : "Session only"}</span>
        </div>
      </div>

      <div className="space-y-5 flex-1 overflow-y-auto pr-2 pb-6">
        <SummarySection icon={MapPin} title="Route" value={context.origin && context.destination ? `${context.origin} → ${context.destination}` : "Not set"} onEdit={() => onEdit("route")} />
        <SummarySection icon={CalendarDays} title="Dates" value={context.dateRange || "Not set"} onEdit={() => onEdit("dates")} />
        <SummarySection icon={Users} title="Travellers" value={`${adults + children} total (${adults} adults, ${children} children)`} onEdit={() => onEdit("travelers")} />
        <SummarySection icon={Wallet} title="Budget" value={context.budget || "Not set"} onEdit={() => onEdit("budget")} />
        <SummarySection icon={Plane} title="Transport" value={context.transportPreferences.length > 0 ? context.transportPreferences.join(", ") : "Not set"} onEdit={() => onEdit("transport")} />
        <SummarySection icon={BedDouble} title="Accommodation" value={context.accommodationNeeds.length > 0 ? context.accommodationNeeds.join(", ") : "Not set"} onEdit={() => onEdit("accommodation")} />
        <SummarySection icon={Accessibility} title="Accessibility" value={context.accessibilityNeeds.length > 0 ? context.accessibilityNeeds.join(", ") : "Not set"} onEdit={() => onEdit("accessibility")} />
        <SummarySection icon={Sparkles} title="Activities" value={activityPreferencesOf(context).length ? activityPreferencesOf(context).join(", ") : "Not set"} onEdit={() => onEdit("activities")} />
        <SummarySection icon={Leaf} title="Sustainability" value={context.sustainabilityPriority || "Not set"} onEdit={() => onEdit("sustainability")} />
        <SummarySection icon={MapPin} title="Location" value={context.locationConsentMode === "manual" ? `Approximate city: ${context.currentLocation || "Not set"}` : context.locationConsentMode === "gps" ? "Approximate device location" : context.locationConsentMode === "skipped" ? "Skipped" : "Not set"} onEdit={() => onEdit("location")} />
      </div>

      <div className="mt-auto pt-6 border-t border-border/60">
        <Button data-testid="button-speak-to-advisor" variant="outline" className="w-full gap-2 bg-background hover:bg-muted transition-colors" onClick={onHandover}>
          <HeartHandshake size={16} />
          Request advisor help
        </Button>
        {handoverOpen && (
          <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
            <h4 className="text-sm font-semibold">Request a later advisor reply</h4>
            <p className="text-xs leading-relaxed font-medium">This is not live chat. An advisor reviews requests during staffed hours and replies later; timing depends on availability.</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              We will store a copy of your trip details and displayed options, including selected functional access requirements, and up to 30 recent messages after redacting contact details, precise locations, credentials, and sensitive free-text accessibility or medical information. This request context is visible only to its assigned advisor; the transcript is not included in the inbox notification email.
            </p>
            {guestEmail !== undefined && <label className="block text-xs font-medium">
              Email for your advisor's reply (no account required)
              <input data-testid="input-guest-advisor-email" type="email" autoComplete="email" value={guestEmail} onChange={(event) => onGuestEmailChange(event.target.value)} maxLength={254} placeholder="you@example.com" className="mt-2 w-full rounded-md border bg-background p-2 text-sm" />
              <span className="mt-1 block font-normal text-muted-foreground">Your email is stored separately for this request and shared only with its assigned advisor and the email provider. You can also read the reply in this planning tab. Guest requests expire with their original conversation (up to 30 days).</span>
            </label>}
            <label className="flex items-start gap-2 text-xs leading-relaxed">
              <input data-testid="checkbox-share-transcript-consent" type="checkbox" checked={handoverConsent} onChange={(event) => onConsentChange(event.target.checked)} className="mt-0.5 accent-primary" />
              <span>I agree to share and store the redacted conversation and privacy-minimised trip context with an assigned travel advisor{guestEmail !== undefined ? ", and to be contacted at the email above about this request" : ""}.</span>
            </label>
            <Button data-testid="button-submit-advisor-handover" className="w-full" disabled={!handoverConsent || !canRequestHandover || handoverPending} onClick={onRequestHandover}>
              {handoverPending ? <><Loader2 size={15} className="mr-2 animate-spin" /> Sending request…</> : "Send advisor request"}
            </Button>
            {!canRequestHandover && <p className="text-xs text-muted-foreground">{guestEmail !== undefined ? "Start the conversation and enter a valid reply email. Wait for any current planning answer before sending." : "Wait until the current trip changes are saved before sending."}</p>}
            {handoverMessage && <p role="status" data-testid="advisor-handover-status" className="text-xs text-primary">{handoverMessage}</p>}
            {guestStatus}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Planner() {
  const { isSignedIn, isLoaded, userId } = useAppAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState(newId);
  const [context, setContext] = useState<TripContext>(EMPTY_CONTEXT);
  const [guidedDraft, setGuidedDraft] = useState<TripContext>(EMPTY_CONTEXT);
  const [activityDraft, setActivityDraft] = useState("");
  const [requestedSlot, setRequestedSlot] = useState<string | null>(null);
  const [guidedFailure, setGuidedFailure] = useState<{ context: TripContext; message: string; payload: string } | null>(null);
  const [locationError, setLocationError] = useState("");
  const [gpsCoordinates, setGpsCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [gpsSnapshotRequestId, setGpsSnapshotRequestId] = useState<string | null>(null);
  const [selectedRecommendationIds, setSelectedRecommendationIds] = useState<string[]>([]);
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [depart, setDepart] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [naturalDateRange, setNaturalDateRange] = useState("");
  const [flexible, setFlexible] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [quickReplies, setQuickReplies] = useState<AssistantQuickReply[]>([]);
  const [failedReply, setFailedReply] = useState<AssistantQuickReply | null>(null);
  const [onlineRevision, setOnlineRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("local");
  const [autosaveEpoch, setAutosaveEpoch] = useState(0);
  const [savedTripId, setSavedTripId] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [hydratedScope, setHydratedScope] = useState("");
  const [resumeResolved, setResumeResolved] = useState(false);
  const [resumeInvalid, setResumeInvalid] = useState(false);
  const [handoverPanelOpen, setHandoverPanelOpen] = useState(false);
  const [handoverConsent, setHandoverConsent] = useState(false);
  const [handoverMessage, setHandoverMessage] = useState("");
  const [guestAdvisorEmail, setGuestAdvisorEmail] = useState("");
  const [guestAdvisorReference, setGuestAdvisorReference] = useState<{ sessionId: string; handoverId: string } | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem("landa-guest-advisor-reference") ?? "null");
      return typeof value?.sessionId === "string" && typeof value?.handoverId === "string" ? value : null;
    } catch { return null; }
  });
  const guestAdvisorQuery = useQuery({
    queryKey: ["guest-advisor-status", guestAdvisorReference?.sessionId, guestAdvisorReference?.handoverId],
    queryFn: () => getGuestHandoverStatus(guestAdvisorReference!),
    enabled: !isSignedIn && !!guestAdvisorReference && handoverPanelOpen,
    refetchInterval: (query) => query.state.error ? false : 15_000,
    retry: false,
  });
  useEffect(() => {
    setGuestAdvisorEmail("");
    setHandoverConsent(false);
    setHandoverMessage("");
  }, [isSignedIn, userId]);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const speechRecognition = useRef<BrowserSpeechRecognition | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editRevision = useRef(0);
  const lastSavedRevision = useRef(-1);
  const hydratedKey = useRef<string | null>(null);
  const resumedTripId = useRef<number | null>(null);
  const pendingNewSessionRef = useRef<{ sessionId: string; scope: string } | null>(null);
  const confirmationStartedAt = useRef<number | null>(null);
  const confirmationResponseAt = useRef<number | null>(null);
  const greetedSession = useRef<string | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const gpsCoordinatesRef = useRef(gpsCoordinates);
  gpsCoordinatesRef.current = gpsCoordinates;
  const adultsRef = useRef(adults);
  const childrenRef = useRef(children);
  adultsRef.current = adults;
  childrenRef.current = children;
  const updateGpsCoordinates = (coordinates: { latitude: number; longitude: number } | null) => {
    gpsCoordinatesRef.current = coordinates;
    setGpsCoordinates(coordinates);
  };

  useEffect(() => {
    if (!import.meta.env.DEV || confirmationStartedAt.current === null ||
        !messages.some((item) => Boolean(item.recommendations?.length))) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (confirmationStartedAt.current === null) return;
      const visibleAt = performance.now();
      const startedAt = confirmationStartedAt.current;
      const responseAt = confirmationResponseAt.current ?? visibleAt;
      performance.measure("planner-confirm-to-http-response", { start: startedAt, end: responseAt });
      performance.measure("planner-http-response-to-visible-recommendations", { start: responseAt, end: visibleAt });
      performance.measure("planner-confirm-to-visible-recommendations", { start: startedAt, end: visibleAt });
      confirmationStartedAt.current = null;
      confirmationResponseAt.current = null;
    }));
  }, [messages]);

  const savedTrips = useListSavedTrips({ query: { enabled: !!isSignedIn, queryKey: getListSavedTripsQueryKey() } });
  const createTrip = useCreateSavedTrip({ request: { headers: { "x-conversation-session": sessionId } } });
  const updateTrip = useUpdateSavedTrip({ request: { headers: { "x-conversation-session": sessionId } } });
  const sendMessage = useSendAssistantMessage();
  const requestHandover = useRequestAdvisorHandover({ request: { headers: { "x-conversation-session": sessionId } } });
  const voiceSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const speechOutputSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  // Anonymous planning must not depend on Clerk's remote SDK becoming ready.
  // Until authentication is known, use session-only guest state; a signed-in
  // account still switches to its own scoped draft when Clerk finishes loading.
  const draftScope = isLoaded && isSignedIn && userId ? `landa-planner-draft:${userId}` : "landa-planner-draft:guest";
  const scopeRef = useRef(draftScope);
  const sessionRef = useRef(sessionId);
  scopeRef.current = draftScope;
  sessionRef.current = sessionId;

  const markEdited = () => {
    editRevision.current += 1;
    setSelectedRecommendationIds([]);
    setGpsSnapshotRequestId(null);
  };
  const isGpsTravelContextQuery = (query: { queryKey: readonly unknown[] }) => {
    if (query.queryKey[0] !== "/api/travel-context") return false;
    const params = query.queryKey[1];
    return Boolean(params && typeof params === "object" && "locationMode" in params &&
      (params as { locationMode?: unknown }).locationMode === "gps");
  };
  const revokeGpsContext = () => {
    void queryClient.cancelQueries({ predicate: isGpsTravelContextQuery });
    queryClient.removeQueries({ predicate: isGpsTravelContextQuery });
    updateGpsCoordinates(null);
    setGpsSnapshotRequestId(null);
    setSelectedRecommendationIds([]);
    setMessages((items) => items.map((item) => item.destinationSnapshot?.locationMode === "gps"
      ? {
          ...item,
          destinationSnapshot: {
            ...item.destinationSnapshot,
            locationMode: "skip",
            locationCity: null,
            gpsContextId: undefined,
          },
        }
      : item));
  };
  const applyContext = (next: TripContext, counts?: { adults?: number; children?: number }) => {
    setContext(next);
    setGuidedDraft(next);
    const dates = parseDateRange(next.dateRange);
    setDepart(dates.depart);
    setReturnDate(dates.returnDate === "Flexible return" ? "" : dates.returnDate);
    setFlexible(dates.returnDate === "Flexible return");
    setNaturalDateRange(dates.natural);
    setAdults(counts?.adults ?? Math.max(1, next.travellerCount ?? 1));
    setChildren(counts?.children ?? 0);
  };

  const tripPayload = useMemo(() => ({
    title: context.destination ? `Trip to ${context.destination.replace(/\s*\(.+\)/, "")}` : "Untitled travel plan",
    origin: context.origin, destination: context.destination, dateRange: context.dateRange,
    travellerCount: context.travellerCount, budget: context.budget,
    sustainabilityPriority: context.sustainabilityPriority, context: { ...context, adults, children, flexibleDates: flexible },
    status: context.reviewConfirmation ? "ready" as const : "planning" as const,
  }), [context, adults, children, flexible]);

  // Date inputs are drafts. Commit the range only when both dates (or a
  // deliberately flexible return) have been confirmed in the dates step.

  useEffect(() => {
    const handleOnline = () => setOnlineRevision((value) => value + 1);
    const handleOffline = () => setSaveState("offline");
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => () => {
    speechRecognition.current?.abort();
    speechRecognition.current = null;
    window.speechSynthesis?.cancel();
  }, []);

  const toggleVoiceInput = () => {
    if (isListening) {
      speechRecognition.current?.stop();
      setVoiceStatus("Voice input stopped. Review the transcript before sending.");
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceStatus("Voice input is not supported in this browser. You can continue by typing.");
      return;
    }

    const recognition = new Recognition();
    const existingText = chatText.trim();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-GB";
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? "";
      }
      const combined = [existingText, transcript.trim()].filter(Boolean).join(" ");
      setChatText(combined);
      setFailedReply(null);
      const finalResult = Array.from({ length: event.results.length }, (_, index) => event.results[index].isFinal).every(Boolean);
      setVoiceStatus(finalResult ? "Voice captured. Review the transcript, then send it." : "Listening…");
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      speechRecognition.current = null;
      const message = event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Microphone permission was denied. Allow microphone access in your browser or continue by typing."
        : event.error === "no-speech"
          ? "No speech was detected. Try again or continue by typing."
          : "Voice input could not start. Try again or continue by typing.";
      setVoiceStatus(message);
    };
    recognition.onend = () => {
      setIsListening(false);
      speechRecognition.current = null;
      setVoiceStatus((current) => current === "Listening…" ? "Voice input ended. Review the transcript before sending." : current);
    };

    speechRecognition.current = recognition;
    setIsListening(true);
    setVoiceStatus("Listening…");
    try {
      recognition.start();
    } catch {
      setIsListening(false);
      speechRecognition.current = null;
      setVoiceStatus("Voice input could not start. Try again or continue by typing.");
    }
  };

  const toggleSpeechOutput = () => {
    if (!speechOutputSupported) {
      setVoiceStatus("Spoken responses are not supported in this browser.");
      return;
    }
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      setVoiceStatus("Spoken response stopped.");
      return;
    }
    const latestResponse = [...messages].reverse().find((message) => message.role !== "user");
    if (!latestResponse) {
      setVoiceStatus("There is no assistant response to read yet.");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(latestResponse.text);
    utterance.lang = navigator.language || "en-GB";
    utterance.rate = 1;
    utterance.onend = () => {
      setIsSpeaking(false);
      setVoiceStatus("Finished reading the latest response.");
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setVoiceStatus("The response could not be read aloud. You can continue by reading the message.");
    };
    setIsSpeaking(true);
    setVoiceStatus("Reading the latest response aloud…");
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    const draftKey = draftScope;
    if (hydratedKey.current === draftKey) return;
    pendingNewSessionRef.current = null;
    setHydrated(false);
    setHydratedScope("");
    setContext(EMPTY_CONTEXT);
    setGuidedDraft(EMPTY_CONTEXT);
    setActivityDraft("");
    setRequestedSlot(null);
    setGuidedFailure(null);
    setLocationError("");
    void queryClient.cancelQueries({ predicate: isGpsTravelContextQuery });
    queryClient.removeQueries({ predicate: isGpsTravelContextQuery });
    updateGpsCoordinates(null);
    setGpsSnapshotRequestId(null);
    setAdults(1);
    setChildren(0);
    setDepart("");
    setReturnDate("");
    setNaturalDateRange("");
    setFlexible(false);
    setSavedTripId(null);
    setResumeResolved(false);
    setResumeInvalid(false);
    setSaveState(isSignedIn ? "saving" : "local");
    setSessionId(newId());
    editRevision.current = 0;
    lastSavedRevision.current = -1;
    resumedTripId.current = null;
    setQuickReplies([]);
    setFailedReply(null);

    if (!isSignedIn) localStorage.removeItem("landa-planner-draft:guest");
    const accountDraft = isSignedIn ? localStorage.getItem(draftKey) : null;
    const guestDraft = isSignedIn ? localStorage.getItem("landa-planner-draft:guest") : null;
    const local = accountDraft ?? guestDraft;

    if (local) {
      try {
        const draft = JSON.parse(local);
        applyContext(asContext(draft.context), { adults: draft.adults, children: draft.children });
        if (!accountDraft && guestDraft && isSignedIn) localStorage.removeItem("landa-planner-draft:guest");

      } catch {
        localStorage.removeItem(draftKey);
      }
    }
    setMessages([]);
    setQuickReplies([]);
    setSelectedRecommendationIds([]);

    hydratedKey.current = draftKey;
    setHydratedScope(draftKey);
    setHydrated(true);
  }, [isLoaded, isSignedIn, userId, draftScope]);

  useEffect(() => {
    const rawTripId = new URLSearchParams(window.location.search).get("trip");
    if (!isLoaded && rawTripId) return;
    if (!isSignedIn || !rawTripId) { setResumeResolved(true); return; }
    if (savedTrips.isLoading) return;
    const requestedId = Number(rawTripId);
    if (resumedTripId.current === requestedId) { setResumeResolved(true); return; }

    const trip = savedTrips.data?.find((item) => item.id === requestedId);
    if (trip) {
      const stored = trip.context as Record<string, unknown>;
      revokeGpsContext();
      setSelectedRecommendationIds([]);
      applyContext(asContext(trip.context), { adults: Number(stored.adults ?? trip.travellerCount ?? 1), children: Number(stored.children ?? 0) });
      setSavedTripId(trip.id); setSaveState("saved"); setResumeInvalid(false); resumedTripId.current = requestedId; lastSavedRevision.current = editRevision.current;

      setMessages([]);
    } else {
      setResumeInvalid(true);
      resumedTripId.current = requestedId;
      toast({ title: "That saved trip was not found", description: "No other draft was overwritten. Open My Trips and choose a plan you can access.", variant: "destructive" });
    }
    setResumeResolved(true);
  }, [isLoaded, isSignedIn, savedTrips.isLoading, savedTrips.data]);

  useEffect(() => {
    if (!hydrated || !isLoaded) return;
    const draftKey = draftScope;
    if (hydratedScope !== draftKey) return;
    if (!isSignedIn) { setSaveState("local"); return; }
    localStorage.setItem(draftKey, JSON.stringify({ context, adults, children }));
    const pendingSession = pendingNewSessionRef.current;
    if (pendingSession?.sessionId === sessionId && pendingSession.scope === draftKey) {
      clearTimeout(saveTimer.current);
      setSaveState("saving");
      return;
    }
    if (!resumeResolved || resumeInvalid) return;
    if (editRevision.current <= lastSavedRevision.current) { setSaveState("saved"); return; }
    if (createTrip.isPending || updateTrip.isPending) { setSaveState("saving"); return; }

    clearTimeout(saveTimer.current);
    setSaveState(navigator.onLine ? "saving" : "offline");
    if (!navigator.onLine) return;

    saveTimer.current = setTimeout(() => {
      const revision = editRevision.current;
      const launchScope = draftScope;
      const launchSession = sessionId;
      const isCurrentLaunch = () => scopeRef.current === launchScope && sessionRef.current === launchSession;
      const options = {
        onSuccess: (trip: { id: number }) => {
          if (!isCurrentLaunch()) return;
          setSavedTripId(trip.id);
          lastSavedRevision.current = Math.max(lastSavedRevision.current, revision);
          setSaveState(revision === editRevision.current ? "saved" : "saving");
          queryClient.invalidateQueries({ queryKey: getListSavedTripsQueryKey() });
        },
        onError: () => { if (isCurrentLaunch()) setSaveState("error"); }
      };
      if (savedTripId) updateTrip.mutate({ id: savedTripId, data: tripPayload }, options);
      else if (context.destination || context.origin) createTrip.mutate({ data: tripPayload }, options);
      else { lastSavedRevision.current = revision; setSaveState("saved"); }
    }, 900);
    return () => clearTimeout(saveTimer.current);
  }, [context, adults, children, flexible, hydrated, hydratedScope, draftScope, isLoaded, isSignedIn, userId, savedTripId, resumeResolved, resumeInvalid, createTrip.isPending, updateTrip.isPending, onlineRevision, autosaveEpoch]);

  const runPlan = () => {
    if (sendMessage.isPending) return;
    if (import.meta.env.DEV) {
      confirmationStartedAt.current = performance.now();
      confirmationResponseAt.current = null;
    }
    submitChat({ title: "Confirm and compare options", payload: "/confirm_review" }, context);
  };

  const acceptRasaResult = (
    data: Awaited<ReturnType<typeof sendMessage.mutateAsync>>,
    launchScope: string,
    launchSession: string,
  ) => {
    if (scopeRef.current !== launchScope || sessionRef.current !== launchSession) return;
    const pendingSession = pendingNewSessionRef.current;
    if (pendingSession?.sessionId === launchSession && pendingSession.scope === launchScope) {
      pendingNewSessionRef.current = null;
      setAutosaveEpoch((epoch) => epoch + 1);
    }
    if (import.meta.env.DEV && data.recommendations.length > 0) confirmationResponseAt.current = performance.now();
    const withdrawingGpsConsent = contextRef.current.locationConsentMode === "gps" &&
      data.context.locationConsentMode !== "gps";
    if (withdrawingGpsConsent) revokeGpsContext();
    if (JSON.stringify(data.context) !== JSON.stringify(contextRef.current)) markEdited();
    const totalChanged = data.context.travellerCount !== contextRef.current.travellerCount;
    applyContext(data.context, totalChanged && data.context.travellerCount
      ? { adults: data.context.travellerCount, children: 0 }
      : { adults: adultsRef.current, children: childrenRef.current });
    setActivityDraft(activityPreferencesOf(data.context)[0] ?? "");
    if (data.context.locationConsentMode !== "gps") updateGpsCoordinates(null);
    setRequestedSlot(hiddenRequestedSlot(data.quickReplies));
    setQuickReplies(visibleReplies(data.quickReplies));
    setFailedReply(null);
    setGuidedFailure(null);
    const extended = data as typeof data & {
      handoverRecommendation?: { recommended: boolean; reason: string | null; message: string | null };
    };
    if (data.handover) openAdvisorHandover();

    const acceptedGpsCoordinates = gpsCoordinatesRef.current;
    const gpsContextId = data.recommendations.length > 0 &&
      data.context.reviewConfirmation && data.context.locationConsentMode === "gps" && acceptedGpsCoordinates
      ? newId()
      : undefined;
    if (gpsContextId) setGpsSnapshotRequestId(gpsContextId);
    const recommendationSnapshot: Message["destinationSnapshot"] = data.recommendations.length > 0 && data.context.reviewConfirmation && data.context.destination
      ? {
          destination: data.context.destination,
          dateRange: data.context.dateRange,
          locationMode: data.context.locationConsentMode === "manual" ? "manual" : data.context.locationConsentMode === "gps" ? "gps" : "skip",
          locationCity: data.context.locationConsentMode === "manual" ? data.context.currentLocation : null,
          gpsContextId,
        }
      : undefined;
    const newMessages: Message[] = data.messages.map((message, index) => ({
      id: newId(),
      role: "assistant",
      text: message,
      recommendations: index === data.messages.length - 1 ? data.recommendations : undefined,
      destinationSnapshot: index === data.messages.length - 1 ? recommendationSnapshot : undefined,
      handoverRecommendation: index === data.messages.length - 1 ? extended.handoverRecommendation : undefined,
    }));
    setMessages((items) => [...items, ...newMessages]);
    if (data.recommendations.length) setSelectedRecommendationIds([]);
  };

  const submitChat = (suggestedReply?: AssistantQuickReply, suppliedContext?: TripContext, guided = false, automatic = false) => {
    if (sendMessage.isPending) return;
    const text = (suggestedReply?.title ?? chatText).trim();
    if (!text) return;
    const retryPayload = suggestedReply?.payload ??
      (failedReply?.title === text ? failedReply.payload : undefined);
    setChatText("");
    setQuickReplies([]);
    setFailedReply(null);
    if (!automatic) setMessages((items) => [...items, { id: newId(), role: "user", text }]);

    const requestContext = suppliedContext ?? context;
    const launchScope = draftScope;
    const launchSession = sessionId;

    sendMessage.mutate({ data: { sessionId, message: text, ...(retryPayload ? { payload: retryPayload } : {}), context: requestContext } }, {
      onSuccess: (data) => {
        acceptRasaResult(data, launchScope, launchSession);
      },
      onError: (error) => {
        if (scopeRef.current !== launchScope || sessionRef.current !== launchSession) return;
        if (httpStatus(error) === 410) {
          const replacementSession = newId();
          clearTimeout(saveTimer.current);
          pendingNewSessionRef.current = { sessionId: replacementSession, scope: launchScope };
          setSaveState(isSignedIn ? "saving" : "local");
          markEdited();
          setContext(requestContext);
          setGuidedDraft(requestContext);
          setRequestedSlot(null);
          setQuickReplies([]);
          setFailedReply(null);
          setGuidedFailure(null);
          setMessages([{
            id: newId(),
            role: "assistant",
            text: "This assistant session expired. Your trip draft, dates, and preferences are still here; I’ve started a fresh conversation. You can continue planning or resend your message.",
          }]);
          setChatText(text);
          confirmationStartedAt.current = null;
          confirmationResponseAt.current = null;
          setSessionId(replacementSession);
          toast({
            title: "Assistant session expired",
            description: "Your trip draft is unchanged. A fresh assistant conversation is starting.",
          });
          return;
        }
        if (guided && retryPayload) {
          setGuidedFailure({ context: requestContext, message: text, payload: retryPayload });
        } else {
          setChatText(automatic ? "" : text);
          if (retryPayload) setFailedReply({ title: text, payload: retryPayload });
        }
        setMessages((items) => [...items, { id: newId(), role: "assistant", text: "I couldn't process that message. Your trip choices are unchanged. Retry the message below." }]);
        toast({ title: "Message not sent", description: "Your message is back in the box so you can retry.", variant: "destructive" });
      }
    });
  };

  useEffect(() => {
    if (!hydrated || !resumeResolved || resumeInvalid || sendMessage.isPending ||
        messages.length || greetedSession.current === sessionId) return;
    greetedSession.current = sessionId;
    const restored = contextRef.current.origin || contextRef.current.destination ||
      contextRef.current.dateRange || contextRef.current.budget;
    submitChat({ title: restored ? "Resume my trip" : "Hello", payload: restored ? "/resume_trip" : "/greet" }, contextRef.current, false, true);
  }, [hydrated, resumeResolved, resumeInvalid, sessionId, messages.length]);

  const guidedUpdate = (next: TripContext, message: string, payload: string) => {
    submitChat({ title: message, payload }, next, true);
  };

  function openAdvisorHandover() {
    setHandoverPanelOpen(true);
    setHandoverConsent(false);
    setHandoverMessage("");
    setSummaryOpen(true);
  }

  const canRequestHandover = Boolean(
    isLoaded && !sendMessage.isPending && (isSignedIn
      ? savedTripId && saveState === "saved" && editRevision.current <= lastSavedRevision.current
      : messages.some((message) => message.role === "user") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestAdvisorEmail.trim())),
  );

  const toggleRecommendationSelection = (id: string) => {
    setSelectedRecommendationIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const submitAdvisorHandover = () => {
    if (!canRequestHandover || !handoverConsent) {
      toast({
        title: "Complete the advisor request",
        description: "Confirm sharing and wait for the current planning answer. Guests also need a valid reply email; signed-in trips must finish saving.",
        variant: "destructive",
      });
      return;
    }
    const transcript = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-50)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.text.trim().slice(0, 4000) }))
      .filter((turn) => turn.content.length > 0);
    const displayedIds = new Set(messages.flatMap((item) => item.recommendations?.map((rec) => rec.id) ?? []));
    const selectedIds = selectedRecommendationIds.filter((id) => displayedIds.has(id));
    const launchScope = scopeRef.current;
    const launchSession = sessionId;
    requestHandover.mutate({
      data: {
        ...(isSignedIn ? { savedTripId: savedTripId! } : { sessionId, contactEmail: guestAdvisorEmail.trim() }),
        shareTranscriptConsent: true, transcript, selectedRecommendationIds: selectedIds,
      },
    }, {
      onSuccess: (data) => {
        if (scopeRef.current !== launchScope || sessionRef.current !== launchSession) return;
        setHandoverConsent(false);
        setHandoverMessage(`${data.handoverId}: ${data.nextStep} ${data.slaMessage}`);
        if (!isSignedIn) {
          const reference = { sessionId, handoverId: data.handoverId };
          setGuestAdvisorReference(reference);
          try { sessionStorage.setItem("landa-guest-advisor-reference", JSON.stringify(reference)); } catch { /* Status remains accessible in the current page. */ }
        }
        toast({ title: "Advisor request submitted", description: data.nextStep });
      },
      onError: (error) => {
        if (scopeRef.current !== launchScope || sessionRef.current !== launchSession) return;
        const detail = (error as { data?: { error?: string } }).data?.error;
        setHandoverMessage(detail ?? "The request could not be confirmed. Your planning details are unchanged; please retry.");
        toast({ title: "Advisor request not confirmed", description: detail ?? "Your planning details are unchanged. Try again when ready.", variant: "destructive" });
      },
    });
  };
  const guestAdvisorStatus = !isSignedIn && guestAdvisorReference ? (
    <div className="space-y-2 rounded-lg border bg-background p-3 text-xs" aria-live="polite">
      <p><strong>Advisor request {guestAdvisorReference.handoverId}</strong></p>
      {guestAdvisorQuery.data && <>
        <p>Status: {guestAdvisorQuery.data.status === "requested" ? "Waiting for an advisor" : guestAdvisorQuery.data.status === "assigned" ? "Assigned — advisor review in progress" : guestAdvisorQuery.data.status === "replied" ? "Advisor has replied" : "Request closed"}</p>
        {guestAdvisorQuery.data.travellerReply && <p className="whitespace-pre-wrap" data-testid="guest-advisor-reply">{guestAdvisorQuery.data.travellerReply}</p>}
        {guestAdvisorQuery.data.replyNotificationStatus === "accepted" && <p>Reply email accepted by the provider; inbox delivery is not guaranteed.</p>}
        {["failed", "not_configured"].includes(guestAdvisorQuery.data.replyNotificationStatus ?? "") && <p>Reply saved here, but email delivery is not confirmed.</p>}
      </>}
      {guestAdvisorQuery.isError && <p>Unable to load this request. If the original guest session has expired, check your reply email.</p>}
      <Button type="button" size="sm" variant="outline" onClick={() => guestAdvisorQuery.refetch()} disabled={guestAdvisorQuery.isFetching}>Check request status</Button>
      <p>Guest planning is session-only. This consented advisor request is stored separately; its reference stays in this browser tab until you close it.</p>
    </div>
  ) : null;

  const guidedInputStep = useMemo(() => {
    if (!requestedSlot) return "";
    if (requestedSlot === "review_confirmation") return "review";
    if (requestedSlot === "origin") return "origin";
    if (requestedSlot === "destination") return "destination";
    if (requestedSlot === "travel_dates") return "dates";
    if (requestedSlot === "travelers") return "travelers";
    if (requestedSlot === "budget") return "budget";
    if (requestedSlot === "transport_preference") return "transport";
    if (requestedSlot === "accommodation_need") return "accommodation";
    if (requestedSlot === "accessibility_need") return "accessibility";
    if (requestedSlot === "sustainability_level") return "sustainability";
    if (requestedSlot === "activity_preferences") return "activities";
    if (requestedSlot === "location_mode") return "location_mode";
    if (requestedSlot === "location") return "location";
    return "";
  }, [requestedSlot, context]);

  const beginEdit = (step: string) => {
    setSummaryOpen(false);
    setSelectedRecommendationIds([]);
    if (step === "location") revokeGpsContext();
    const slots: Record<string, unknown> = {
      route: { origin: null, destination: null },
      dates: { travel_dates: null },
      travelers: { travelers: null },
      budget: { budget: null },
      transport: { transport_preference: null },
      accommodation: { accommodation_need: null },
      accessibility: { accessibility_need: null },
      sustainability: { sustainability_level: null },
      activities: { activity_preferences: null },
      location: { location_mode: null, location: null },
    };
    const values = slots[step];
    if (!values || sendMessage.isPending) return;
    if (step === "activities") setActivityDraft("");
    const payload = `__planner_edit__:${JSON.stringify({ ...values, review_confirmation: null })}`;
    submitChat({ title: `Change ${step === "route" ? "route" : step === "travelers" ? "traveller count" : step}`, payload }, context, true);
  };

  const toggleList = (field: "transportPreferences" | "accommodationNeeds" | "accessibilityNeeds", value: string) => {
    markEdited();
    setGuidedDraft((current) => ({
      ...current,
      [field]: current[field].includes(value) ? current[field] : [value],
      reviewConfirmation: null
    }));
  };

  const renderGuidedInput = (step: string) => {
    switch (step) {
      case "origin":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Where will you travel from?</h4>
            <PlaceField label="Origin" value={guidedDraft.origin} onChange={(v) => { markEdited(); setGuidedDraft(c => ({...c, origin: v, reviewConfirmation: null})) }} />
            <Button className="w-full mt-2" disabled={!guidedDraft.origin || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `My origin is ${guidedDraft.origin}.`,
              `/guided_slot${JSON.stringify({ origin: guidedDraft.origin })}`,
            )}>Continue</Button>
          </div>
        );
      case "destination":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Where would you like to go?</h4>
            <PlaceField label="Destination" value={guidedDraft.destination} onChange={(v) => { markEdited(); setGuidedDraft(c => ({...c, destination: v, reviewConfirmation: null})) }} />
            <Button className="w-full mt-2" disabled={!guidedDraft.destination || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `My destination is ${guidedDraft.destination}.`,
              `/guided_slot${JSON.stringify({ destination: guidedDraft.destination })}`,
            )}>Continue</Button>
          </div>
        );
      case "dates":
        const earliestDate = new Date().toISOString().slice(0, 10);
        const validDeparture = isIsoDate(depart) && depart >= earliestDate;
        const validReturn = flexible || (isIsoDate(returnDate) && returnDate >= depart);
        const submitDates = () => {
          if (!validDeparture || !validReturn) return;
          const value = `${depart} to ${flexible ? "Flexible return" : returnDate}`;
          guidedUpdate(
            { ...guidedDraft, dateRange: value, reviewConfirmation: null },
            `My travel dates are ${value}.`,
            `/guided_slot${JSON.stringify({ travel_dates: value })}`,
          );
        };
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <div>
              <h4 className="font-semibold text-sm">Choose your travel dates</h4>
              <p className="mt-1 text-xs text-muted-foreground">Select departure and return separately.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="departure-date" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Departure</Label>
                <Input id="departure-date" type="date" min={earliestDate} value={depart} onChange={(event) => {
                  markEdited();
                  setNaturalDateRange("");
                  setDepart(event.target.value);
                  if (returnDate && event.target.value > returnDate) setReturnDate("");
                }} className="h-12 rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="return-date" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Return</Label>
                <Input id="return-date" type="date" min={depart || earliestDate} value={returnDate} disabled={flexible || !depart} onChange={(event) => {
                  markEdited();
                  setNaturalDateRange("");
                  setReturnDate(event.target.value);
                }} className="h-12 rounded-xl" />
              </div>
            </div>
            <Button type="button" variant={flexible ? "secondary" : "outline"} className="w-full" onClick={() => {
              markEdited();
              setFlexible((current) => !current);
              setReturnDate("");
            }}>
              {flexible ? "Flexible return selected" : "My return date is flexible"}
            </Button>
            <Button className="w-full" disabled={!validDeparture || !validReturn} onClick={submitDates}>Continue</Button>
          </div>
        );
      case "travelers":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-5">
            <h4 className="font-semibold text-sm">How many travellers are going?</h4>
            <div className="grid grid-cols-2 gap-4">
              <Stepper label="Adults" value={adults} min={1} max={12} onChange={(value) => { markEdited(); setAdults(value); setGuidedDraft((current) => ({ ...current, travellerCount: value + children, reviewConfirmation: null })); }}/>
              <Stepper label="Children" value={children} min={0} max={8} onChange={(value) => { markEdited(); setChildren(value); setGuidedDraft((current) => ({ ...current, travellerCount: adults + value, reviewConfirmation: null })); }}/>
            </div>
            <Button className="w-full" disabled={sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft, travellerCount: adults + children },
              `There are ${adults + children} travellers.`,
              `/guided_slot${JSON.stringify({ travelers: adults + children })}`,
            )}>Continue</Button>
          </div>
        );
      case "budget":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-5">
            <h4 className="font-semibold text-sm">What total budget should I work within?</h4>
            <div className="grid grid-cols-2 gap-2">
              {["Under €1,000","€1,000–2,500","€2,500–5,000","€5,000+"].map((value) => (
                <Button key={value} variant={guidedDraft.budget === value ? "secondary" : "outline"} className="h-auto py-3 text-[11px] font-semibold tracking-wide whitespace-normal text-muted-foreground hover:text-foreground" onClick={() => { markEdited(); setGuidedDraft((current) => ({ ...current, budget: value, reviewConfirmation: null })); }}>{value}</Button>
              ))}
            </div>
            <Button className="w-full" disabled={!guidedDraft.budget || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `My budget is ${guidedDraft.budget}.`,
              `/guided_slot${JSON.stringify({ budget: guidedDraft.budget })}`,
            )}>Continue</Button>
          </div>
        );
      case "transport":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">How do you prefer to travel?</h4>
            <div className="space-y-2">
              {TRANSPORT_OPTIONS.map(opt => (
                <ChoiceCard key={opt.id} active={guidedDraft.transportPreferences.includes(opt.id)} title={opt.title} detail={opt.detail} icon={opt.icon} onClick={() => toggleList("transportPreferences", opt.id)} />
              ))}
            </div>
            <Button className="w-full mt-2" disabled={guidedDraft.transportPreferences.length === 0 || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `For transport, I prefer: ${guidedDraft.transportPreferences[0]}.`,
              `/guided_slot${JSON.stringify({ transport_preference: guidedDraft.transportPreferences[0] })}`,
            )}>Continue</Button>
          </div>
        );
      case "accommodation":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Where would you like to stay?</h4>
            <div className="space-y-2">
              {ACCOMMODATION_OPTIONS.map(opt => (
                <ChoiceCard key={opt.id} active={guidedDraft.accommodationNeeds.includes(opt.id)} title={opt.title} detail={opt.detail} icon={opt.icon} onClick={() => toggleList("accommodationNeeds", opt.id)} />
              ))}
            </div>
            <Button className="w-full mt-2" disabled={guidedDraft.accommodationNeeds.length === 0 || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `For accommodation, I prefer: ${guidedDraft.accommodationNeeds[0]}.`,
              `/guided_slot${JSON.stringify({ accommodation_need: guidedDraft.accommodationNeeds[0] })}`,
            )}>Continue</Button>
          </div>
        );
      case "accessibility":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Any accessibility requirements?</h4>
            <div className="space-y-2">
              {ACCESSIBILITY_OPTIONS.map(opt => (
                <ChoiceCard key={opt.id} active={guidedDraft.accessibilityNeeds.includes(opt.id)} title={opt.title} detail={opt.detail} icon={opt.icon} onClick={() => toggleList("accessibilityNeeds", opt.id)} />
              ))}
            </div>
            <Button className="w-full mt-2" disabled={guidedDraft.accessibilityNeeds.length === 0 || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `My accessibility need is ${guidedDraft.accessibilityNeeds[0]}.`,
              `/guided_slot${JSON.stringify({ accessibility_need: guidedDraft.accessibilityNeeds[0] })}`,
            )}>Continue</Button>
          </div>
        );
      case "sustainability":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">How important is minimizing carbon impact?</h4>
            <div className="space-y-2">
              {SUSTAINABILITY_OPTIONS.map(opt => (
                <ChoiceCard key={opt.id} active={guidedDraft.sustainabilityPriority === opt.id} title={opt.title} detail={opt.detail} icon={opt.icon} onClick={() => { markEdited(); setGuidedDraft(c => ({...c, sustainabilityPriority: opt.id, reviewConfirmation: null})); }} />
              ))}
            </div>
            <Button className="w-full mt-2" disabled={!guidedDraft.sustainabilityPriority || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft },
              `My sustainability priority is ${guidedDraft.sustainabilityPriority}.`,
              `/guided_slot${JSON.stringify({ sustainability_level: guidedDraft.sustainabilityPriority })}`,
            )}>Continue</Button>
          </div>
        );
      case "activities":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">What activities would you enjoy?</h4>
            <p className="text-xs text-muted-foreground">Choose one focus for the recommendations.</p>
            <div className="space-y-2">
              {[
                ["cultural", "Cultural experiences"],
                ["outdoor", "Outdoor activities"],
                ["nature", "Nature and wildlife"],
                ["flexible", "No preference"],
              ].map(([value, label]) => (
                <ChoiceCard key={value} active={activityDraft === value} title={label} detail="Use this to tailor activity suggestions" icon={Sparkles} onClick={() => { markEdited(); setActivityDraft(value); }} />
              ))}
            </div>
            <Button className="w-full" disabled={!activityDraft || sendMessage.isPending} onClick={() => guidedUpdate(
              withActivityPreferences(guidedDraft, [activityDraft]),
              `I would enjoy ${activityDraft} activities.`,
              `/guided_slot${JSON.stringify({ activity_preferences: [activityDraft] })}`,
            )}>Continue</Button>
          </div>
        );
      case "location_mode":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Location preferences</h4>
            <p className="text-[13px] text-muted-foreground leading-relaxed">Optional: use a city or approximate device location to find nearby options. Device coordinates are rounded to two decimals, kept only in this browser session, and sent only with the nearby-options query after you confirm your trip; they are not saved with your trip or sent to the Rasa assistant.</p>
            <div className="space-y-3">
               <Button variant="secondary" className="w-full gap-2 border shadow-sm" onClick={() => {
                   setLocationError("");
                    setSelectedRecommendationIds([]);
                    setGpsSnapshotRequestId(null);
                   if (!navigator.geolocation) {
                     setLocationError("Device location is unavailable in this browser. You can enter an approximate city or skip.");
                     return;
                   }
                   navigator.geolocation.getCurrentPosition(
                     (pos) => {
                       const latitude = Number(pos.coords.latitude.toFixed(2));
                       const longitude = Number(pos.coords.longitude.toFixed(2));
                       updateGpsCoordinates({ latitude, longitude });
                       guidedUpdate(
                         { ...guidedDraft, locationConsentMode: "gps", currentLocation: null, reviewConfirmation: null },
                         "Use approximate device location.",
                         `/guided_slot${JSON.stringify({ location_mode: "gps" })}`,
                       );
                     },
                     () => setLocationError("Location permission was not granted. Your answers are unchanged; enter an approximate city or skip location."),
                     { maximumAge: 0, timeout: 10_000 },
                   );
                }}><MapPin size={16}/> Allow approximate device location</Button>
                {locationError && <p role="alert" className="text-xs text-destructive">{locationError}</p>}
                <Button type="button" variant="outline" className="w-full" disabled={sendMessage.isPending} onClick={() => {
                  revokeGpsContext();
                  setGuidedDraft((current) => ({ ...current, currentLocation: null, locationConsentMode: "manual" }));
                  guidedUpdate(
                    { ...guidedDraft, currentLocation: null, locationConsentMode: "manual", reviewConfirmation: null },
                    "Enter an approximate city.",
                    `/guided_slot${JSON.stringify({ location_mode: "manual" })}`,
                  );
                }}>Enter an approximate city</Button>
                <Button variant="ghost" className="w-full text-xs text-muted-foreground hover:text-foreground" disabled={sendMessage.isPending} onClick={() => {
                  revokeGpsContext();
                  guidedUpdate({ ...guidedDraft, locationConsentMode: "skipped", currentLocation: null, reviewConfirmation: null }, "Skip location sharing.", `/guided_slot${JSON.stringify({ location_mode: "none" })}`);
                }}>Skip location sharing</Button>
            </div>
          </div>
        );
      case "location":
        return (
          <div className="bg-card border shadow-sm rounded-2xl p-5 w-full max-w-md space-y-4">
            <h4 className="font-semibold text-sm">Which approximate city or region?</h4>
            <p className="text-xs text-muted-foreground">Enter a city or region only, not a street address or home location.</p>
            <PlaceField label="Approximate city or region" value={guidedDraft.currentLocation} onChange={(v) => setGuidedDraft((current) => ({ ...current, currentLocation: v }))} />
            <Button variant="outline" className="w-full mt-2 bg-background hover:bg-muted" disabled={!guidedDraft.currentLocation || sendMessage.isPending} onClick={() => guidedUpdate(
              { ...guidedDraft, locationConsentMode: "manual", reviewConfirmation: null },
              `My approximate city is ${guidedDraft.currentLocation}.`,
              `/guided_slot${JSON.stringify({ location: guidedDraft.currentLocation })}`,
            )}>Continue with approximate city</Button>
          </div>
        );
      case "review":
        return (
          <div className="bg-primary/5 border border-primary/20 shadow-sm rounded-2xl p-6 w-full max-w-lg space-y-5">
            <div className="w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center mx-auto mb-2 shadow-sm">
              <Sparkles size={24} />
            </div>
            <div className="text-center">
              <h4 className="font-serif font-bold text-xl text-primary">Are you happy with these details?</h4>
              <p className="mt-1 text-sm text-foreground/75">Please confirm before I calculate your footprint and compare options.</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/80 p-4 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="font-semibold text-muted-foreground">Route</dt><dd>{context.origin} → {context.destination}</dd>
                <dt className="font-semibold text-muted-foreground">Dates</dt><dd>{context.dateRange}</dd>
                <dt className="font-semibold text-muted-foreground">Travellers</dt><dd>{adults + children} total</dd>
                <dt className="font-semibold text-muted-foreground">Budget</dt><dd>{context.budget}</dd>
                <dt className="font-semibold text-muted-foreground">Transport</dt><dd>{context.transportPreferences.join(", ")}</dd>
                <dt className="font-semibold text-muted-foreground">Stay</dt><dd>{context.accommodationNeeds.join(", ")}</dd>
                <dt className="font-semibold text-muted-foreground">Accessibility</dt><dd>{context.accessibilityNeeds.join(", ")}</dd>
                <dt className="font-semibold text-muted-foreground">Priority</dt><dd>{context.sustainabilityPriority}</dd>
                <dt className="font-semibold text-muted-foreground">Location</dt><dd>{context.locationConsentMode === "manual" ? `Approximate city: ${context.currentLocation || "Not set"}` : context.locationConsentMode === "gps" ? "Approximate device location" : context.locationConsentMode === "skipped" ? "Skipped" : "Not set"}</dd>
              </dl>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
               <Button variant="outline" className="h-11" onClick={() => submitChat({ title: "I want to change something", payload: "/deny" }, context)}>No, change something</Button>
               <Button className="h-11" onClick={runPlan}>Yes, show my results</Button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = messages.some((message) => message.role === "user")
        ? scrollRef.current.scrollHeight : 0;
    }
  }, [messages, guidedInputStep]);

  return (
    <div className="flex h-[calc(100dvh-var(--navbar-height,4rem))] w-full max-w-7xl mx-auto overflow-hidden">

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full bg-background relative border-r border-border">

         {/* Mobile Header for Summary Toggle */}
         <div className="lg:hidden flex items-center justify-between p-3 border-b border-border bg-card shadow-sm z-20">
           <span className="font-serif font-bold text-primary">Trip Planner</span>
           <Button variant="outline" size="sm" className="h-8 text-xs font-semibold uppercase tracking-wider" onClick={() => setSummaryOpen(!summaryOpen)}>
             {summaryOpen ? 'Close Summary' : 'View Summary'}
           </Button>
         </div>

          <div data-testid="planner-ai-disclosure" className="border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground">
            AI travel assistant · Carbon figures are estimates; check prices and availability before booking.{" "}
            <a href={`${import.meta.env.BASE_URL}privacy`} className="underline underline-offset-2">Privacy &amp; data use</a>
          </div>
          {/* Messages Area */}
          <div ref={scrollRef} aria-busy={sendMessage.isPending} className={`flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 space-y-6 pb-40 ${summaryOpen ? 'hidden lg:block' : 'block'}`}>
            {messages.length === 0 && hydrated && resumeResolved && !resumeInvalid && (
              <div data-testid="planner-welcome" className="rounded-2xl border border-border bg-card p-6 space-y-3">
                <h1 className="font-serif text-xl font-semibold text-primary">Connecting to your travel assistant</h1>
                <p className="text-sm text-muted-foreground">
                  Your AI assistant will greet you and ask one question at a time.
                </p>
                <Button data-testid="button-start-planning" disabled={sendMessage.isPending} onClick={() => submitChat({ title: "Hello", payload: "/greet" }, context, false, true)}>
                  {sendMessage.isPending ? "Connecting…" : "Retry greeting"}
                </Button>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} w-full`}>
                {msg.role === 'assistant' && (
                  <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center shrink-0 mr-3 mt-1 shadow-sm">
                    <Bot size={16} className="text-primary-foreground" />
                  </div>
                )}
                 {msg.role === 'human' && (
                   <div className="h-8 w-8 rounded-full bg-violet-600 flex items-center justify-center shrink-0 mr-3 mt-1 shadow-sm ring-2 ring-violet-200 dark:ring-violet-900">
                     <UserRound size={16} className="text-white" />
                   </div>
                 )}
                 <div className={`max-w-[85%] md:max-w-[75%] ${
                   msg.role === 'user'
                     ? 'bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-5 py-3.5 shadow-sm'
                     : msg.role === 'human'
                       ? 'bg-violet-50 border border-violet-300 shadow-sm rounded-2xl rounded-tl-sm px-5 py-3.5 text-violet-950 dark:bg-violet-950/50 dark:border-violet-800 dark:text-violet-100'
                       : 'bg-card border border-border shadow-sm rounded-2xl rounded-tl-sm px-5 py-3.5 text-card-foreground'
                 }`}>
                   {msg.role === "human" && (
                     <div className="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
                       Eli · Human travel advisor
                       <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                       Online
                     </div>
                   )}
                  <AssistantMessageText text={msg.text} />
                   {msg.handoverRecommendation?.recommended && (
                     <aside className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3" aria-label="Advisor recommendation">
                       <p className="text-sm">{msg.handoverRecommendation.message || "A travel advisor may be helpful for this trip."}</p>
                       {msg.handoverRecommendation.reason && <p className="mt-1 text-xs text-muted-foreground">{msg.handoverRecommendation.reason}</p>}
                       <Button type="button" size="sm" variant="outline" className="mt-3" onClick={openAdvisorHandover}>Ask an advisor</Button>
                     </aside>
                   )}
                  {msg.recommendations && msg.recommendations.length > 0 && (
                    <div data-testid={`recommendations-${msg.id}`} className="mt-5 min-w-0 space-y-4 border-t border-border/50 pt-5">
                      {msg.recommendations.some((rec) => rec.type === "stay") && (
                        <StayRecommendationCarousel recommendations={msg.recommendations.filter((rec) => rec.type === "stay")} selectedIds={selectedRecommendationIds} onSelect={toggleRecommendationSelection} />
                      )}
                      {msg.recommendations.filter((rec) => rec.type !== "stay").map((rec) => <RecommendationCard key={rec.id} rec={rec} selected={selectedRecommendationIds.includes(rec.id)} onSelect={toggleRecommendationSelection} />)}
                      {msg.destinationSnapshot && (
                        <DestinationContext
                          snapshot={msg.destinationSnapshot}
                          gpsCoordinates={msg.destinationSnapshot.gpsContextId === gpsSnapshotRequestId
                            ? gpsCoordinates ?? undefined
                            : undefined}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Guided Input embedded in chat */}
             {sendMessage.isPending && (
               <div role="status" aria-live="polite" className="flex items-center gap-2 pl-11 text-sm text-muted-foreground">
                 <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                 Waiting for the travel assistant’s next question…
               </div>
             )}
             {guidedInputStep && messages.length > 0 && messages[messages.length - 1].role === "assistant" && (
               <div className="flex gap-4 animate-in fade-in slide-in-from-bottom-2 mt-4">
                 <div className="w-8 shrink-0 hidden md:block" />
                  <fieldset disabled={sendMessage.isPending} className="contents">
                    {renderGuidedInput(guidedInputStep)}
                  </fieldset>
               </div>
            )}
             {guidedFailure && (
               <div role="alert" className="ml-11 max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
                 <p>Your guided answers are still staged and were not applied. Retry when the assistant is available.</p>
                 <Button type="button" variant="outline" size="sm" className="mt-2 gap-2" disabled={sendMessage.isPending} onClick={() => submitChat({ title: guidedFailure.message, payload: guidedFailure.payload }, guidedFailure.context, true)}>
                   <RefreshCw size={14} aria-hidden="true" /> Retry guided answer
                 </Button>
               </div>
             )}
             {failedReply && !chatText && ["Hello", "Resume my trip"].includes(failedReply.title) && (
               <Button type="button" variant="outline" disabled={sendMessage.isPending}
                 onClick={() => submitChat(failedReply, context, false, true)}>
                 Retry assistant greeting
               </Button>
             )}
         </div>

         {/* Mobile Summary View */}
         {summaryOpen && (
             <div className="flex-1 overflow-y-auto bg-muted/20 p-5 lg:hidden">
              <PlannerSummary context={context} adults={adults} children={children} saveState={saveState} onHandover={openAdvisorHandover} onEdit={beginEdit} handoverOpen={handoverPanelOpen} handoverConsent={handoverConsent} onConsentChange={setHandoverConsent} onRequestHandover={submitAdvisorHandover} handoverPending={requestHandover.isPending} handoverMessage={handoverMessage} canRequestHandover={canRequestHandover} guestEmail={isSignedIn ? undefined : guestAdvisorEmail} onGuestEmailChange={setGuestAdvisorEmail} guestStatus={guestAdvisorStatus} />
            </div>
         )}

         {/* Chat Input Area */}
         <div className={`p-4 md:p-6 bg-background/95 backdrop-blur border-t border-border z-20 ${summaryOpen ? 'hidden lg:block' : 'block'}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
               <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" className="h-8 gap-2 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground" onClick={openAdvisorHandover}>
                   <HeartHandshake size={15} />
                    Request advisor help
                 </Button>
                 <Button type="button" variant="ghost" size="sm" disabled={!speechOutputSupported} aria-label={isSpeaking ? "Stop spoken response" : "Read latest response aloud"} aria-pressed={isSpeaking} onClick={toggleSpeechOutput} className="h-8 gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground">
                   {isSpeaking ? <VolumeX size={15} /> : <Volume2 size={15} />}
                   {isSpeaking ? "Stop audio" : "Listen"}
                 </Button>
               </div>
                <span className="hidden text-[10px] text-muted-foreground sm:inline">Advisor requests are reviewed during staffed hours.</span>
            </div>
            {quickReplies.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {quickReplies.map((reply, index) => (
                   <Button key={`${reply.title}-${reply.payload}-${index}`} variant="outline" size="sm" disabled={sendMessage.isPending} className="rounded-full text-xs bg-background shadow-sm hover:bg-muted" onClick={() => submitChat(reply)}>
                    {reply.title}
                  </Button>
                ))}
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); submitChat(); }} className="relative flex items-end gap-2">
              <div className="relative flex-1">
                <Textarea
                  value={chatText}
                  disabled={sendMessage.isPending}
                  onChange={(e) => {
                    setChatText(e.target.value);
                    if (failedReply) setFailedReply(null);
                  }}
                  placeholder="Type your answer or ask a question..."
                  aria-describedby="voice-input-status"
                  className="min-h-[52px] w-full resize-none rounded-2xl pr-14 py-3.5 bg-card border-border shadow-sm focus-visible:ring-primary focus-visible:bg-background transition-colors text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submitChat();
                    }
                  }}
                />
                 <Button
                   type="button"
                   variant="ghost"
                   size="icon"
                   aria-label={isListening ? "Stop voice input" : "Start voice input"}
                   aria-pressed={isListening}
                   disabled={!voiceSupported || sendMessage.isPending}
                   title={voiceSupported ? (isListening ? "Stop voice input" : "Use voice input") : "Voice input is not supported in this browser"}
                   onClick={toggleVoiceInput}
                   className={`absolute bottom-2 right-2 h-9 w-9 rounded-full ${isListening ? "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950/60 dark:text-red-300" : "text-muted-foreground hover:text-foreground"}`}
                 >
                   {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                 </Button>
              </div>
               <Button type="submit" size="icon" disabled={!chatText.trim() || sendMessage.isPending} className="h-[52px] w-[52px] rounded-2xl shrink-0 shadow-sm transition-transform active:scale-95">
                {sendMessage.isPending ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
              </Button>
            </form>
             <p id="voice-input-status" className="mt-2 min-h-4 text-xs text-muted-foreground" role="status" aria-live="polite">
               {voiceStatus || (voiceSupported ? "You can type or use the microphone. Voice stays in your browser until you send the transcript." : "Voice input is unavailable in this browser; text input remains available.")}
             </p>
         </div>
      </div>

      {/* Desktop Summary Sidebar */}
      <div className="hidden lg:block w-80 xl:w-96 bg-muted/10 p-6 overflow-y-auto">
         <PlannerSummary context={context} adults={adults} children={children} saveState={saveState} onHandover={openAdvisorHandover} onEdit={beginEdit} handoverOpen={handoverPanelOpen} handoverConsent={handoverConsent} onConsentChange={setHandoverConsent} onRequestHandover={submitAdvisorHandover} handoverPending={requestHandover.isPending} handoverMessage={handoverMessage} canRequestHandover={canRequestHandover} guestEmail={isSignedIn ? undefined : guestAdvisorEmail} onGuestEmailChange={setGuestAdvisorEmail} guestStatus={guestAdvisorStatus} />
      </div>
    </div>
  );
}
