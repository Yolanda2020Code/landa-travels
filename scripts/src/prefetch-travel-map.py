#!/usr/bin/env python3
"""Prefetch a bounded offline OSM context file for one explicitly named place.

This is an operator-run build-time tool. It is deliberately not imported or
called by the API/chat request path.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parents[2] / "apps/api/data/map-context"
RADIUS_METERS = 5_000
MAX_RECORDS = 80
HOTEL_RESULT_CAP = 20
ATTRACTION_RESULT_CAP = 20
TRANSIT_RESULT_CAP = 25
MAX_RESPONSE_BYTES = 2_000_000
HTTP_TIMEOUT_SECONDS = 30
MAX_RETRIES = 2
USER_AGENT_PRODUCT = "EcoTravelOfflineMapPrefetch/1.0"


class PrefetchError(RuntimeError):
    """Expected, actionable prefetch failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def valid_contact_email(value: str | None) -> str:
    email = (value or "").strip()
    if not email:
        raise PrefetchError("PUBLIC_OSM_CONTACT_EMAIL is required to identify the Nominatim client.")
    if (
        len(email) > 254
        or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)
        or re.search(
            r"(?:example\.com|(?:^|[._+-])(?:test(?:ing)?|placeholder|your[-_]?email)(?:[._+-]|@))",
            email,
            re.I,
        )
    ):
        raise PrefetchError("PUBLIC_OSM_CONTACT_EMAIL must be a real, publicly contactable email address.")
    return email


def validate_slug(slug: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", slug):
        raise PrefetchError("Destination slug must contain only letters, digits, and single hyphens.")
    return slug.lower()


def request_json(
    url: str,
    *,
    headers: dict[str, str],
    timeout: int = HTTP_TIMEOUT_SECONDS,
    data: bytes | None = None,
    opener: Callable[..., Any] = urlopen,
) -> Any:
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with opener(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise PrefetchError("OSM response exceeded the 2 MB safety limit.")
        return json.loads(body.decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PrefetchError(f"OSM request failed: {error}") from error


class NominatimPacer:
    """Enforce at least one second between requests made by this process."""

    def __init__(self, sleep: Callable[[float], None] = time.sleep, monotonic: Callable[[], float] = time.monotonic):
        self.sleep = sleep
        self.monotonic = monotonic
        self.last_request: float | None = None

    def wait_turn(self) -> None:
        now = self.monotonic()
        if self.last_request is not None:
            delay = max(0.0, 1.0 - (now - self.last_request))
            if delay:
                self.sleep(delay)
        self.last_request = self.monotonic()


def resolve_place(
    place: str,
    *,
    osm_id: str | None = None,
    user_agent: str,
    opener: Callable[..., Any] = urlopen,
    pacer: NominatimPacer | None = None,
) -> dict[str, Any]:
    query = place.strip()
    if not query:
        raise PrefetchError("Place must be explicitly named, for example: 'Lisbon, Portugal'.")
    (pacer or NominatimPacer()).wait_turn()
    url = f"{NOMINATIM_URL}?{urlencode({'q': query, 'format': 'json', 'limit': 5})}"
    results = request_json(url, headers={"User-Agent": user_agent, "Accept": "application/json"}, opener=opener)
    if not isinstance(results, list) or not results:
        raise PrefetchError(f"No OSM location matched {query!r}; provide a more specific place.")
    candidates = [
        item for item in results
        if isinstance(item, dict)
        and isinstance(item.get("lat"), str)
        and isinstance(item.get("lon"), str)
        and item.get("osm_type") in {"node", "way", "relation"}
        and str(item.get("osm_id", "")).isdigit()
    ]
    if not candidates:
        raise PrefetchError(f"Nominatim returned no usable coordinates for {query!r}.")

    def identity(candidate: dict[str, Any]) -> str:
        return f"{candidate['osm_type']}/{candidate['osm_id']}"

    def describe(candidate: dict[str, Any]) -> str:
        name = re.sub(r"[\x00-\x1f\x7f]", " ", str(candidate.get("display_name", "unnamed result")))
        name = " ".join(name.split()).strip()[:180] or "unnamed result"
        return (
            f"{identity(candidate)} at {candidate['lat']}, {candidate['lon']} — {name}"
        )

    if osm_id is not None:
        if not re.fullmatch(r"(?:node|way|relation)/[1-9]\d*", osm_id):
            raise PrefetchError("--osm-id must be formatted as node/123, way/123, or relation/123.")
        selected_candidates = [candidate for candidate in candidates if identity(candidate) == osm_id]
        if len(selected_candidates) != 1:
            descriptions = "\n  ".join(describe(candidate) for candidate in candidates[:5])
            raise PrefetchError(
                f"Requested --osm-id {osm_id!r} was not a unique result for {query!r}. "
                f"Select one of the returned candidates:\n  {descriptions}"
            )
        selected = selected_candidates[0]
    elif len(candidates) != 1:
        descriptions = "\n  ".join(describe(candidate) for candidate in candidates[:5])
        raise PrefetchError(
            f"Place {query!r} is ambiguous; re-run with --osm-id TYPE/ID. Candidates:\n  {descriptions}"
        )
    else:
        selected = candidates[0]
    try:
        latitude, longitude = float(selected["lat"]), float(selected["lon"])
    except (TypeError, ValueError) as error:
        raise PrefetchError("Nominatim returned invalid coordinates.") from error
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise PrefetchError("Nominatim returned out-of-range coordinates.")
    label = re.sub(r"[\x00-\x1f\x7f]", " ", str(selected.get("display_name", query)))
    label = " ".join(label.split()).strip()[:180] or query[:180]
    return {
        "label": label,
        "latitude": latitude,
        "longitude": longitude,
        "osmObjectId": f"{selected['osm_type']}/{selected['osm_id']}",
        "sourceUrl": f"https://www.openstreetmap.org/{selected['osm_type']}/{selected['osm_id']}",
    }


def overpass_query(latitude: float, longitude: float) -> str:
    lat, lon = f"{latitude:.6f}", f"{longitude:.6f}"
    around = f"(around:{RADIUS_METERS},{lat},{lon})"
    return (
        "[out:json][timeout:25][maxsize:10485760];\n"
        "(\n"
        f'  nwr["tourism"="hotel"]{around};\n'
        ")->.hotels;\n"
        f".hotels out center {HOTEL_RESULT_CAP};\n"
        "(\n"
        f'  nwr["tourism"~"^(attraction|museum|viewpoint)$"]{around};\n'
        f'  nwr["historic"~"^(monument|castle|museum)$"]{around};\n'
        ")->.attractions;\n"
        f".attractions out center {ATTRACTION_RESULT_CAP};\n"
        "(\n"
        f'  nwr["railway"~"^(station|halt|tram_stop|subway_entrance)$"]{around};\n'
        f'  nwr["public_transport"="station"]{around};\n'
        f'  nwr["station"~"^(subway|tram)$"]{around};\n'
        ")->.transit;\n"
        f".transit out center {TRANSIT_RESULT_CAP};"
    )


def _tag_text(tags: dict[str, Any], key: str, limit: int = 160) -> str | None:
    value = tags.get(key)
    if not isinstance(value, str):
        return None
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    value = " ".join(value.split()).strip()
    return value[:limit] if value else None


def normalize_osm_records(elements: Any, checked_at: str) -> list[dict[str, Any]]:
    if not isinstance(elements, list):
        raise PrefetchError("Overpass returned an invalid element list.")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for element in elements:
        if not isinstance(element, dict):
            continue
        osm_type, osm_id = element.get("type"), element.get("id")
        if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int) or osm_id <= 0:
            continue
        object_id = f"{osm_type}/{osm_id}"
        if object_id in seen:
            continue
        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue
        name = _tag_text(tags, "name")
        if not name:
            continue
        category: str | None = None
        tourism = tags.get("tourism")
        if tourism in {"hotel", "attraction", "museum", "viewpoint"} or tags.get("historic") in {
            "monument", "castle", "museum"
        }:
            category = "hotel" if tourism == "hotel" else "attraction"
        elif (
            tags.get("railway") in {"station", "halt", "tram_stop", "subway_entrance"}
            or tags.get("public_transport") == "station"
            or tags.get("station") in {"subway", "tram"}
        ):
            category = "transit"
        if category is None:
            continue
        latitude = element.get("lat")
        longitude = element.get("lon")
        if latitude is None or longitude is None:
            center = element.get("center")
            if isinstance(center, dict):
                latitude, longitude = center.get("lat"), center.get("lon")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        record: dict[str, Any] = {
            "category": category,
            "name": name,
            "latitude": round(float(latitude), 6),
            "longitude": round(float(longitude), 6),
            "osmObjectId": object_id,
            "sourceUrl": f"https://www.openstreetmap.org/{object_id}",
            "checkedAt": checked_at,
        }
        wikipedia = _tag_text(tags, "wikipedia", 120)
        if wikipedia:
            record["wikipedia"] = wikipedia
        records.append(record)
        seen.add(object_id)
        if len(records) >= MAX_RECORDS:
            break
    return records


def prefetch(
    place: str,
    slug: str,
    *,
    contact_email: str | None,
    osm_id: str | None = None,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    opener: Callable[..., Any] = urlopen,
    pacer: NominatimPacer | None = None,
    clock: Callable[[], str] = utc_now,
) -> Path:
    normalized_slug = validate_slug(slug)
    email = valid_contact_email(contact_email)
    user_agent = f"{USER_AGENT_PRODUCT} (public contact: {email})"
    destination = resolve_place(place, osm_id=osm_id, user_agent=user_agent, opener=opener, pacer=pacer)
    query = overpass_query(destination["latitude"], destination["longitude"])
    overpass_payload = urlencode({"data": query}).encode("utf-8")
    response: Any = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = request_json(
                OVERPASS_URL,
                headers={
                    "User-Agent": user_agent,
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data=overpass_payload,
                opener=opener,
            )
            break
        except PrefetchError:
            if attempt >= MAX_RETRIES:
                raise
            time.sleep(1 + attempt)
    if not isinstance(response, dict) or not isinstance(response.get("elements"), list):
        raise PrefetchError("Overpass returned an invalid JSON response.")
    checked_at = clock()
    cache = {
        "schemaVersion": 1,
        "destination": {
            "slug": normalized_slug,
            **destination,
            "checkedAt": checked_at,
        },
        "checkedAt": checked_at,
        "records": normalize_osm_records(response["elements"], checked_at),
        "attribution": "© OpenStreetMap contributors",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{normalized_slug}.json"
    output_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--place", required=True, help="Explicit place to geocode, e.g. 'Lisbon, Portugal'")
    parser.add_argument("--slug", required=True, help="Safe destination slug, e.g. lisbon")
    parser.add_argument(
        "--osm-id",
        help="Select a returned Nominatim result, e.g. node/123 or relation/123 (required when ambiguous)",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args(argv)
    try:
        output = prefetch(
            args.place,
            args.slug,
            contact_email=os.environ.get("PUBLIC_OSM_CONTACT_EMAIL"),
            osm_id=args.osm_id,
            output_dir=args.output_dir,
        )
    except PrefetchError as error:
        print(f"Prefetch failed: {error}", file=sys.stderr)
        return 2
    print(f"Wrote bounded OSM map context to {output}")
    print("Data may be incomplete or outdated; no availability, schedules, or certification are represented.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())