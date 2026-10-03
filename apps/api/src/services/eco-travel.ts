import type { Recommendation, TripContext } from "@workspace/api-zod";

export const emptyTripContext: TripContext = {
  origin: null,
  destination: null,
  currentLocation: null,
  stopovers: [],
  dateRange: null,
  travellerCount: null,
  budget: null,
  transportPreferences: [],
  accessibilityNeeds: [],
  sustainabilityPriority: null,
  accommodationNeeds: [],
  locationConsentMode: null,
  reviewConfirmation: null,
  handoverRequested: false,
};

const verifiedAt = "2026-09-19";

export const featuredRecommendations: Recommendation[] = [
  {
    id: "rail-berlin-prague",
    type: "transport",
    name: "Berlin to Prague by daytime rail",
    location: "Berlin → Prague",
    description: "A city-centre to city-centre route with significantly lower estimated emissions than flying. Reservation recommended at peak times.",
    price: "from €29",
    carbonKg: 14,
    carbonLabel: "low",
    score: 94,
    certification: null,
    source: "Demo estimate using UK Government conversion factors",
    verifiedAt,
    tags: ["rail", "city break", "low carbon"],
  },
  {
    id: "experience-lisbon-community",
    type: "experience",
    name: "Community food and heritage walk",
    location: "Lisbon, Portugal",
    description: "A small-group walking experience designed to support independent neighbourhood businesses and local cultural interpretation.",
    price: "from €38",
    carbonKg: 0.8,
    carbonLabel: "low",
    score: 89,
    certification: null,
    source: "Demo community-tourism catalogue",
    verifiedAt,
    tags: ["local community", "walking", "small group"],
  },
  {
    id: "flight-berlin-lisbon",
    type: "transport",
    name: "Direct economy flight",
    location: "Berlin → Lisbon",
    description: "Fastest option for this distance, but with a substantially higher climate impact. The estimate includes a radiative-forcing uplift.",
    price: "from €118",
    carbonKg: 412,
    carbonLabel: "high",
    score: 48,
    certification: null,
    source: "Demo estimate using UK Government conversion factors",
    verifiedAt,
    tags: ["flight", "direct", "high emission"],
  },
];

const currencyPattern = /(?:€|eur|£|gbp|\$|usd)\s?(\d{2,5})|(\d{2,5})\s?(?:€|eur|£|gbp|\$|usd)/i;
const destinationPattern = /(?:\bto|visit|destination(?: is)?)\s+([A-Z][A-Za-zÀ-ÿ' -]{1,35}?)(?=\s+(?:via|for|from|with|on)\b|[,.!?]|$)/;
const originPattern = /(?:from|leaving(?: from)?|departing(?: from)?)\s+([A-Z][A-Za-zÀ-ÿ' -]{1,35}?)(?=\s+(?:to|via)\b|[,.!?]|$)/;
const travelerPattern = /(\d{1,2})\s+(?:people|persons?|travell?ers?|adults?)/i;
const nonsensePattern = /(ignore (?:all |your |the )?(?:previous )?instructions|system prompt|developer message|reveal (?:a |the )?(?:secret|token|key)|bypass|jailbreak|as an ai|as an language model|api failure|provider (?:is )?down|outage|\b(?:asdf|qwerty|blorp)\b)/i;

function cleanPlace(value: string | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\s+(?:for|from|with|on|between|next|this)\b.*$/i, "")
    .replace(/[,.!?]+$/, "")
    .trim();
}

export function inferContext(
  message: string,
  previous: TripContext,
): TripContext {
  if (nonsensePattern.test(message)) {
    return previous;
  }

  const lower = message.toLowerCase();

  const changingDestination = /(?:change|update) destination to\s+([A-Z][A-Za-zÀ-ÿ' -]{2,35})/i.exec(message);
  const changingOrigin = /(?:change|update) origin to\s+([A-Z][A-Za-zÀ-ÿ' -]{2,35})/i.exec(message);

  let newDestination = previous.destination;
  let newOrigin = previous.origin;

  if (changingDestination) {
    newDestination = cleanPlace(changingDestination[1]);
  } else if (!previous.destination) {
    newDestination = cleanPlace(message.match(destinationPattern)?.[1]);
  }

  if (changingOrigin) {
    newOrigin = cleanPlace(changingOrigin[1]);
  } else if (!previous.origin) {
    newOrigin = cleanPlace(message.match(originPattern)?.[1]);
  }

  const standalonePlace = /^[A-Z][A-Za-zÀ-ÿ' -]{2,35}$/.test(message.trim()) ? message.trim() : null;
  if (!newDestination && standalonePlace) {
    newDestination = standalonePlace;
  } else if (newDestination && !newOrigin && standalonePlace && standalonePlace.toLowerCase() !== newDestination.toLowerCase()) {
    newOrigin = standalonePlace;
  }

  if (newOrigin && newDestination && newOrigin.toLowerCase() === newDestination.toLowerCase()) {
    newOrigin = null;
  }

  const budgetMatch = message.match(currencyPattern);
  const travelersMatch = message.match(travelerPattern);
  const changedDate = /(?:change|update) dates? to\s+(.{3,80})/i.exec(message)?.[1]?.trim();
  const stopoverMatch = /(?:via|stop(?:over)? in|add stopover in)\s+([A-Z][A-Za-zÀ-ÿ' -]{1,35}?)(?=\s+to\b|[,.!?]|$)/i.exec(message);

  let stopovers = previous.stopovers;
  if (/remove (?:the )?stopover|no stopovers?/i.test(message)) stopovers = [];
  else if (stopoverMatch) stopovers = [cleanPlace(stopoverMatch[1])].filter((value): value is string => Boolean(value));

  let sustainabilityPriority = previous.sustainabilityPriority;
  if (/(maximum|strict|lowest|very eco|climate[- ]first|lower[- ](?:impact|carbon)|low[- ]carbon)/i.test(message)) {
    sustainabilityPriority = "climate-first";
  } else if (/(balanced|balance|moderate)/i.test(message)) {
    sustainabilityPriority = "balanced";
  } else if (/(comfort[- ]first|comfort|convenience|fastest)/i.test(message)) {
    sustainabilityPriority = "comfort-first";
  }

  let dateRange = changedDate ?? previous.dateRange;
  const datePhrase = message.match(
    /\b(next (?:week|month|weekend)|this weekend|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[^,.!?]{0,30})/i,
  );
  if (!changedDate && datePhrase) dateRange = datePhrase[1];
  if (!changedDate && /\bdates?\s+(?:are\s+)?flexible\b/i.test(message)) {
    dateRange = "flexible dates";
  }

  const transportPreferences = /(?:rail|train)/i.test(message)
    ? ["rail"]
    : /(?:coach|bus)/i.test(message)
      ? ["coach"]
      : /(?:flight|fly|plane)/i.test(message)
        ? ["flight"]
        : /(?:car|drive)/i.test(message)
          ? ["car"]
          : /(?:transport.*flexible|any transport|no transport preference)/i.test(message)
            ? ["flexible"]
            : previous.transportPreferences;
  const accessibilityNeeds = /(?:step[- ]free|wheelchair|mobility|assistance)/i.test(message)
    ? [message.match(/step[- ]free|wheelchair|mobility assistance|assistance/i)?.[0] ?? "assistance"]
    : /no accessibility|accessibility.*none/i.test(message)
      ? ["none"]
      : previous.accessibilityNeeds;
  const accommodationNeeds = /(?:accessible hotel)/i.test(message)
    ? ["accessible hotel"]
    : /(?:hotel|hostel|apartment|guesthouse)/i.test(message)
      ? [message.match(/hotel|hostel|apartment|guesthouse/i)?.[0].toLowerCase() ?? "hotel"]
      : /no accommodation|accommodation.*none/i.test(message)
        ? ["none"]
        : previous.accommodationNeeds;

  let locationConsentMode = lower.includes("gps") || lower.includes("use my location")
    ? "gps"
    : lower.includes("manual") || lower.includes("enter location")
      ? "manual"
      : lower.includes("skip location") || lower.includes("skipped") || lower.includes("no location")
        ? "skipped"
        : previous.locationConsentMode;
  let currentLocation = previous.currentLocation;
  const changedLocation = /(?:current|approximate) location to\s+([A-Za-zÀ-ÿ' -]{2,80})/i.exec(message)?.[1]?.trim();
  if (changedLocation && locationConsentMode === "manual") currentLocation = changedLocation;
  if (locationConsentMode !== "manual") currentLocation = null;

  const travellerCount = travelersMatch ? Number(travelersMatch[1]) : previous.travellerCount;
  const budget = budgetMatch
    ? budgetMatch[0].toUpperCase()
    : /\bflexible\b/i.test(message) && /budget/i.test(message)
      ? "Flexible"
      : previous.budget;
  const complete = Boolean(
    newDestination && newOrigin && dateRange && travellerCount && budget &&
    transportPreferences.length && accessibilityNeeds.length &&
    sustainabilityPriority && accommodationNeeds.length && locationConsentMode &&
    (locationConsentMode !== "manual" || currentLocation),
  );
  const changed = /\b(?:change|update|remove|wait|no)\b/i.test(message);
  const confirmed = /\b(?:looks good|confirm|yes|proceed|search options)\b/i.test(message);
  const reviewConfirmation = complete && confirmed ? true : changed || !complete ? false : previous.reviewConfirmation;

  return {
    ...previous,
    destination: newDestination,
    origin: newOrigin,
    currentLocation,
    stopovers,
    dateRange,
    budget,
    transportPreferences,
    accessibilityNeeds,
    sustainabilityPriority,
    accommodationNeeds,
    locationConsentMode,
    travellerCount,
    handoverRequested: previous.handoverRequested || /(human|advisor|specialist|agent|complex itinerary)/i.test(message),
    reviewConfirmation
  };
}

export function nextPrompt(context: TripContext): {
  messages: string[];
  quickReplies: string[];
  recommendations: Recommendation[];
  handover: boolean | null;
} {
  if (context.handoverRequested) {
    return {
      messages: ["I can prepare a concise handover for a human travel specialist. I’ll include the trip preferences you shared, but not precise GPS coordinates or other unnecessary personal data."],
      quickReplies: ["Prepare handover", "Keep planning here"],
      recommendations: [],
      handover: true,
    };
  }

  if (!context.destination) {
    return {
      messages: ["Where would you like to go? You can name a destination or choose an example."],
      quickReplies: ["Copenhagen", "Lisbon", "Prague"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.origin) {
    return {
      messages: [`Great — ${context.destination} gives us several possibilities. Where will you travel from?`],
      quickReplies: ["Berlin", "London", "Paris"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.dateRange) {
    return {
      messages: ["When are you planning to travel?"],
      quickReplies: ["This weekend", "Next month", "Dates are flexible"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.travellerCount) {
    return {
      messages: ["How many people are travelling?"],
      quickReplies: ["1 person", "2 people", "4 people"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.budget) {
    return {
      messages: ["What budget should I work within? (Total amount or range)"],
      quickReplies: ["Under €500", "€500–€1,000", "Flexible"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.transportPreferences.length) {
    return {
      messages: ["Which transport modes should I prioritise?"],
      quickReplies: ["Prefer rail", "Prefer coach", "Prefer flights", "No transport preference"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.accessibilityNeeds.length) {
    return {
      messages: ["Do you have accessibility or assistance needs?"],
      quickReplies: ["No accessibility needs", "Step-free access", "Wheelchair access", "Mobility assistance"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.accommodationNeeds.length) {
    return {
      messages: ["What type of accommodation should I consider?"],
      quickReplies: ["Hotel", "Hostel", "Apartment", "No accommodation needed"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.sustainabilityPriority) {
    return {
      messages: ["How should I balance climate impact, cost, and convenience?"],
      quickReplies: ["Climate-first", "Balanced", "Comfort-first"],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.locationConsentMode) {
    return {
      messages: ["Would you like to tailor local transport suggestions using an approximate location? Precise coordinates are not retained."],
      quickReplies: ["Use my location", "Enter location manually", "Skip location"],
      recommendations: [],
      handover: null,
    };
  }
  if (context.locationConsentMode === "manual" && !context.currentLocation) {
    return {
      messages: ["Enter an approximate city or neighbourhood for local suggestions. Do not enter an address or coordinates."],
      quickReplies: [],
      recommendations: [],
      handover: null,
    };
  }
  if (!context.reviewConfirmation) {
    return {
      messages: [
        `Review your plan: ${context.travellerCount} traveller${context.travellerCount === 1 ? "" : "s"} from ${context.origin} to ${context.destination}${context.stopovers.length ? ` via ${context.stopovers.join(", ")}` : ""}, ${context.dateRange}, budget ${context.budget}, transport ${context.transportPreferences.join(", ")}, accessibility ${context.accessibilityNeeds.join(", ")}, accommodation ${context.accommodationNeeds.join(", ")}, and ${context.sustainabilityPriority} priority. Does this look correct?`
      ],
      quickReplies: ["Looks good", "Change something"],
      recommendations: [],
      handover: null,
    };
  }

  return {
    messages: [
      `Here is a transparent first comparison for a ${context.sustainabilityPriority} trip from ${context.origin} to ${context.destination}. Carbon figures are estimates, not guarantees.`
    ],
    quickReplies: ["Show lower-carbon only", "Compare all options", "Talk to an advisor"],
    recommendations: rankRecommendations(context),
    handover: null,
  };
}

function rankRecommendations(context: TripContext): Recommendation[] {
  const carbonWeight =
    context.sustainabilityPriority === "climate-first"
      ? 0.6
      : context.sustainabilityPriority === "comfort-first"
        ? 0.3
        : 0.45;

  return featuredRecommendations
    .map((item) => ({
      ...item,
      score: Math.round(
        item.score * (0.65 + carbonWeight) -
          (item.carbonKg === null ? 0 : Math.min(item.carbonKg / 18, 24) * carbonWeight),
      ),
    }))
    .sort((a, b) => b.score - a.score);
}
