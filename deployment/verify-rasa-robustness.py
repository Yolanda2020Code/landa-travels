#!/usr/bin/env python3
"""Verify synthetic planner journeys through the real development HTTP API."""
import argparse
import json
import time
import uuid
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


EMPTY = dict(origin=None, destination=None, currentLocation=None, stopovers=[],
             dateRange=None, travellerCount=None, budget=None, transportPreferences=[],
             accessibilityNeeds=[], sustainabilityPriority=None, accommodationNeeds=[],
             activityPreferences=[], locationConsentMode=None, reviewConfirmation=None,
             handoverRequested=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Refusing to overwrite existing evidence")
    records = []
    checks = []

    def check(label, condition):
        checks.append({"check": label, "passed": bool(condition)})
        if not condition:
            raise AssertionError(label)

    def turn(session, context, message, payload=None):
        body = {"sessionId": session, "context": context, "message": message}
        if payload:
            body["payload"] = payload
        request = urllib.request.Request(args.url.rstrip("/") + "/api/assistant/message",
                                        data=json.dumps(body).encode(),
                                        headers={"Content-Type": "application/json"})
        started = time.monotonic()
        with urllib.request.urlopen(request, timeout=25) as response:
            result = json.load(response)
            status = response.status
        records.append({"message": message, "payload": payload, "status": status,
                        "recommendation_data_source": result.get("source"),
                        "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
                        "context": result["context"], "messages": result["messages"],
                        "recommendation_count": len(result["recommendations"])})
        # source describes recommendation provenance, not the dialogue engine.
        # Ordinary intake can correctly report demo while real Rasa handles it.
        check("HTTP 200 and a structured conversational response",
              status == 200 and isinstance(result.get("context"), dict)
              and bool(result.get("messages")))
        return result

    start, end = date.today() + timedelta(days=14), date.today() + timedelta(days=18)
    expected_dates = f"{start} to {end}"
    try:
        typed_session = "synthetic-robustness-typed-" + str(uuid.uuid4())
        result = turn(typed_session, EMPTY,
                      f"Travel from Newcastle upon Tyne via Leeds and York to Cambridge "
                      f"for three adults and one child from {start.strftime('%d %B %Y')} "
                      f"to {end.strftime('%d %B %Y')}, budget two thousand euros.")
        ctx = result["context"]
        check("typed multiword origin and destination", ctx["origin"] == "Newcastle upon Tyne" and ctx["destination"] == "Cambridge")
        check("two explicit stopovers", ctx["stopovers"] == ["Leeds", "York"])
        check("written composition, dates and currency", ctx["travellerCount"] == 4 and
              ctx["dateRange"] == expected_dates and ctx["budget"] == "EUR 2000")
        result = turn(typed_session, ctx, "Actually, change my destination to Bristol instead.")
        changed = result["context"]
        check("typed correction preserves remaining trip facts",
              changed["destination"] == "Bristol" and
              all(changed[key] == ctx[key] for key in ["origin", "stopovers", "dateRange", "travellerCount", "budget"]))

        bare_session = "synthetic-robustness-bare-" + str(uuid.uuid4())
        result = turn(bare_session, EMPTY, "Plan a trip", "/plan_trip")
        check("form starts without false validation errors",
              len(result["messages"]) == 1 and "travel from" in result["messages"][0])
        result = turn(bare_session, result["context"], "Graz")
        check("unseen bare origin is assigned to the active requested role",
              result["context"]["origin"] == "Graz" and result["context"]["destination"] is None)
        result = turn(bare_session, result["context"], "Toulouse")
        check("bare destination does not overwrite origin",
              result["context"]["origin"] == "Graz" and result["context"]["destination"] == "Toulouse")

        guided_session = "synthetic-robustness-guided-" + str(uuid.uuid4())
        result = turn(guided_session, EMPTY, "Plan a trip", "/plan_trip")
        for values in [
            {"origin": "Berlin"}, {"destination": "Paris"},
            {"travel_dates": expected_dates}, {"travelers": 2}, {"budget": "EUR 2000"},
            {"transport_preference": "rail"}, {"accessibility_need": "none"},
            {"sustainability_level": "balanced"}, {"accommodation_need": "eco hotel"},
            {"activity_preferences": ["cultural"]}, {"location_mode": "manual"},
            {"location": "Berlin"},
        ]:
            result = turn(guided_session, result["context"], "Selected planner details",
                          "/guided_slot" + json.dumps(values))
        ctx = result["context"]
        check("guided fields and manual location retained",
              ctx["origin"] == "Berlin" and ctx["destination"] == "Paris" and
              ctx["dateRange"] == expected_dates and ctx["travellerCount"] == 2 and
              ctx["budget"] == "EUR 2000" and ctx["transportPreferences"] == ["rail"] and
              ctx["activityPreferences"] == ["cultural"] and
              ctx["locationConsentMode"] == "manual" and ctx["currentLocation"] == "Berlin")
        result = turn(guided_session, ctx, "Confirm details",
                      '/guided_slot{"review_confirmation":true}')
        result = turn(guided_session, result["context"], "Confirm these trip details and show my best options.",
                      "/confirm_review")
        check("explicit confirmation produces recommendations",
              result["context"]["reviewConfirmation"] is True and bool(result["recommendations"]))
    finally:
        output = {"synthetic": True, "measured_at_utc": datetime.now(timezone.utc).isoformat(),
                  "records": records, "checks": checks,
                  "all_assertions_passed": bool(checks) and all(c["passed"] for c in checks)}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({"requests": len(records), "checks": len(checks),
                      "max_elapsed_ms": max(r["elapsed_ms"] for r in records),
                      "all_assertions_passed": output["all_assertions_passed"]}))


if __name__ == "__main__":
    main()