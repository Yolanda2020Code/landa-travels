import assert from "node:assert/strict";
import test from "node:test";
import type { Recommendation } from "@workspace/api-zod";
import { emptyTripContext } from "./eco-travel";
import { createRecommendationSnapshot } from "./advisor-handover";
import { plannerFollowupReply, typedPlannerEditPayload } from "./planner-followups";

const context = { ...emptyTripContext, origin: "Berlin", destination: "Paris", travellerCount: 2, reviewConfirmation: true };
const option = (name: string, price: string, type: Recommendation["type"] = "transport"): Recommendation => ({
  id: name, name, price, type, location: "Paris", description: "Displayed indicative component",
  carbonKg: 20, carbonLabel: "low", score: 80, certification: null, source: "Illustrative estimate",
  verifiedAt: "2026-10-02T07:00:00Z", tags: ["illustrative estimate"],
});
const snapshot = (options: Recommendation[]) => createRecommendationSnapshot(options, "demo", "2026-10-02T07:00:00Z", context);

test("cheapest compares party prices and excludes unrelated categories and unknown prices", () => {
  const reply = plannerFollowupReply("What is the cheapest", context, snapshot([
    option("Rail", "€80 per traveller"), option("Coach", "€100 total for your party"),
    option("Unknown flight", "Not available — check provider"), option("Museum", "€5", "experience"),
  ]))!;
  assert.match(reply, /Coach/);
  assert.doesNotMatch(reply, /Rail|Unknown flight|Museum/);
  assert.match(reply, /No new search/);
});

test("different currencies and units are never silently converted or pooled", () => {
  const reply = plannerFollowupReply("Which hotel is cheapest?", context, snapshot([
    option("EUR room", "€100 per night", "stay"), option("USD room", "$50 per night", "stay"),
    option("Full stay", "€400 total", "stay"),
  ]))!;
  assert.match(reply, /EUR · per night/);
  assert.match(reply, /USD · per night/);
  assert.match(reply, /EUR · stated component price/);
});

test("ranges and unavailable numeric prices cannot win as cheap or free", () => {
  const reply = plannerFollowupReply("What is the cheapest?", context, snapshot([
    option("Range", "€10–100"), option("Unknown", "EUR 0 unavailable"), option("From", "From €10"),
  ]))!;
  assert.match(reply, /can't identify the cheapest reliably/);
});

test("stale or unconfirmed options are not compared", () => {
  const old = snapshot([option("Old coach", "€40")]);
  assert.match(plannerFollowupReply("What is cheapest?", { ...context, destination: "Rome" }, old)!, /don't have current confirmed/);
  assert.match(plannerFollowupReply("What is cheapest?", { ...context, reviewConfirmation: false }, old)!, /confirm your details first/);
});

test("guided help is an explanation, not a trip mutation", () => {
  assert.match(plannerFollowupReply("What guided", context, null)!, /one trip question at a time/);
  assert.match(plannerFollowupReply("How does guided input work?", context, null)!, /one trip question at a time/);
  assert.equal(plannerFollowupReply("change to the cheapest flight", context, null), null);
  assert.equal(plannerFollowupReply("Hello", context, null), null);
});

test("typed edits use the same structured slot reset as the UI and require fresh confirmation", () => {
  assert.equal(typedPlannerEditPayload("Change activities"), '__planner_edit__:{"activity_preferences":null,"review_confirmation":null}');
  assert.equal(typedPlannerEditPayload("Change dates"), '__planner_edit__:{"travel_dates":null,"review_confirmation":null}');
  assert.equal(typedPlannerEditPayload("Change activities to outdoor walks"), undefined);
  assert.equal(typedPlannerEditPayload("I want to come from"), '__planner_edit__:{"origin":null,"review_confirmation":null}');
  assert.equal(typedPlannerEditPayload("Change departure"), '__planner_edit__:{"origin":null,"review_confirmation":null}');
  assert.equal(typedPlannerEditPayload("Correct destination"), '__planner_edit__:{"destination":null,"review_confirmation":null}');
  assert.equal(typedPlannerEditPayload("I want to come from England"), undefined);
});