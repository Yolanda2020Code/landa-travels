#!/usr/bin/env python3
"""Capture first-request, warm, and bounded-concurrency HTTP timings as raw JSON."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import platform
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


def percentile(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def empty_trip_context() -> dict[str, Any]:
    return {
        "origin": None,
        "destination": None,
        "currentLocation": None,
        "stopovers": [],
        "dateRange": None,
        "travellerCount": None,
        "budget": None,
        "transportPreferences": [],
        "accessibilityNeeds": [],
        "sustainabilityPriority": None,
        "accommodationNeeds": [],
        "locationConsentMode": None,
        "reviewConfirmation": None,
        "handoverRequested": False,
    }


def trip_metadata() -> dict[str, Any]:
    start = date.today() + timedelta(days=90)
    end = start + timedelta(days=3)
    return {
        "origin": "London (LON)",
        "destination": "Paris (PAR)",
        "date_range": f"{start.isoformat()} to {end.isoformat()}",
        "travellers": 2,
        "budget": "Under €1,000",
        "transport": "rail",
        "accommodation": "eco-hotel",
        "accessibility": "none",
        "sustainability": "balanced",
        "activity": "cultural",
        "location_mode": "manual",
        "approximate_city": "London (LON)",
        "provider_mode": "live only if authorized provider credentials are configured",
    }


def assistant_payload(session_id: str, scenario: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    payload = {
        "sessionId": session_id,
        "message": "Hello" if scenario == "confirmed-trip" else "hello",
        "context": empty_trip_context(),
    }
    if scenario == "confirmed-trip":
        payload["payload"] = "__planner_greet__"
    return payload, trip_metadata() if scenario == "confirmed-trip" else None


def response_metadata(decoded: Any) -> dict[str, Any] | None:
    if not isinstance(decoded, dict) or not isinstance(decoded.get("messages"), list):
        return None
    recommendations = decoded.get("recommendations")
    return {
        "source": decoded.get("source"),
        "message_count": len(decoded["messages"]),
        "recommendation_count": len(recommendations)
        if isinstance(recommendations, list)
        else None,
    }


def assistant_call(
    base_url: str,
    timeout: float,
    session_id: str,
    message: str,
    context: dict[str, Any],
    payload: str | None = None,
) -> dict[str, Any]:
    body_data = {
        "sessionId": session_id,
        "message": message,
        "context": context,
    }
    if payload is not None:
        body_data["payload"] = payload
    body = json.dumps(body_data).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/api/assistant/message",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Conversation-Session": session_id,
            "User-Agent": "landa-travels-latency-benchmark/1.0",
        },
        method="POST",
    )
    status: int | None = None
    response_bytes = 0
    decoded: Any = None
    error: str | None = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status = response.status
            response_body = response.read()
            response_bytes = len(response_body)
            decoded = json.loads(response_body)
    except json.JSONDecodeError:
        error = "InvalidJSONResponse"
    except urllib.error.HTTPError as exc:
        status = exc.code
        error = f"HTTPError:{exc.code}"
        exc.close()
    except (OSError, TimeoutError) as exc:
        error = type(exc).__name__
    if status is not None and not 200 <= status < 300:
        error = error or f"HTTPError:{status}"
    metadata = response_metadata(decoded)
    if error is None and metadata is None:
        error = "InvalidAssistantResponse"
    return {
        "status": status,
        "response_bytes": response_bytes,
        "error": error,
        "decoded": decoded,
        "response_metadata": metadata,
    }


def requested_slot(decoded: Any) -> str | None:
    if not isinstance(decoded, dict):
        return None
    replies = decoded.get("quickReplies")
    if not isinstance(replies, list):
        return None
    marker = next(
        (
            reply.get("payload")
            for reply in replies
            if isinstance(reply, dict)
            and isinstance(reply.get("payload"), str)
            and reply["payload"].startswith("__planner_slot__:")
        ),
        None,
    )
    return marker.removeprefix("__planner_slot__:") if marker else None


def prepare_confirmed_conversation(
    base_url: str, timeout: float, session_id: str
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str | None]:
    """Use the same greeting, structured guided-slot turns, and evolving
    returned context as the rendered planner. Preparation calls are not timed.
    """
    first_payload, _ = assistant_payload(session_id, "confirmed-trip")
    result = assistant_call(
        base_url,
        timeout,
        session_id,
        first_payload["message"],
        first_payload["context"],
        first_payload["payload"],
    )
    preparation: list[dict[str, Any]] = []

    def keep_turn(stage: str, response: dict[str, Any], expected_slot: str | None = None) -> None:
        preparation.append(
            {
                "stage": stage,
                "timing_included_in_benchmark": False,
                "status": response["status"],
                "ok": response["error"] is None,
                "error": response["error"],
                "response_bytes": response["response_bytes"],
                "response_metadata": response["response_metadata"],
                "requested_slot": requested_slot(response["decoded"]),
                "expected_slot": expected_slot,
            }
        )

    keep_turn("greeting", result)
    if result["error"] is not None:
        return None, preparation, f"greeting:{result['error']}"
    context = result["decoded"].get("context")
    if not isinstance(context, dict):
        return None, preparation, "greeting:MissingContext"
    slot = requested_slot(result["decoded"])

    date_range = trip_metadata()["date_range"]
    guided_values: dict[str, tuple[str, Any, str, Any]] = {
        "origin": ("origin", "London (LON)", "My origin is London (LON).", "London (LON)"),
        "destination": ("destination", "Paris (PAR)", "My destination is Paris (PAR).", "Paris (PAR)"),
        "travel_dates": ("dateRange", date_range, f"My travel dates are {date_range}.", date_range),
        "travelers": ("travellerCount", 2, "There are 2 travellers.", 2),
        "budget": ("budget", "Under €1,000", "My budget is Under €1,000.", "Under €1,000"),
        "transport_preference": ("transportPreferences", ["rail"], "For transport, I prefer: rail.", "rail"),
        "accessibility_need": ("accessibilityNeeds", ["none"], "My accessibility need is none.", "none"),
        "sustainability_level": ("sustainabilityPriority", "balanced", "My sustainability priority is balanced.", "balanced"),
        "accommodation_need": ("accommodationNeeds", ["eco-hotel"], "For accommodation, I prefer: eco-hotel.", "eco-hotel"),
        "activity_preferences": ("activityPreferences", ["cultural"], "I would enjoy cultural activities.", ["cultural"]),
        "location_mode": ("locationConsentMode", "manual", "Enter an approximate city.", "manual"),
        "location": ("currentLocation", "London (LON)", "My approximate city is London (LON).", "London (LON)"),
    }

    for _ in range(len(guided_values) + 2):
        if slot == "review_confirmation":
            return context, preparation, None
        if slot not in guided_values:
            return None, preparation, f"guided_turn:UnexpectedRequestedSlot:{slot or 'none'}"
        context_key, context_value, message, slot_value = guided_values[slot]
        next_context = dict(context)
        next_context[context_key] = context_value
        if slot == "location_mode":
            next_context["currentLocation"] = None
        if slot == "activity_preferences":
            next_context["activityPreferences"] = ["cultural"]
        payload = "/guided_slot" + json.dumps(
            {slot: slot_value}, ensure_ascii=False, separators=(",", ":")
        )
        result = assistant_call(
            base_url, timeout, session_id, message, next_context, payload
        )
        keep_turn(f"guided:{slot}", result, slot)
        if result["error"] is not None:
            return None, preparation, f"guided:{slot}:{result['error']}"
        returned_context = result["decoded"].get("context")
        if not isinstance(returned_context, dict):
            return None, preparation, f"guided:{slot}:MissingContext"
        context = returned_context
        slot = requested_slot(result["decoded"])

    return None, preparation, "guided_turn:DidNotReachReviewConfirmation"


def prepare_sample(
    base_url: str, timeout: float, scenario: str
) -> dict[str, Any]:
    session_id = f"latency-benchmark-{uuid.uuid4()}"
    if scenario == "confirmed-trip":
        context, preparation, preparation_error = prepare_confirmed_conversation(
            base_url, timeout, session_id
        )
    else:
        context = empty_trip_context()
        preparation = []
        preparation_error = None
    return {
        "session_id": session_id,
        "context": context,
        "preparation_turns": preparation,
        "preparation_error": preparation_error,
    }


def one_request(
    base_url: str,
    timeout: float,
    label: str,
    scenario: str,
    prepared_sample: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sample = prepared_sample or prepare_sample(base_url, timeout, scenario)
    session_id = sample["session_id"]
    preparation = sample["preparation_turns"]
    if scenario == "confirmed-trip":
        context = sample["context"]
        if sample["preparation_error"] is not None or context is None:
            return {
                "phase": label,
                "elapsed_ms": None,
                "status": None,
                "ok": False,
                "response_bytes": 0,
                "error": "PreparationFailed",
                "preparation_error": sample["preparation_error"] or "MissingConfirmedContext",
                "preparation_turn_count": len(preparation),
                "preparation_turns": preparation,
                "response_metadata": None,
            }
        message = "Confirm and compare options"
        payload = "/confirm_review"
    else:
        initial_payload, _ = assistant_payload(session_id, scenario)
        context = initial_payload["context"]
        message = initial_payload["message"]
        payload = initial_payload.get("payload")

    started = time.perf_counter()
    response = assistant_call(
        base_url, timeout, session_id, message, context, payload
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    metadata = response["response_metadata"]
    error = response["error"]
    if (
        scenario == "confirmed-trip"
        and error is None
        and (
            metadata is None
            or not isinstance(metadata["recommendation_count"], int)
            or metadata["recommendation_count"] < 1
        )
    ):
        error = "NoRecommendations"
    record = {
        "phase": label,
        "elapsed_ms": round(elapsed_ms, 3),
        "status": response["status"],
        "ok": response["status"] is not None
        and 200 <= response["status"] < 300
        and error is None,
        "response_bytes": response["response_bytes"],
        "error": error,
        "response_metadata": metadata,
    }
    if scenario == "confirmed-trip":
        record["preparation_turn_count"] = len(preparation)
        record["preparation_turns"] = preparation
    return record


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    timings = [
        float(item["elapsed_ms"])
        for item in records
        if item.get("elapsed_ms") is not None
    ]
    status_counts: dict[str, int] = {}
    for item in records:
        key = str(item["status"]) if item["status"] is not None else "no-response"
        status_counts[key] = status_counts.get(key, 0) + 1
    source_counts: dict[str, int] = {}
    for item in records:
        metadata = item.get("response_metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("source"), str):
            source = metadata["source"]
            source_counts[source] = source_counts.get(source, 0) + 1
    return {
        "attempts": len(records),
        "timed_attempts": len(timings),
        "successful_2xx": sum(bool(item["ok"]) for item in records),
        "failed": sum(not bool(item["ok"]) for item in records),
        "preparation_failures": sum(
            item.get("error") == "PreparationFailed" for item in records
        ),
        "http_status_counts": status_counts,
        "assistant_source_counts": source_counts,
        "min_ms": round(min(timings), 3) if timings else None,
        "mean_ms": round(statistics.fmean(timings), 3) if timings else None,
        "p50_ms": round(percentile(timings, 0.50), 3) if timings else None,
        "p95_ms": round(percentile(timings, 0.95), 3) if timings else None,
        "p99_ms": round(percentile(timings, 0.99), 3) if timings else None,
        "max_ms": round(max(timings), 3) if timings else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="Public base URL, e.g. https://example.hf.space")
    parser.add_argument(
        "--scenario",
        choices=("greeting", "confirmed-trip"),
        default="greeting",
        help="Synthetic API greeting, or a guided multi-turn trip followed by review confirmation",
    )
    parser.add_argument("--warm-requests", type=int, default=None)
    parser.add_argument("--concurrent-requests", type=int, default=None)
    parser.add_argument("--concurrency", type=int, default=None)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--model-revision", default=None, help="Optional Space commit/model release label")
    parser.add_argument("--out", type=Path, required=True, help="New JSON output path; existing files are not overwritten")
    args = parser.parse_args()

    parsed = urlsplit(args.base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        parser.error("base_url must be an HTTP(S) origin/path without credentials, query, or fragment")
    defaults = (1, 1, 1) if args.scenario == "confirmed-trip" else (20, 20, 5)
    warm_requests = args.warm_requests if args.warm_requests is not None else defaults[0]
    concurrent_requests = (
        args.concurrent_requests if args.concurrent_requests is not None else defaults[1]
    )
    requested_concurrency = args.concurrency if args.concurrency is not None else defaults[2]
    if warm_requests < 1 or concurrent_requests < 1 or requested_concurrency < 1:
        parser.error("request counts and concurrency must be positive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.out.exists():
        parser.error(f"Refusing to overwrite existing raw results: {args.out}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []

    first = one_request(
        args.base_url, args.timeout, "first_request_candidate", args.scenario
    )
    records.append(first)
    print(f"First-request candidate: {first['elapsed_ms']} ms, HTTP {first['status']}")

    warm_records = [
        one_request(args.base_url, args.timeout, "warm_sequential", args.scenario)
        for _ in range(warm_requests)
    ]
    records.extend(warm_records)

    concurrency = min(requested_concurrency, concurrent_requests)
    # Prepare each independent tracker before the concurrent timing window so
    # batch wall time describes only the simultaneous confirmation requests.
    concurrent_samples = [
        prepare_sample(args.base_url, args.timeout, args.scenario)
        for _ in range(concurrent_requests)
    ]
    batch_started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        concurrent_records = list(
            pool.map(
                lambda sample: one_request(
                    args.base_url,
                    args.timeout,
                    "concurrent",
                    args.scenario,
                    prepared_sample=sample,
                ),
                concurrent_samples,
            )
        )
    batch_elapsed_ms = (time.perf_counter() - batch_started) * 1000
    records.extend(concurrent_records)

    document = {
        "schema_version": 1,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "base_url_origin": f"{parsed.scheme}://{parsed.netloc}",
            "path": "/api/assistant/message",
            "scenario": args.scenario,
            "synthetic_trip": assistant_payload("metadata-only", args.scenario)[1],
            "model_revision_label": args.model_revision,
            "client_timeout_seconds": args.timeout,
        },
        "method_note": (
            "The first request is only a first-request candidate from this client process. "
            "It is not proof of a server process cold start or model load. Warm requests "
            "are sequential; every benchmark sample is an independent synthetic "
            "conversation through the public typed assistant API with a unique session "
            "ID and X-Conversation-Session header. For confirmed-trip samples, setup "
            "uses the planner greeting followed by structured /guided_slot turns, "
            "follows the server-returned requested-slot marker, and carries forward "
            "the context returned by each turn before sending /confirm_review. Setup "
            "requests are reported per sample but explicitly excluded from all latency "
            "phases; preparation failures are retained and fail the sample/run. A "
            "concurrent phase prepares every independent conversation before its batch "
            "timer starts, so batch wall time includes only the confirmation requests. "
            "confirmed-trip response is only successful when it contains at least one "
            "recommendation. Response source/count metadata describes recommendation "
            "provenance; a demo source label does not by itself mean the conversation "
            "fell back. The greeting scenario does not exercise confirmed-trip search."
        ),
        "phases": {
            "first_request_candidate": summarize([first]),
            "warm_sequential": summarize(warm_records),
            "concurrent": {
                **summarize(concurrent_records),
                "requested_concurrency": requested_concurrency,
                "effective_workers": concurrency,
                "batch_wall_ms": round(batch_elapsed_ms, 3),
                "completed_requests_per_second": round(
                    len(concurrent_records) / (batch_elapsed_ms / 1000), 3
                )
                if batch_elapsed_ms
                else None,
            },
        },
        "raw_requests": records,
        "interpretation_warning": (
            "No service-level latency target is asserted. Treat each run as a "
            "time-bounded observation of this client, network, Space, and request mix."
        ),
    }
    args.out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"Raw timings and summaries saved to {args.out}")
    print(json.dumps(document["phases"], indent=2))
    return 0 if all(item["ok"] for item in records) else 1


if __name__ == "__main__":
    sys.exit(main())