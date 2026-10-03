from __future__ import annotations

import json
import logging
import math
from travel_nlu.value_normalisation import normalise_dates, normalise_budget
import os
import re
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import date
from threading import BoundedSemaphore, Lock
from typing import Any

import requests
from rasa_sdk import Action, Tracker, FormValidationAction
from rasa_sdk.events import ActiveLoop, AllSlotsReset, FollowupAction, SlotSet
from rasa_sdk.executor import CollectingDispatcher
from .eco_stays import curated_stays
from .route_distance import road_distance_km
from .travel_questions import ActionAnswerTravelQuestion

logger = logging.getLogger(__name__)
OPTIONAL_LOOKUP_WORKERS = 4
OPTIONAL_LOOKUP_MAX_PENDING = 8
OPTIONAL_LOOKUP_CACHE_SECONDS = 300
OPTIONAL_LOOKUP_FAILURE_CACHE_SECONDS = 8
_OPTIONAL_LOOKUP_EXECUTOR = ThreadPoolExecutor(
    max_workers=OPTIONAL_LOOKUP_WORKERS,
    thread_name_prefix="rasa-optional-lookup",
)
_OPTIONAL_LOOKUP_PENDING = BoundedSemaphore(OPTIONAL_LOOKUP_MAX_PENDING)
_OPTIONAL_LOOKUP_LOCK = Lock()
_OPTIONAL_LOOKUP_CACHE: dict[tuple[Any, ...], tuple[float, Any]] = {}
_OPTIONAL_LOOKUP_INFLIGHT: dict[tuple[Any, ...], Future] = {}


@dataclass(frozen=True)
class ScoringWeights:
    carbon: float
    price: float
    preference: float


WEIGHTS = {
    "climate-first": ScoringWeights(0.60, 0.20, 0.20),
    "balanced": ScoringWeights(0.45, 0.35, 0.20),
    "comfort-first": ScoringWeights(0.30, 0.30, 0.40),
}

DEMO_OPTIONS = [
    {
        "id": "rail-demo",
        "type": "transport",
        "name": "Daytime rail",
        "price_eur": 54,
        "carbon_kg": 18.4,
        "source": "Indicative demo factor",
    },
    {
        "id": "coach-demo",
        "type": "transport",
        "name": "Direct coach",
        "price_eur": 31,
        "carbon_kg": 24.1,
        "source": "Indicative demo factor",
    },
    {
        "id": "flight-demo",
        "type": "transport",
        "name": "Direct economy flight",
        "price_eur": 119,
        "carbon_kg": 286.0,
        "source": "Indicative demo factor with radiative-forcing uplift",
    },
]

CLIMATIQ_TRANSPORT_FACTORS = {
    "rail-demo": "passenger_train-route_type_international_rail-fuel_source_na",
    "coach-demo": "passenger_vehicle-vehicle_type_coach-fuel_source_na-distance_na-engine_size_na",
    "flight-demo": "passenger_flight-route_type_international-aircraft_type_na-distance_short_haul_lt_3700km-class_na-rf_included-distance_uplift_included",
}

CITY_COORDINATES = {
    "amsterdam": (52.3676, 4.9041),
    "barcelona": (41.3874, 2.1686),
    "berlin": (52.5200, 13.4050),
    "copenhagen": (55.6761, 12.5683),
    "edinburgh": (55.9533, -3.1883),
    "lisbon": (38.7223, -9.1393),
    "london": (51.5072, -0.1276),
    "oslo": (59.9139, 10.7522),
    "paris": (48.8566, 2.3522),
    "prague": (50.0755, 14.4378),
    "san josé": (9.9281, -84.0907),
    "san jose": (9.9281, -84.0907),
}


def _is_internal_warmup(tracker: Tracker) -> bool:
    latest_message = getattr(tracker, "latest_message", None) or {}
    metadata = latest_message.get("metadata") if isinstance(latest_message, dict) else None
    sender_id = getattr(tracker, "sender_id", "")
    return (
        isinstance(metadata, dict)
        and metadata.get("planner_internal_warmup") is True
        and isinstance(sender_id, str)
        and sender_id.startswith("__internal_rasa_warmup__")
    )


def _optional_lookup_budget_seconds() -> float:
    try:
        configured = float(os.getenv("PLANNER_OPTIONAL_LOOKUP_BUDGET_MS", "250"))
    except (TypeError, ValueError):
        configured = 250.0
    return max(0.0, min(configured, 500.0)) / 1000.0


def _finish_optional_lookup(key: tuple[Any, ...], future: Future) -> None:
    try:
        result = future.result()
    except Exception as exc:
        logger.warning("Optional planning lookup failed (%s): %s", key[0], exc)
        result = None
    ttl = OPTIONAL_LOOKUP_CACHE_SECONDS if result is not None else OPTIONAL_LOOKUP_FAILURE_CACHE_SECONDS
    with _OPTIONAL_LOOKUP_LOCK:
        _OPTIONAL_LOOKUP_INFLIGHT.pop(key, None)
        _OPTIONAL_LOOKUP_CACHE[key] = (time.monotonic() + ttl, result)
    _OPTIONAL_LOOKUP_PENDING.release()


def _optional_lookup_future(key: tuple[Any, ...], operation) -> tuple[Any, Future | None]:
    now = time.monotonic()
    with _OPTIONAL_LOOKUP_LOCK:
        cached = _OPTIONAL_LOOKUP_CACHE.get(key)
        if cached and cached[0] > now:
            return cached[1], None
        if cached:
            _OPTIONAL_LOOKUP_CACHE.pop(key, None)
        existing = _OPTIONAL_LOOKUP_INFLIGHT.get(key)
        if existing is not None:
            return None, existing
        if not _OPTIONAL_LOOKUP_PENDING.acquire(blocking=False):
            return None, None
        try:
            future = _OPTIONAL_LOOKUP_EXECUTOR.submit(operation)
        except Exception as exc:
            _OPTIONAL_LOOKUP_PENDING.release()
            logger.warning("Optional planning lookup could not be queued (%s): %s", key[0], exc)
            return None, None
        _OPTIONAL_LOOKUP_INFLIGHT[key] = future
    future.add_done_callback(lambda completed: _finish_optional_lookup(key, completed))
    return None, future


def _optional_lookup_results(
    jobs: list[tuple[tuple[Any, ...], Any]],
    wait_budget_seconds: float | None = None,
) -> dict[tuple[Any, ...], Any]:
    results: dict[tuple[Any, ...], Any] = {}
    waiting: dict[tuple[Any, ...], Future] = {}
    for key, operation in jobs:
        cached, future = _optional_lookup_future(key, operation)
        if future is None:
            results[key] = cached
        else:
            waiting[key] = future
    if waiting:
        wait(
            set(waiting.values()),
            timeout=_optional_lookup_budget_seconds()
            if wait_budget_seconds is None
            else max(0.0, wait_budget_seconds),
        )
    for key, future in waiting.items():
        if not future.done():
            results[key] = None
            continue
        try:
            results[key] = future.result()
        except Exception:
            results[key] = None
    return results


def _city_key(value: Any) -> str:
    return re.sub(r"\s*\([A-Z]{3}\)\s*$", "", str(value or "")).strip().casefold()


def _route_distance_km(origin: Any, destination: Any) -> tuple[float, str]:
    start = CITY_COORDINATES.get(_city_key(origin))
    end = CITY_COORDINATES.get(_city_key(destination))
    if not start or not end:
        return 500.0, "illustrative 500 km route because this city pair was not geocoded"
    lat1, lon1, lat2, lon2 = map(
        math.radians, (start[0], start[1], end[0], end[1])
    )
    delta_lat, delta_lon = lat2 - lat1, lon2 - lon1
    value = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    direct = 6371.0 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))
    return round(direct, 1), "approximate great-circle distance between the selected cities"


def _transport_lookup_plan(
    origin: Any,
    destination: Any,
    *,
    allow_remote_lookups: bool,
) -> tuple[
    float,
    str,
    dict[str, float],
    tuple[Any, ...],
    dict[str, tuple[Any, ...]],
    list[tuple[tuple[Any, ...], Any]],
]:
    direct_km, distance_source = _route_distance_km(origin, destination)
    direct_return_distances = {
        "rail-demo": direct_km * 1.18 * 2,
        "coach-demo": direct_km * 1.15 * 2,
        "flight-demo": direct_km * 2,
    }
    lookup_jobs: list[tuple[tuple[Any, ...], Any]] = []
    ors_key = os.getenv("OPENROUTESERVICE_API_KEY")
    start = CITY_COORDINATES.get(_city_key(origin))
    end = CITY_COORDINATES.get(_city_key(destination))
    road_lookup_key = ("openrouteservice", start, end, bool(ors_key))
    if allow_remote_lookups and ors_key and start and end and start != end:
        lookup_jobs.append((
            road_lookup_key,
            lambda: road_distance_km(start, end),
        ))

    activity_keys: dict[str, tuple[Any, ...]] = {}
    if allow_remote_lookups and os.getenv("CLIMATIQ_API_KEY"):
        for item in DEMO_OPTIONS:
            activity_id = CLIMATIQ_TRANSPORT_FACTORS[item["id"]]
            parameters = {
                "passengers": 1,
                "distance": direct_return_distances[item["id"]],
                "distance_unit": "km",
            }
            lookup_key = (
                "climatiq",
                activity_id,
                round(float(parameters["distance"]), 3),
                parameters["distance_unit"],
                bool(os.getenv("CLIMATIQ_API_KEY")),
            )
            activity_keys[item["id"]] = lookup_key
            lookup_jobs.append((
                lookup_key,
                lambda activity_id=activity_id, parameters=parameters: climatiq_estimate(
                    activity_id, parameters
                ),
            ))
    return (
        direct_km,
        distance_source,
        direct_return_distances,
        road_lookup_key,
        activity_keys,
        lookup_jobs,
    )


def prewarm_transport_lookups(origin: Any, destination: Any) -> None:
    """Start optional route/emissions lookups without waiting on the intake turn."""
    if (
        not isinstance(origin, str)
        or not isinstance(destination, str)
        or len(origin.strip()) < 2
        or len(destination.strip()) < 2
        or len(origin) > 120
        or len(destination) > 120
        or origin.strip().casefold() == destination.strip().casefold()
        or _city_key(origin) == _city_key(destination)
    ):
        return
    start = CITY_COORDINATES.get(_city_key(origin))
    end = CITY_COORDINATES.get(_city_key(destination))
    if start and end and start == end:
        return
    try:
        *_, lookup_jobs = _transport_lookup_plan(
            origin,
            destination,
            allow_remote_lookups=True,
        )
        # Queue the provider operations themselves. Do not submit a wrapper that
        # calls build_transport_options: it would occupy the same pool while
        # waiting for nested jobs and could deadlock a saturated pool.
        for key, operation in lookup_jobs:
            _optional_lookup_future(key, operation)
    except Exception as exc:
        logger.warning("Optional planning lookup prewarm could not be queued: %s", exc)


def build_transport_options(
    origin: Any,
    destination: Any,
    *,
    allow_remote_lookups: bool = True,
) -> tuple[list[dict[str, Any]], str]:
    """Create options using bounded, shared optional provider lookups."""
    (
        direct_km,
        distance_source,
        direct_return_distances,
        road_lookup_key,
        activity_keys,
        lookup_jobs,
    ) = _transport_lookup_plan(
        origin,
        destination,
        allow_remote_lookups=allow_remote_lookups,
    )
    lookup_results = _optional_lookup_results(lookup_jobs)
    road_km = lookup_results.get(road_lookup_key)
    return_distances = {
        **direct_return_distances,
        "coach-demo": (road_km if road_km is not None else direct_km * 1.15) * 2,
    }
    factors = {"rail-demo": 0.035, "coach-demo": 0.050, "flight-demo": 0.185}
    price_rates = {"rail-demo": 0.12, "coach-demo": 0.065, "flight-demo": 0.10}
    options = []
    for item in DEMO_OPTIONS:
        estimate = lookup_results.get(activity_keys.get(item["id"], ()))
        route_km = return_distances[item["id"]]
        carbon_route_km = direct_return_distances[item["id"]]
        item_distance_source = (
            "HeiGIT OpenRouteService driving-car road route (coach fare proxy, not rail)"
            if item["id"] == "coach-demo" and road_km is not None
            else distance_source
        )
        minimum_price = 45 if item["id"] == "flight-demo" else 20
        activity_id = CLIMATIQ_TRANSPORT_FACTORS[item["id"]]
        if estimate is not None:
            carbon_kg = round(estimate, 1)
            carbon_source = f"Climatiq estimate (GB conversion-factor proxy; {activity_id})"
        else:
            carbon_kg = round(carbon_route_km * factors[item["id"]], 1)
            if not allow_remote_lookups:
                fallback_reason = "external provider calls deliberately skipped for internal readiness warm-up"
            elif os.getenv("CLIMATIQ_API_KEY"):
                fallback_reason = "Climatiq unavailable or request failed"
            else:
                fallback_reason = "CLIMATIQ_API_KEY not configured"
            carbon_source = f"Demo estimate ({fallback_reason})"
        options.append({
            **item,
            "price_eur": round(max(minimum_price, route_km * price_rates[item["id"]])),
            "carbon_kg": carbon_kg,
            "source": (
                f"{carbon_source}; indicative mode estimate over "
                f"{carbon_route_km:.0f} km using {distance_source}; "
                f"{item_distance_source} for the fare proxy"
            ),
            "description": (
                f"Approximate return journey over {route_km:.0f} km. "
                "Indicative fare is per traveller; budget ranking considers the whole party. "
                "Confirm the actual route, timetable, fare, and occupancy."
            ),
        })
    return options, (
        f"{distance_source}; coach uses HeiGIT OpenRouteService road distance when available"
        if road_km is not None else distance_source
    )


def _trip_nights(value: Any) -> tuple[int, bool]:
    """Return a bounded stay length and whether it came from explicit ISO dates."""
    matches = re.findall(r"\b20\d{2}-\d{2}-\d{2}\b", str(value or ""))
    if len(matches) >= 2:
        try:
            start, end = date.fromisoformat(matches[0]), date.fromisoformat(matches[1])
            days = (end - start).days
            if 1 <= days <= 30:
                return days, True
        except ValueError:
            pass
    return 3, False


def estimate_trip_footprint(
    transport: dict[str, Any],
    travelers: int,
    travel_dates: Any,
    accommodation_need: Any,
) -> dict[str, Any]:
    """Build an indicative trip total from transparent, bounded assumptions."""
    nights, exact_nights = _trip_nights(travel_dates)
    accommodation = str(accommodation_need or "hotel").casefold()
    if accommodation in {"none", "no accommodation", "not needed"}:
        stay_factor = 0.0
        stay_label = "no accommodation"
    elif "hostel" in accommodation or "guesthouse" in accommodation:
        stay_factor = 4.0
        stay_label = "lower-impact shared/local stay"
    elif "eco" in accommodation:
        # A stated preference is not evidence of either property certification
        # or property-specific emissions. Use the same generic hotel assumption.
        stay_factor = 10.0
        stay_label = "hotel (eco preference; property impact unverified)"
    elif "apartment" in accommodation:
        stay_factor = 5.5
        stay_label = "apartment"
    else:
        stay_factor = 10.0
        stay_label = "hotel"

    transport_total = round(float(transport["carbon_kg"]) * travelers, 1)
    stay_total = round(stay_factor * nights * travelers, 1)
    local_total = round(1.5 * nights * travelers, 1)
    total = round(transport_total + stay_total + local_total, 1)
    return {
        "total_kg": total,
        "travelers": travelers,
        "nights": nights,
        "exact_nights": exact_nights,
        "transport_kg": transport_total,
        "transport_name": transport["name"],
        "stay_kg": stay_total,
        "stay_label": stay_label,
        "local_kg": local_total,
    }


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: dict[str, Any] | None = None,
    timeout: float = 2.3,
) -> dict[str, Any] | None:
    try:
        response = requests.request(
            method, url, headers=headers, json=data, timeout=timeout
        )
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("External API request failed: %s", exc)
        return None


def _normalise_inverse(value: float, maximum: float) -> float:
    return max(0.0, 1.0 - min(value / maximum, 1.0))


def _budget_eur(value: Any) -> float | None:
    """Parse a simple EUR budget; do not compare other currencies without FX data."""
    text = str(value or "").casefold()
    if not text or any(currency in text for currency in ("gbp", "£", "usd", "$", "chf", "cad", "aud")):
        return None
    if "eur" not in text and "€" not in text:
        return None
    amounts = re.findall(r"\d[\d,]*(?:\.\d{1,2})?", text)
    if not amounts:
        return None
    try:
        parsed = [float(amount.replace(",", "")) for amount in amounts]
    except ValueError:
        return None
    budget = max(parsed)
    return budget if budget > 0 else None


def _mode_for_preference(preference: Any) -> str | None:
    text = str(preference or "").casefold()
    if any(word in text for word in ("rail", "train")):
        return "rail-demo"
    if any(word in text for word in ("coach", "bus")):
        return "coach-demo"
    if any(word in text for word in ("flight", "plane", "air")):
        return "flight-demo"
    return None


def rank_options(
    options: list[dict[str, Any]],
    sustainability_level: str,
    budget: Any = None,
    transport_preference: Any = None,
    travelers: int = 1,
) -> list[dict[str, Any]]:
    weights = WEIGHTS.get(sustainability_level, WEIGHTS["balanced"])
    budget_limit = _budget_eur(budget)
    preferred_mode = _mode_for_preference(transport_preference)
    ranked = []
    for option in options:
        carbon_score = _normalise_inverse(float(option["carbon_kg"]), 350.0)
        price = float(option["price_eur"]) * max(1, travelers)
        if budget_limit is None:
            price_score = _normalise_inverse(price, 500.0)
            budget_score = None
        else:
            price_score = _normalise_inverse(price, budget_limit)
            budget_score = round(max(0.0, 1.0 - max(0.0, price - budget_limit) / budget_limit), 3)
        preference_score = (
            0.5 if preferred_mode is None
            else 1.0 if option.get("id") == preferred_mode
            else 0.0
        )
        score = (
            carbon_score * weights.carbon
            + price_score * weights.price
            + preference_score * weights.preference
        )
        if budget_score is not None:
            score = score * 0.85 + budget_score * 0.15
        ranked.append({
            **option,
            "preference_fit": preference_score,
            "budget_fit": budget_score,
            "score": round(score * 100, 1),
        })
    return sorted(ranked, key=lambda item: item["score"], reverse=True)


def climatiq_estimate(activity_id: str, parameters: dict[str, Any]) -> float | None:
    key = os.getenv("CLIMATIQ_API_KEY")
    if not key:
        return None
    payload = {
        # GB conversion factors are a disclosed planning proxy for cross-border
        # routes, not an assertion about the actual train, coach or aircraft.
        "emission_factor": {"activity_id": activity_id, "data_version": "37", "region": "GB"},
        "parameters": parameters,
    }
    result = _request_json(
        "POST",
        "https://api.climatiq.io/data/v1/estimate",
        headers={"Authorization": f"Bearer {key}"},
        data=payload,
        timeout=1.0,
    )
    try:
        estimate = float(result["co2e"]) if result and "co2e" in result else None
        return estimate if estimate is not None and math.isfinite(estimate) and estimate >= 0 else None
    except (TypeError, ValueError):
        return None


def amadeus_token() -> str | None:
    client_id = os.getenv("AMADEUS_CLIENT_ID")
    client_secret = os.getenv("AMADEUS_CLIENT_SECRET")
    if not client_id or not client_secret:
        return None
    try:
        response = requests.post(
            "https://test.api.amadeus.com/v1/security/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            timeout=2.3,
        )
        response.raise_for_status()
        return response.json().get("access_token")
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Amadeus authentication failed: %s", exc)
        return None


class ActionFindSustainableOptions(Action):
    def name(self) -> str:
        return "action_find_sustainable_options"

    def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: dict[str, Any],
        *,
        validated_review: bool = False,
    ) -> list[dict[str, Any]]:
        started = time.perf_counter()
        if not tracker.get_slot("origin") or not tracker.get_slot("destination"):
            dispatcher.utter_message(text="I need a departure city and destination before comparing this trip. I won't invent a route, hotel match or footprint.")
            return [ActiveLoop("trip_form"), FollowupAction("trip_form")]
        if not validated_review and not tracker.get_slot("review_confirmation") and not _is_internal_warmup(tracker):
            dispatcher.utter_message(text="Please review and confirm the collected details before I search. No search has started.")
            return [FollowupAction("action_review_summary")]
        level = tracker.get_slot("sustainability_level") or "balanced"
        destination = tracker.get_slot("destination") or "your destination"
        travelers = max(1, int(float(tracker.get_slot("travelers") or 1)))
        transport_preference = str(
            tracker.get_slot("transport_preference") or "flexible"
        ).casefold()

        internal_warmup = _is_internal_warmup(tracker)
        options, distance_source = build_transport_options(
            tracker.get_slot("origin"),
            destination,
            allow_remote_lookups=not internal_warmup,
        )
        budget = tracker.get_slot("budget")
        ranked_transport = rank_options(
            options,
            level,
            budget=budget,
            transport_preference=transport_preference,
            travelers=travelers,
        )
        preferred = ranked_transport[0]
        footprint = estimate_trip_footprint(
            preferred,
            travelers,
            tracker.get_slot("travel_dates"),
            tracker.get_slot("accommodation_need"),
        )
        nights_note = (
            f"{footprint['nights']} nights from your selected dates"
            if footprint["exact_nights"]
            else f"an illustrative {footprint['nights']}-night stay because exact nights were not available"
        )
        accommodation = str(tracker.get_slot("accommodation_need") or "hotel").casefold()
        if "vegan" in accommodation or "pet" in accommodation:
            dispatcher.utter_message(text="Your vegan or pet-friendly accommodation requirement is saved, but I have not verified a matching hotel's meals or pet policy. Any general property listings are not verified matches for that requirement; confirm directly with the provider or ask an advisor.")
        no_stay = accommodation in {"none", "no accommodation", "not needed"}
        wants_hotel = "hostel" not in accommodation and "guesthouse" not in accommodation and "apartment" not in accommodation
        stay_options = curated_stays(destination, footprint["stay_kg"]) if wants_hotel and not no_stay else []
        activity_preferences = tracker.get_slot("activity_preferences") or ["flexible"]
        activity_preference = str(activity_preferences[0] if isinstance(activity_preferences, list) else activity_preferences).casefold()
        experience = {
            "cultural": {
                "name": f"Car-free cultural day in {destination}",
                "description": "A walkable cultural itinerary using public transport. Opening hours, access, and availability must be confirmed.",
            },
            "outdoor": {
                "name": f"Outdoor walk and local nature in {destination}",
                "description": "A low-impact outdoor itinerary focused on walking and local nature. Trail conditions, access, and availability must be confirmed.",
            },
            "nature": {
                "name": f"Nature and wildlife day near {destination}",
                "description": "A nature-oriented day using local public transport and walking where practical. Site conditions and availability must be confirmed.",
            },
            "flexible": {
                "name": f"Car-free local day in {destination}",
                "description": "A walkable cultural itinerary using public transport. Opening hours and accessibility must be confirmed.",
            },
        }.get(activity_preference, {
            "name": f"Car-free local day in {destination}",
            "description": "A walkable cultural itinerary using public transport. Opening hours and accessibility must be confirmed.",
        })
        additional = [
            *([] if no_stay else stay_options if stay_options else [{
                "id": "stay-category-estimate",
                "type": "stay",
                "name": f"Accommodation planning estimate in {destination}",
                "price_eur": None,
                "carbon_kg": footprint["stay_kg"],
                "score": 60.0,
                "source": "Generic accommodation factor; no property verified for this destination",
                "description": (
                    f"Indicative {footprint['stay_label']} for {footprint['nights']} nights. "
                    "This is not a named hotel, quote, availability, or verified certification."
                ),
            }]),
            {
                "id": "local-experience-demo",
                "type": "experience",
                "name": experience["name"],
                "price_eur": 24 * travelers,
                "carbon_kg": footprint["local_kg"],
                "score": 82.0,
                "source": "Curated demonstration estimate",
                "description": experience["description"],
                "activity_preference": activity_preference,
            },
            {
                "id": "verified-offset-guidance",
                "type": "offset",
                "name": "Verified climate contribution",
                "price_eur": round(max(5, footprint["total_kg"] * 0.025)),
                "carbon_kg": footprint["total_kg"],
                "score": 55.0,
                "source": "Curated guidance — programme and retirement record must be verified",
                "description": (
                    f"Only after reducing the trip footprint, consider a programme that "
                    f"publishes its methodology, additionality evidence, registry serial "
                    f"numbers, and retirement records. The displayed {footprint['total_kg']} "
                    "kg CO₂e is the footprint to address, not emissions erased by payment."
                ),
                "certification": "Look for Gold Standard or Verra registry evidence; verify independently",
            },
        ]
        ranked = [*ranked_transport, *additional]
        dispatcher.utter_message(
            text=(
                f"Estimated trip footprint: approximately {footprint['total_kg']} kg CO₂e "
                f"for {travelers} traveller{'s' if travelers != 1 else ''}.\n\n"
                f"Estimated breakdown: {footprint['transport_name']} "
                f"{footprint['transport_kg']} kg, {nights_note} "
                f"{footprint['stay_kg']} kg, and local transport "
                f"{footprint['local_kg']} kg.\n\n"
                f"I ranked the options for {destination} using your {level} priority. "
                "These are planning estimates, not guarantees. They use indicative "
                f"route, occupancy, accommodation, and local-transport factors "
                f"({distance_source}); transport cards identify whether their carbon "
                "estimate came from Climatiq or a demo factor. Demo factors are not live "
                "provider data. Confirm "
                "live prices, availability, and certification before booking. "
                "The total footprint remains an indicative mixed-source planning estimate; "
                "a climate contribution does not reduce or erase that displayed total."
            ),
            json_message={
                "type": "recommendations",
                "items": ranked,
                "footprint": footprint,
                "latency_ms": round((time.perf_counter() - started) * 1000),
                # These recommendation cards are curated estimates, not live
                # provider inventory. A token existing does not make them live.
                "live_amadeus_available": False,
            },
        )
        return [SlotSet("recommendation_results", ranked)]


class ActionHumanHandover(Action):
    def name(self) -> str:
        return "action_human_handover"

    def run(
        self,
        dispatcher: CollectingDispatcher,
        tracker: Tracker,
        domain: dict[str, Any],
    ) -> list[dict[str, Any]]:
        handover_id = f"LANDA-{uuid.uuid4().hex[:8].upper()}"
        context = {
            key: tracker.get_slot(key)
            for key in (
                "origin",
                "destination",
                "travel_dates",
                "budget",
                "sustainability_level",
                "travelers",
            )
            if tracker.get_slot(key) is not None
        }
        transcript = [
            {
                "event": event.get("event"),
                "text": event.get("text"),
            }
            for event in tracker.events[-20:]
            if event.get("event") in {"user", "bot"}
        ]
        package = {
            "handover_id": handover_id,
            "context": context,
            "recent_transcript": transcript,
            "privacy_note": "Precise GPS and unrelated metadata excluded.",
        }
        # Do not place travel details or transcript text in application logs.
        logger.info(
            "Handover package created: id=%s slot_names=%s",
            handover_id,
            sorted(context),
        )
        dispatcher.utter_message(
            text=(
                "I can prepare a secure handover to a human travel advisor. "
                "Review the trip details in the handover panel and submit the "
                f"request when you are ready. Reference {handover_id}; nothing "
                "is sent until you confirm."
            ),
            json_message={"type": "local_handover_preview", **package},
        )
        return [SlotSet("handover_id", handover_id)]


class ValidateTripForm(FormValidationAction):
    """Reject malformed values instead of silently treating them as trip facts."""

    def name(self) -> str:
        return "validate_trip_form"

    async def required_slots(self, domain_slots, dispatcher, tracker, domain):
        """Request an approximate location only after the traveller chooses manual mode."""
        slots = list(domain_slots)
        if tracker.get_slot("destination_ambiguity") and "destination" in slots:
            slots.remove("destination")
            slots.insert(0, "destination")
        if tracker.get_slot("location_mode") == "manual":
            if "location" not in slots:
                slots.append("location")
        else:
            slots = [slot for slot in slots if slot != "location"]
        return slots

    @staticmethod
    def _text(value: Any) -> str:
        return str(value).strip() if value is not None else ""

    @staticmethod
    def _unsafe(value: str) -> bool:
        lowered = value.casefold()
        markers = (
            "ignore your instructions",
            "system prompt",
            "api key",
            "password",
            "secret",
            "select *",
            "http://",
            "https://",
        )
        # Addresses and coordinates are intentionally not accepted as travel
        # locations: location consent is handled separately and approximately.
        address_like = bool(re.search(r"\b\d{1,6}\s+\S+\s+(street|st|road|rd|avenue|ave|lane|ln)\b", lowered))
        coordinate_like = bool(re.search(r"-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+", lowered))
        return any(marker in lowered for marker in markers) or address_like or coordinate_like

    def _location(self, value: Any, field: str, tracker: Tracker, dispatcher):
        if value is None:
            return None
        text = self._text(value)
        if len(text) < 2 or len(text) > 120 or self._unsafe(text):
            dispatcher.utter_message(text=f"Please provide an approximate {field} city or region, not an address, coordinates, or instruction.")
            return None
        other = "destination" if field == "origin" else "origin"
        if text.casefold() == self._text(tracker.get_slot(other)).casefold():
            dispatcher.utter_message(text="Origin and destination must be different.")
            return None
        return text

    def validate_origin(self, slot_value, dispatcher, tracker, domain):
        origin = self._location(slot_value, "origin", tracker, dispatcher)
        if origin is not None:
            _prewarm_validated_route(origin, tracker.get_slot("destination"), tracker)
        return {"origin": origin}

    def validate_destination(self, slot_value, dispatcher, tracker, domain):
        if str(slot_value or "").strip().casefold() in {"springfield", "newport"}:
            dispatcher.utter_message(text=f"Which {slot_value} do you mean? Please include a state, region or country; I won't choose one for you.")
            return {"destination": None, "destination_ambiguity": True}
        destination = self._location(slot_value, "destination", tracker, dispatcher)
        if destination is not None:
            _prewarm_validated_route(tracker.get_slot("origin"), destination, tracker)
        result = {"destination": destination}
        if destination is not None and tracker.get_slot("destination_ambiguity"):
            result["destination_ambiguity"] = False
        return result

    def validate_travelers(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"travelers": None}
        try:
            parsed_count = float(slot_value)
            count = int(parsed_count) if math.isfinite(parsed_count) and parsed_count.is_integer() else 0
        except (TypeError, ValueError):
            count = 0
        if not 1 <= count <= 20:
            dispatcher.utter_message(text="Traveller count must be a whole number from 1 to 20.")
            return {"travelers": None}
        return {"travelers": count}

    def validate_travel_dates(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"travel_dates": None}
        value = self._text(slot_value)
        if len(value) < 3 or len(value) > 100:
            dispatcher.utter_message(text="Please provide a date or an approximate travel period.")
            return {"travel_dates": None}
        try:
            value = normalise_dates(value)
        except ValueError:
            dispatcher.utter_message(text="Please provide valid calendar dates, with return on or after departure.")
            return {"travel_dates": None}
        exact_range = re.fullmatch(
            r"(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}|flexible return))?",
            value,
            re.IGNORECASE,
        )
        if exact_range:
            try:
                departure = date.fromisoformat(exact_range.group(1))
                if departure < date.today():
                    dispatcher.utter_message(text="Please choose a departure date today or later for a new trip.")
                    return {"travel_dates": None}
                return_date = exact_range.group(2)
                if return_date and return_date.casefold() != "flexible return" and date.fromisoformat(return_date) < departure:
                    raise ValueError("Return date precedes departure.")
            except ValueError:
                dispatcher.utter_message(text="The return date must be the same day as or later than departure.")
                return {"travel_dates": None}
        return {"travel_dates": value}

    def validate_sustainability_level(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"sustainability_level": None}
        value = self._text(slot_value).lower()
        if value not in WEIGHTS:
            dispatcher.utter_message(text="Choose climate-first, balanced, or comfort-first.")
            return {"sustainability_level": None}
        return {"sustainability_level": value}

    def validate_budget(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"budget": None}
        value = self._text(slot_value)
        if len(value) < 2 or len(value) > 80:
            dispatcher.utter_message(text="Please provide a budget range and currency, or say flexible.")
            return {"budget": None}
        try:
            value = normalise_budget(value)
        except ValueError:
            dispatcher.utter_message(text="Budget must not be negative. Please include the currency or say flexible.")
            return {"budget": None}
        return {"budget": value}

    def _preference(self, slot_value, field: str, dispatcher):
        if slot_value is None:
            return None
        value = self._text(slot_value)
        if not value or len(value) > 120 or self._unsafe(value):
            dispatcher.utter_message(text=f"Please provide a short, practical {field} preference.")
            return None
        return value

    def validate_transport_preference(self, slot_value, dispatcher, tracker, domain):
        return {"transport_preference": self._preference(slot_value, "transport", dispatcher)}

    def validate_accessibility_need(self, slot_value, dispatcher, tracker, domain):
        return {"accessibility_need": self._preference(slot_value, "accessibility", dispatcher)}

    def validate_accommodation_need(self, slot_value, dispatcher, tracker, domain):
        if str(slot_value or "").casefold() == "pet-friendly":
            dispatcher.utter_message(text="I've noted your pet-friendly accommodation requirement. Pets are not human travellers. I cannot verify entry rules, airline carriage or hotel pet policies; confirm those with an advisor or provider before booking.")
        return {"accommodation_need": self._preference(slot_value, "accommodation", dispatcher)}

    def validate_activity_preferences(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"activity_preferences": None}
        raw_values = slot_value if isinstance(slot_value, list) else [slot_value]
        aliases = {
            "culture": "cultural",
            "cultural": "cultural",
            "cultural experiences": "cultural",
            "outdoors": "outdoor",
            "outdoor": "outdoor",
            "outdoor activities": "outdoor",
            "nature": "nature",
            "nature and wildlife": "nature",
            "flexible": "flexible",
            "no preference": "flexible",
        }
        values = [aliases.get(self._text(item).casefold()) for item in raw_values]
        if not values or any(value is None for value in values):
            dispatcher.utter_message(text="Choose cultural experiences, outdoor activities, nature and wildlife, or no preference.")
            return {"activity_preferences": None}
        return {"activity_preferences": list(dict.fromkeys(value for value in values if value is not None))}

    def validate_location_mode(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"location_mode": None}
        value = self._text(slot_value).casefold()
        aliases = {
            "skip": "none",
            "skipped": "none",
            "gps": "gps",
            "current location": "gps",
            "manual": "manual",
            "enter manually": "manual",
            "none": "none",
        }
        if value not in aliases:
            dispatcher.utter_message(text="Choose approximate device location, enter a city manually, or skip location sharing.")
            return {"location_mode": None}
        mode = aliases[value]
        return {
            "location_mode": mode,
            **({"location": None} if mode != "manual" else {}),
        }

    def validate_stopovers(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"stopovers": None}
        values = slot_value if isinstance(slot_value, list) else [slot_value]
        cleaned = [self._text(item) for item in values]
        if any(not item or len(item) > 120 or self._unsafe(item) for item in cleaned):
            dispatcher.utter_message(text="Stopovers must be approximate city or region names, not addresses or instructions.")
            return {"stopovers": None}
        endpoints = {self._text(tracker.get_slot(name)).casefold() for name in ("origin", "destination")}
        if any(item.casefold() in endpoints for item in cleaned):
            dispatcher.utter_message(text="A stopover must differ from the origin and destination.")
            return {"stopovers": None}
        return {"stopovers": cleaned}

    def validate_location(self, slot_value, dispatcher, tracker, domain):
        if slot_value is None:
            return {"location": None}
        value = self._text(slot_value)
        if len(value) < 2 or len(value) > 120 or self._unsafe(value):
            dispatcher.utter_message(response="utter_ask_approximate_location")
            return {"location": None}
        return {"location": value}


def _prewarm_validated_route(origin: Any, destination: Any, tracker: Tracker | None = None) -> None:
    if tracker is not None and _is_internal_warmup(tracker):
        return
    if (
        not isinstance(origin, str)
        or not isinstance(destination, str)
        or len(origin.strip()) < 2
        or len(destination.strip()) < 2
        or len(origin) > 120
        or len(destination) > 120
        or ValidateTripForm._unsafe(origin)
        or ValidateTripForm._unsafe(destination)
        or origin.strip().casefold() == destination.strip().casefold()
    ):
        return
    prewarm_transport_lookups(origin, destination)


class ActionApplyGuidedInput(Action):
    """Validate structured planner values after the Rasa user turn."""

    _slot_names = {
        "origin",
        "destination",
        "stopovers",
        "travel_dates",
        "travelers",
        "budget",
        "transport_preference",
        "accessibility_need",
        "sustainability_level",
        "accommodation_need",
        "activity_preferences",
        "location",
        "location_mode",
        "review_confirmation",
    }

    def name(self) -> str:
        return "action_apply_guided_input"

    def run(self, dispatcher, tracker, domain):
        latest_message = tracker.latest_message or {}
        pet_entities = [entity for entity in latest_message.get("entities", [])
                        if entity.get("entity") == "accommodation_need" and entity.get("value") == "pet-friendly"]
        if pet_entities:
            dispatcher.utter_message(text="I've noted that you are travelling with a pet and need pet-friendly accommodation. Pets are not counted as human travellers. I cannot verify entry rules, airline carriage or hotel pet policies; an advisor or the provider should confirm those before booking.")
        metadata = latest_message.get("metadata") or {}
        supplied = metadata.get("planner_slot_values") if isinstance(metadata, dict) else None
        if supplied is None:
            return []
        if not isinstance(supplied, dict) or any(name not in self._slot_names for name in supplied):
            dispatcher.utter_message(text="I could not safely apply those trip details. Please enter them again.")
            return []

        validator = ValidateTripForm()
        events = []
        validated_slots = {}
        for name, value in supplied.items():
            if value is None:
                validated = {name: None}
            elif name == "review_confirmation":
                if not isinstance(value, bool):
                    dispatcher.utter_message(text="Trip confirmation must be a yes or no choice.")
                    return []
                validated = {name: value}
            elif name in {"activity_preferences", "stopovers"}:
                if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                    dispatcher.utter_message(text="Those trip choices were not in a valid format. Please select them again.")
                    return []
                method = getattr(validator, f"validate_{name}")
                validated = method(value, dispatcher, tracker, domain)
            elif name == "travelers":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    dispatcher.utter_message(text="Traveller count must be a number from 1 to 20.")
                    return []
                validated = validator.validate_travelers(value, dispatcher, tracker, domain)
            else:
                if not isinstance(value, str):
                    dispatcher.utter_message(text="That trip detail was not text. Please enter it again.")
                    return []
                if name == "location" and supplied.get("location_mode", tracker.get_slot("location_mode")) != "manual":
                    dispatcher.utter_message(text="Choose manual location sharing before entering an approximate city.")
                    return []
                method = getattr(validator, f"validate_{name}", None)
                if method is None:
                    dispatcher.utter_message(text="I could not validate that trip detail. Please enter it again.")
                    return []
                validated = method(value, dispatcher, tracker, domain)
            validated_slots.update(validated)
            events.extend(SlotSet(slot_name, slot_value) for slot_name, slot_value in validated.items())
        if "origin" in validated_slots or "destination" in validated_slots:
            _prewarm_validated_route(
                validated_slots.get("origin", tracker.get_slot("origin")),
                validated_slots.get("destination", tracker.get_slot("destination")),
                tracker,
            )
        return events


class ActionAskDestination(Action):
    """Offer destinations with locally supported indicative route estimates."""

    def name(self) -> str:
        return "action_ask_destination"

    def run(self, dispatcher, tracker, domain):
        origin = str(tracker.get_slot("origin") or "").strip()
        origin_key = _city_key(origin)
        origin_coordinates = CITY_COORDINATES.get(origin_key)
        cities_by_coordinates = {}
        for city, coordinates in CITY_COORDINATES.items():
            if city == "san jose" or city == origin_key or coordinates == origin_coordinates:
                continue
            cities_by_coordinates.setdefault(coordinates, city)
        cities = list(cities_by_coordinates.values())
        if origin_coordinates:
            # _route_distance_km is a local haversine calculation for known
            # cities; do not call the road-routing provider while asking.
            cities.sort(key=lambda city: (_route_distance_km(origin_key, city)[0], city))
        else:
            # With an unknown origin, keep a stable, deterministic example order.
            cities.sort()
        # These are destinations with configured city coordinates for indicative
        # comparisons, not claims about schedules, routes, or live availability.
        buttons = [
            {
                "title": city.title(),
                "payload": f'/inform{{"destination":"{city.title()}"}}',
            }
            for city in cities[:5]
        ]
        context = f" from {origin}" if origin else ""
        dispatcher.utter_message(
            text=(
                f"Where would you like to go{context}? Choose a configured city "
                "or type another city. For a recognized origin, examples are ordered "
                "by straight-line proximity; this is not a transport route, "
                "schedule, travel time, or availability."
            ),
            buttons=buttons,
        )
        return []


class ActionAskTransportPreference(Action):
    """Offer the transport modes used by this bot's comparison calculations."""

    def name(self) -> str:
        return "action_ask_transport_preference"

    def run(self, dispatcher, tracker, domain):
        origin = str(tracker.get_slot("origin") or "").strip()
        destination = str(tracker.get_slot("destination") or "").strip()
        route = (
            f" for {origin} to {destination}"
            if origin and destination
            else f" for {origin}" if origin
            else f" to {destination}" if destination
            else ""
        )
        modes = [
            ("Rail", "rail"),
            ("Coach", "coach"),
            ("Flight", "flight"),
            ("Flexible", "flexible"),
        ]
        dispatcher.utter_message(
            text=(
                f"Which transport do you prefer or need{route}? "
                "These choices guide indicative comparisons, not live availability."
            ),
            buttons=[
                {
                    "title": title,
                    "payload": f'/inform{{"transport_preference":"{value}"}}',
                }
                for title, value in modes
            ],
        )
        return []


class ActionAskActivityPreference(Action):
    def name(self) -> str:
        return "action_ask_activity_preferences"

    def run(self, dispatcher, tracker, domain):
        choices = [
            ("Cultural experiences", "cultural"),
            ("Outdoor activities", "outdoor"),
            ("Nature and wildlife", "nature"),
            ("No preference", "flexible"),
        ]
        dispatcher.utter_message(
            response="utter_ask_activity_preferences",
            buttons=[
                {
                    "title": title,
                    "payload": f'/guided_slot{{"activity_preferences":["{value}"]}}',
                }
                for title, value in choices
            ],
        )
        return []


class ActionAskLocationMode(Action):
    def name(self) -> str:
        return "action_ask_location_mode"

    def run(self, dispatcher, tracker, domain):
        choices = [
            ("Use approximate device location", "gps"),
            ("Enter a city manually", "manual"),
            ("Skip location", "none"),
        ]
        dispatcher.utter_message(
            response="utter_ask_location_mode",
            buttons=[
                {
                    "title": title,
                    "payload": f'/guided_slot{{"location_mode":"{value}"}}',
                }
                for title, value in choices
            ],
        )
        return []


class ActionCancelTrip(Action):
    def name(self) -> str:
        return "action_cancel_trip"

    def run(self, dispatcher, tracker, domain):
        dispatcher.utter_message(response="utter_cancelled")
        return [ActiveLoop(None), AllSlotsReset()]


class ActionRestartTrip(Action):
    def name(self) -> str:
        return "action_restart_trip"

    def run(self, dispatcher, tracker, domain):
        dispatcher.utter_message(response="utter_restarted")
        return [ActiveLoop(None), AllSlotsReset()]


class ActionValidateReview(Action):
    def name(self) -> str:
        return "action_validate_review"

    def run(self, dispatcher, tracker, domain):
        required = (
            "origin",
            "destination",
            "travel_dates",
            "travelers",
            "budget",
            "transport_preference",
            "accessibility_need",
            "sustainability_level",
            "accommodation_need",
            "activity_preferences",
        )
        missing = [slot for slot in required if not tracker.get_slot(slot)]
        location_mode = tracker.get_slot("location_mode")
        if not location_mode:
            missing.append("location_mode")
        if location_mode == "manual" and not tracker.get_slot("location"):
            missing.append("approximate location")
        if missing:
            labels = {"origin": "departure city", "destination": "destination",
                      "travel_dates": "travel dates", "travelers": "traveller count",
                      "budget": "budget", "transport_preference": "transport preference",
                      "accessibility_need": "accessibility requirements", "sustainability_level": "sustainability preference",
                      "accommodation_need": "accommodation preference", "activity_preferences": "activity interests",
                      "location_mode": "optional location-sharing choice"}
            dispatcher.utter_message(text="I still need: " + ", ".join(labels.get(name, name) for name in missing) +
                                     ". Let's finish your trip details one question at a time before I compare options.")
            return [SlotSet("review_confirmation", None), SlotSet("requested_slot", None),
                    ActiveLoop("trip_form"), FollowupAction("trip_form")]
        dispatcher.utter_message(text="Thanks — I will use only these details to compare options.")
        result = ActionFindSustainableOptions().run(dispatcher, tracker, domain, validated_review=True)
        return [SlotSet("review_confirmation", True), SlotSet("requested_slot", None), *result]


class ActionHandleLocationConsent(Action):
    def name(self) -> str:
        return "action_handle_location_consent"

    def run(self, dispatcher, tracker, domain):
        mode = tracker.get_slot("location_mode")
        if mode == "gps":
            dispatcher.utter_message(text="Device location consent recorded for this comparison. Precise coordinates are not stored.")
            return [SlotSet("location", None), SlotSet("location_consent", True), *ActionReviewSummary().run(dispatcher, tracker, domain)]
        if mode == "manual":
            dispatcher.utter_message(response="utter_ask_approximate_location")
            return [SlotSet("location_consent", True)]
        if mode == "none":
            return [SlotSet("location", None), SlotSet("location_consent", False), *ActionReviewSummary().run(dispatcher, tracker, domain)]
        dispatcher.utter_message(response="utter_location_choice")
        return []


class ActionReviewSummary(Action):
    def name(self) -> str:
        return "action_review_summary"

    def run(self, dispatcher, tracker, domain):
        latest = tracker.latest_message or {}
        metadata = latest.get("metadata") or {}
        metadata = metadata if isinstance(metadata, dict) else {}
        supplied = metadata.get("planner_slot_values") or {}
        changes = any(name != "review_confirmation" for name in supplied) or any(
            entity.get("entity") in ActionApplyGuidedInput._slot_names
            for entity in latest.get("entities", []))
        if latest.get("intent", {}).get("name") == "correct_information" and (
                metadata.get("planner_correction_requested") or not changes):
            candidate = metadata.get("planner_correction_candidate") if isinstance(metadata, dict) else None
            candidate = candidate if isinstance(candidate, str) and not ValidateTripForm._unsafe(candidate) else None
            if candidate:
                dispatcher.utter_message(
                    text=f"Do you mean you will leave from {candidate}, or travel to {candidate}? Your trip is unchanged until you choose.",
                    buttons=[{"title": f"Leave from {candidate}", "payload": "/correct_information" + json.dumps({"origin": candidate})},
                             {"title": f"Travel to {candidate}", "payload": "/correct_information" + json.dumps({"destination": candidate})}])
            else:
                labels = [("Departure city", "origin"), ("Destination", "destination"),
                          ("Travel dates", "travel_dates"), ("Travellers", "travelers"),
                          ("Budget", "budget"), ("Transport", "transport_preference"),
                          ("Accommodation", "accommodation_need"), ("Accessibility", "accessibility_need"),
                          ("Sustainability preference", "sustainability_level"), ("Activities", "activity_preferences")]
                dispatcher.utter_message(
                    text="Which trip detail would you like to change? Choose one below. Your other answers will be kept.",
                    buttons=[{"title": label, "payload": "__planner_edit__:" + json.dumps({name: None, "review_confirmation": None})}
                             for label, name in labels])
            return [SlotSet("requested_slot", None), ActiveLoop(None)]
        if any(not tracker.get_slot(name) for name in ("origin", "destination", "travel_dates", "travelers", "budget")):
            return [SlotSet("review_confirmation", None), ActiveLoop("trip_form"), FollowupAction("trip_form")]
        if tracker.get_slot("location_mode") == "manual":
            approximate = str(tracker.get_slot("location") or "").strip()
            if not approximate or ValidateTripForm._unsafe(approximate):
                dispatcher.utter_message(response="utter_ask_approximate_location")
                return [SlotSet("location", None), SlotSet("requested_slot", "location")]

        def value(name, default="not provided"):
            current = tracker.get_slot(name)
            if isinstance(current, list):
                return ", ".join(str(item) for item in current) or default
            return str(current) if current not in (None, "") else default

        summary = (
            "Review: "
            f"origin={value('origin')}; destination={value('destination')}; "
            f"stopovers={value('stopovers', 'none')}; dates={value('travel_dates')}; "
            f"travellers={value('travelers')}; budget={value('budget')}; "
            f"transport={value('transport_preference')}; accessibility={value('accessibility_need')}; "
            f"sustainability={value('sustainability_level')}; accommodation={value('accommodation_need')}; "
            f"activities={value('activity_preferences')}; "
            f"location_mode={value('location_mode')}. Confirm these details before I search."
        )
        dispatcher.utter_message(
            text=summary,
            buttons=[
                {
                    "title": "Confirm and compare options",
                    "payload": "/confirm_review",
                },
                {
                    "title": "I want to change something",
                    "payload": "/deny",
                },
            ],
        )
        return [SlotSet("review_confirmation", False), SlotSet("requested_slot", "review_confirmation")]


class ActionReviewDenial(Action):
    def name(self) -> str:
        return "action_review_denial"

    def run(self, dispatcher, tracker, domain):
        count = int(tracker.get_slot("consecutive_denials") or 0) + 1
        if count >= 3:
            dispatcher.utter_message(
                text="That's okay — I've paused the questions rather than keep repeating suggestions. Your trip details are kept. You can continue when ready, change a detail, ask an advisor, or explicitly cancel.",
                buttons=[{"title": "Continue planning", "payload": "/guided_continue"},
                         {"title": "Ask an advisor", "payload": "/request_handover"},
                         {"title": "Cancel", "payload": "/cancel"}],
            )
            return [SlotSet("consecutive_denials", count), SlotSet("review_confirmation", None),
                    SlotSet("requested_slot", None), ActiveLoop(None)]
        if count == 2:
            dispatcher.utter_message(
                text="I won't force a choice. Tell me an alternative, ask what the question means, or request an advisor. No request has been sent and no search has started.",
                buttons=[{"title": "Explain the question", "payload": "/ask_clarification"},
                         {"title": "Ask an advisor", "payload": "/request_handover"}],
            )
            return [SlotSet("consecutive_denials", count), SlotSet("review_confirmation", None)]
        dispatcher.utter_message(
            text=(
                "No search was started. Tell me the detail to correct, or choose "
                "human support if we are not resolving this together."
            ),
            buttons=[
                {"title": "Speak to a human", "payload": "/request_handover"},
            ],
        )
        return [SlotSet("consecutive_denials", count), SlotSet("review_confirmation", False)]


class ActionRemoveStopover(Action):
    def name(self) -> str:
        return "action_remove_stopover"

    def run(self, dispatcher, tracker, domain):
        dispatcher.utter_message(text="Stopover removed; all other trip details remain unchanged.")
        return [SlotSet("stopovers", None)]
