#!/usr/bin/env python3
"""Check closing acknowledgements against the real API using synthetic trips."""
import argparse
import json
import time
import uuid
import urllib.request
from datetime import date, timedelta
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Refusing to overwrite existing evidence")
    empty = dict(origin=None, destination=None, currentLocation=None, stopovers=[],
                 dateRange=None, travellerCount=None, budget=None, transportPreferences=[],
                 accessibilityNeeds=[], sustainabilityPriority=None, accommodationNeeds=[],
                 activityPreferences=[], locationConsentMode=None, reviewConfirmation=None,
                 handoverRequested=False)
    records = []
    passed = False

    def turn(session, context, message, payload=None):
        body = dict(sessionId=session, context=context, message=message)
        if payload:
            body["payload"] = payload
        request = urllib.request.Request(
            args.url.rstrip("/") + "/api/assistant/message",
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        started = time.monotonic()
        with urllib.request.urlopen(request, timeout=25) as response:
            result = json.load(response)
            assert response.status == 200
        records.append(dict(message=message, context=result["context"],
                            messages=result["messages"],
                            recommendation_count=len(result["recommendations"]),
                            elapsed_ms=round((time.monotonic() - started) * 1000, 1)))
        return result

    def closing(session, context, text):
        result = turn(session, context, text)
        assert result["context"] == context, "Closing changed the trip"
        assert any("You're welcome!" in message for message in result["messages"]), "No acknowledgement"
        assert not result["recommendations"], "Closing started another search"
        return result

    try:
        partial = "synthetic-closing-form-" + str(uuid.uuid4())
        result = turn(partial, empty, "Start planning", "/plan_trip")
        result = turn(partial, result["context"], "Berlin", '/guided_slot{"origin":"Berlin"}')
        closing(partial, result["context"], "Thank you")
        closing(partial, result["context"], "Thank you I am done")
        result = turn(partial, result["context"], "Paris", '/guided_slot{"destination":"Paris"}')
        assert result["context"]["origin"] == "Berlin" and result["context"]["destination"] == "Paris"
        assert any(reply["payload"] == "__planner_slot__:travel_dates" for reply in result["quickReplies"])

        full = {**empty, "origin": "Berlin", "destination": "Paris",
                "dateRange": f"{date.today() + timedelta(days=14)} to {date.today() + timedelta(days=18)}",
                "travellerCount": 1, "budget": "EUR 2000", "transportPreferences": ["coach"],
                "accessibilityNeeds": ["none"], "sustainabilityPriority": "balanced",
                "accommodationNeeds": ["eco-hotel"], "activityPreferences": ["cultural"],
                "locationConsentMode": "skipped"}
        completed = "synthetic-closing-completed-" + str(uuid.uuid4())
        result = turn(completed, full, "Review trip", "__planner_guided_continue__")
        result = turn(completed, result["context"], "Confirm details", "/confirm_review")
        assert result["context"]["reviewConfirmation"] is True and result["recommendations"]
        closing(completed, result["context"], "Thank you")
        closing(completed, result["context"], "Thank you I am done")
        for text in ["What is the cheapest", "What guided"]:
            followup = turn(completed, result["context"], text)
            assert followup["context"] == result["context"], "Follow-up changed trip details"
            assert not followup["recommendations"], "Follow-up launched another search"
            assert any(
                ("lowest stated prices" in message or "comparable stated prices" in message)
                if "cheapest" in text else "one trip question at a time" in message
                for message in followup["messages"]
            ), "Follow-up did not answer the question"
        restored = "synthetic-closing-restored-" + str(uuid.uuid4())
        closing(restored, result["context"], "Thank you I am done")
        edited = turn(completed, result["context"], "Change activities")
        assert edited["context"]["reviewConfirmation"] is None
        assert edited["context"]["activityPreferences"] == []
        assert all(edited["context"][key] == result["context"][key] for key in result["context"]
                   if key not in {"reviewConfirmation", "activityPreferences"})
        assert any(reply["payload"] == "__planner_slot__:activity_preferences" for reply in edited["quickReplies"])
        selected = turn(completed, edited["context"], "Outdoor activities",
                        '/guided_slot{"activity_preferences":["outdoor"]}')
        assert selected["context"]["activityPreferences"] == ["outdoor"]
        passed = True
    finally:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(dict(synthetic=True, all_assertions_passed=passed,
                                           records=records), indent=2) + "\n")
    print(json.dumps(dict(requests=len(records), all_assertions_passed=passed)))


if __name__ == "__main__":
    main()