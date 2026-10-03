#!/usr/bin/env python3
"""Warm the private Rasa NLU/Core/form/confirmation path with synthetic data."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta


SENDER_PREFIX = "__internal_rasa_warmup__"
PLANNER_CONTEXT = {
    "origin": "London",
    "destination": "Paris",
    "stopovers": [],
    "travel_dates": f"{date.today() + timedelta(days=14)} to {date.today() + timedelta(days=18)}",
    "travelers": 2,
    "budget": "Under €1,000",
    "transport_preference": "rail",
    "accessibility_need": "none",
    "sustainability_level": "balanced",
    "accommodation_need": "none",
    "activity_preferences": ["cultural"],
    "location_mode": "none",
    "location": None,
    "review_confirmation": None,
}


def request_json(base_url: str, path: str, method: str, payload: dict | None = None) -> object:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Rasa returned HTTP {exc.code} for {path}") from exc
    except (OSError, TimeoutError) as exc:
        raise RuntimeError(f"Rasa request failed for {path}: {type(exc).__name__}") from exc
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"Rasa returned invalid JSON for {path}") from exc


def post_turn(base_url: str, sender: str, message: str, values: dict | None = None) -> object:
    metadata = {"planner_internal_warmup": True}
    if values is not None:
        metadata["planner_slot_values"] = values
    return request_json(
        base_url,
        "/webhooks/rest/webhook",
        "POST",
        {"sender": sender, "message": message, "metadata": metadata},
    )


def text_replies(response: object) -> list[str]:
    return [
        item["text"]
        for item in response
        if isinstance(response, list)
        and isinstance(item, dict)
        and isinstance(item.get("text"), str)
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5005")
    args = parser.parse_args()

    sender = f"{SENDER_PREFIX}{uuid.uuid4().hex}"
    phase = "greeting"
    try:
        # A real NLU turn followed by internal structured turns exercises Core,
        # the requested form slot, the summary/confirmation path, and the final
        # custom action. The internal warm-up marker suppresses optional HTTP
        # provider calls; this synthetic conversation contains no PII.
        greeting = text_replies(post_turn(args.url, sender, "hello"))
        greeting_tracker = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        if (not greeting or greeting_tracker.get("slots", {}).get("requested_slot") != "origin"
                or greeting_tracker.get("active_loop", {}).get("name") != "trip_form"
                or not any(event.get("event") == "action" and event.get("name") == "utter_greet"
                           for event in greeting_tracker.get("events", []))):
            raise RuntimeError("Rasa did not complete the synthetic greeting/Core turn")
        phase = "form"
        post_turn(
            args.url, sender, "/guided_continue", {"origin": "London"}
        )
        tracker = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        slots = tracker.get("slots", {}) if isinstance(tracker, dict) else {}
        if slots.get("origin") != "London" or slots.get("requested_slot") != "destination":
            raise RuntimeError("Rasa did not complete the synthetic form turn")
        phase = "closing during form"
        closing = post_turn(args.url, sender, "/goodbye")
        after_closing = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        if (not closing or not any(
                event.get("event") == "action" and event.get("name") == "utter_goodbye"
                for event in after_closing.get("events", [])[len(tracker.get("events", [])):])
                or after_closing.get("slots") != slots
                or after_closing.get("active_loop", {}).get("name") != "trip_form"):
            raise RuntimeError("Closing acknowledgement changed the pending trip form")
        phase = "form"
        post_turn(args.url, sender, "/guided_continue", PLANNER_CONTEXT)
        tracker = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        slots = tracker.get("slots", {}) if isinstance(tracker, dict) else {}
        if slots.get("requested_slot") != "review_confirmation" or slots.get("travel_dates") != PLANNER_CONTEXT["travel_dates"]:
            raise RuntimeError("Rasa did not complete the synthetic review/form-submission turn")
        phase = "confirmation"
        confirmation = {**PLANNER_CONTEXT, "review_confirmation": True}
        response = post_turn(args.url, sender, "/confirm_review", confirmation)
        if not isinstance(response, list) or not any(
            isinstance(message, dict)
            and isinstance(message.get("custom"), dict)
            and message["custom"].get("type") == "recommendations"
            for message in response
        ):
            raise RuntimeError("Rasa did not complete the internal confirmation action")
        phase = "closing after recommendations"
        before_closing = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        closing = post_turn(args.url, sender, "/goodbye")
        after_closing = request_json(args.url, f"/conversations/{sender}/tracker", "GET")
        if (not closing or not any(
                event.get("event") == "action" and event.get("name") == "utter_goodbye"
                for event in after_closing.get("events", [])[len(before_closing.get("events", [])):])
                or before_closing.get("slots") != after_closing.get("slots")):
            raise RuntimeError("Closing acknowledgement changed the confirmed trip")
    except Exception as exc:
        print(f"Internal Rasa warm-up failed during {phase}: {exc}", file=sys.stderr)
        try:
            post_turn(args.url, sender, "/restart_trip")
        except Exception as cleanup_error:
            print(f"Internal warm-up slot reset failed: {cleanup_error}", file=sys.stderr)
        return 1

    try:
        post_turn(args.url, sender, "/restart_trip")
    except Exception as exc:
        print(f"Internal warm-up slot reset failed: {exc}", file=sys.stderr)
        return 1

    print("Private synthetic Rasa NLU/Core/form/closing/confirmation warm-up passed; no user-visible latency was measured.")
    return 0


if __name__ == "__main__":
    sys.exit(main())