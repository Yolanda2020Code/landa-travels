import type { Recommendation, TripContext } from "@workspace/api-zod";

type Money = { currency: "EUR" | "GBP" | "USD"; amount: number };

function currency(code: string): Money["currency"] | null {
  if (/€|EUR/i.test(code)) return "EUR";
  if (/£|GBP/i.test(code)) return "GBP";
  if (/\$|USD/i.test(code)) return "USD";
  return null;
}

function amount(value: string): number | null {
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
  return match ? Number(match[0]) : null;
}

function quotedPrice(value: string): Money | null {
  const unit = currency(value);
  const price = amount(value);
  return unit && price !== null && Number.isFinite(price) ? { currency: unit, amount: price } : null;
}

function groupCost(item: Recommendation, context: TripContext): Money | null {
  const quote = quotedPrice(item.price);
  if (!quote) return null;
  return {
    ...quote,
    amount: quote.amount * (
      item.type === "transport" && /per traveller/i.test(item.price)
        ? Math.max(1, context.travellerCount ?? 1) : 1
    ),
  };
}

function budgetCeiling(value: string | null): Money | null {
  if (!value || /flexible/i.test(value)) return null;
  const unit = currency(value);
  const values = [...value.replace(/,/g, "").matchAll(/\d+(?:\.\d{1,2})?/g)].map((part) => Number(part[0]));
  const ceiling = values.length > 1 ? Math.max(...values) : values[0];
  return unit && Number.isFinite(ceiling) && ceiling > 0 ? { currency: unit, amount: ceiling } : null;
}

function preferenceMatch(item: Recommendation, context: TripContext): number {
  const preferences = context.transportPreferences.map((value) => value.toLowerCase());
  if (item.type === "transport") {
    if (!preferences.length || preferences.some((value) => /flexible|any|no preference/.test(value))) return 0.5;
    const match = preferences.some((value) => (
      (/rail|train/.test(value) && /rail|train/.test(item.name)) ||
      (/coach|bus/.test(value) && /coach|bus/.test(item.name)) ||
      (/flight|fly|plane/.test(value) && /flight|airline|airways|air /.test(`${item.name} ${item.tags.join(" ")}`))
    ));
    return match ? 1 : 0.15;
  }
  if (item.type === "stay") {
    const needs = context.accommodationNeeds.join(" ").toLowerCase();
    return /none|not needed|no accommodation/.test(needs) ? 0 : 0.6;
  }
  return 0.5;
}

function convenienceScore(item: Recommendation, group: Recommendation[]): number {
  const durations = group.map((candidate) => candidate.durationMinutes)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const duration = item.durationMinutes;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const timeScore = typeof duration === "number" && Number.isFinite(duration) && duration > 0 && max > min
    ? Math.max(0, Math.min(1, (max - duration) / (max - min))) : 0.5;
  const changes = item.connectionCount;
  const connectionScore = typeof changes === "number" && Number.isInteger(changes) && changes >= 0
    ? 1 / (1 + changes) : 0.5;
  return timeScore * 0.7 + connectionScore * 0.3;
}

/** Scores are comparative within a category, never a claim that a full trip fits its budget.
 * In particular, a quote in a different currency cannot be compared without a live FX rate.
 */
export function rankTripRecommendations(items: Recommendation[], context: TripContext): Recommendation[] {
  const priority = context.sustainabilityPriority;
  const weights = priority === "climate-first" ? [0.6, 0.2, 0.1, 0.1]
    : priority === "comfort-first" ? [0.3, 0.2, 0.15, 0.35] : [0.45, 0.3, 0.1, 0.15];
  const ceiling = budgetCeiling(context.budget);
  const byType = (type: Recommendation["type"]) => items.filter((item) => item.type === type);
  const score = (item: Recommendation, group: Recommendation[]) => {
    const carbons = group.map((candidate) => candidate.carbonKg)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const minCarbon = Math.min(...carbons);
    const maxCarbon = Math.max(...carbons);
    const carbonScore = typeof item.carbonKg !== "number" || carbons.length === 0 || maxCarbon === minCarbon
      ? 0.5
      : (maxCarbon - item.carbonKg) / (maxCarbon - minCarbon);
    const price = groupCost(item, context);
    const prices = price
      ? group.map((candidate) => groupCost(candidate, context))
        .filter((candidate): candidate is Money => candidate?.currency === price.currency)
        .map((candidate) => candidate.amount)
      : [];
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceScore = price && prices.length > 1 && maxPrice !== minPrice
      ? (maxPrice - price.amount) / (maxPrice - minPrice) : 0.5;
    const exceedsBudget = price && ceiling && price.currency === ceiling.currency && price.amount > ceiling.amount;
    const weighted = carbonScore * weights[0] + priceScore * weights[1]
      + preferenceMatch(item, context) * weights[2] + convenienceScore(item, group) * weights[3];
    return Math.round(Math.max(0, Math.min(100, weighted * 100 * (exceedsBudget ? 0.35 : 1))));
  };
  return items.map((item) => ({
    ...item,
    score: score(item, byType(item.type)),
    rankingExplanation: `${priority ?? "balanced"} comparison: carbon ${Math.round(weights[0] * 100)}%, quoted price ${Math.round(weights[1] * 100)}%, preference ${Math.round(weights[2] * 100)}%, convenience ${Math.round(weights[3] * 100)}%. `
      + (typeof item.durationMinutes === "number"
        ? `Provider journey time ${Math.round(item.durationMinutes)} minutes${typeof item.connectionCount === "number" ? `, ${item.connectionCount} connections` : "; connections unknown"}; excludes door-to-door travel. `
        : "Journey time unknown; no speed or accessibility advantage assumed. ")
      + (groupCost(item, context) ? "Quoted component price, not the total itinerary cost."
        : "Price unknown; not treated as free."),
  }))
    .sort((a, b) => b.score - a.score);
}