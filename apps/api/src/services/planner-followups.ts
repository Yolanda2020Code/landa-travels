import type { TripContext } from "@workspace/api-zod";
import { recommendationSnapshotMatchesContext, type RecommendationSnapshot } from "./advisor-handover";

export function typedPlannerEditPayload(message: string): string | undefined {
  if (/^(?:i\s+(?:want|would like)\s+to\s+)?(?:come|travel|leave|depart|start)\s+from[.!?]?$/i.test(message.trim())) {
    return '__planner_edit__:{"origin":null,"review_confirmation":null}';
  }
  const match = message.trim().match(/^(?:please\s+)?(?:change|edit|update|correct)\s+(?:my\s+|the\s+)?(origin|departure|destination|activities|activity preferences|budget|dates|travel dates|travellers|travelers|transport|accommodation|accessibility|sustainability)[.!?]?$/i);
  if (!match) return undefined;
  const slots: Record<string, string> = {
    origin: "origin", departure: "origin", destination: "destination",
    activities: "activity_preferences", "activity preferences": "activity_preferences",
    budget: "budget", dates: "travel_dates", "travel dates": "travel_dates",
    travellers: "travelers", travelers: "travelers", transport: "transport_preference",
    accommodation: "accommodation_need", accessibility: "accessibility_need",
    sustainability: "sustainability_level",
  };
  return `__planner_edit__:${JSON.stringify({ [slots[match[1].toLowerCase()]]: null, review_confirmation: null })}`;
}

/** Answer only from the displayed, context-matched snapshot; never fetch new offers. */
export function plannerFollowupReply(
  message: string, context: TripContext, snapshot: RecommendationSnapshot | null,
): string | null {
  const text = message.trim();
  if (/^(?:what(?:'s| is)?\s+guided(?: planning| input)?|what does guided(?: planning| input)? mean|how does guided(?: planning| input)? work|help(?: me)?)[.!?]?$/i.test(text)) {
    return "Guided planning means answering one trip question at a time using the choices below. You can also type your answers. Choose Continue guided planning to resume, or type Change activities, Change dates, or Change budget to edit that detail. Your other trip choices stay unchanged.";
  }
  if (!/\b(?:cheapest|least expensive|lowest price|most affordable)\b/i.test(text) ||
      /^(?:change|edit|update|set|switch|remove|cancel|restart)\b/i.test(text)) return null;
  if (!snapshot || !context.reviewConfirmation || !recommendationSnapshotMatchesContext(snapshot, context)) {
    return "I don't have current confirmed options to compare for this trip. Continue guided planning and confirm your details first; I won't guess a price or start another search from this question.";
  }
  const category = /\b(?:hotel|stay|accommodation)\b/i.test(text) ? "stay"
    : /\b(?:activity|activities|experience)\b/i.test(text) ? "experience" : "transport";
  const groups = new Map<string, Array<{ name: string; price: string; amount: number }>>();
  for (const option of snapshot.recommendations.filter((item) => item.type === category)) {
    // Accept one stated monetary amount, not ranges, "from" prices, or unknown prices.
    if (/not available|unavailable|unknown|check (?:the )?provider|\bfrom\b/i.test(option.price)) continue;
    const match = option.price.match(/^(EUR|GBP|USD|€|£|\$)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.,])/i);
    if (!match || /^\s*(?:[-–—]|\bto\b)/i.test(option.price.slice(match[0].length))) continue;
    const symbols: Record<string, string> = { "€": "EUR", "£": "GBP", "$": "USD" };
    const currency = symbols[match[1]] ?? match[1].toUpperCase();
    const perTraveller = /per (?:traveller|traveler|person)/i.test(option.price);
    const basis = /per night/i.test(option.price) ? "per night" : category === "transport" ? "for your party" : perTraveller ? "per person" : "stated component price";
    const amount = Number(match[2].replace(/,/g, "")) *
      (category === "transport" && perTraveller ? Math.max(1, context.travellerCount ?? 1) : 1);
    const key = `${currency} · ${basis}`;
    const group = groups.get(key) ?? [];
    group.push({ name: option.name, price: option.price, amount });
    groups.set(key, group);
  }
  if (!groups.size) return `The displayed ${category} options don't have comparable stated prices. Unknown prices are not free, so I can't identify the cheapest reliably. No new search has been started.`;
  const answers = [...groups].map(([basis, options]) => {
    const minimum = Math.min(...options.map((item) => item.amount));
    const winners = options.filter((item) => item.amount === minimum);
    return `${basis}: ${winners.map((item) => `${item.name} (${item.price})`).join("; ")}${winners.length > 1 ? " — tied" : ""}.`;
  });
  return `Among the priced ${category} options already displayed, the lowest stated prices are:\n${answers.join("\n")}\nCurrencies and pricing units are compared separately; unknown prices are excluded. These are displayed component prices, not the full trip cost or a booking guarantee, and may be indicative or test offers. Snapshot: ${snapshot.confirmedAt}. No new search has been started.`;
}