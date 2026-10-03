"""Optional HeiGIT/OpenRouteService road distances; never substitutes for rail routing."""

from __future__ import annotations

import math
import os
from typing import Any

import requests

ORS_URL = "https://api.heigit.org/openrouteservice/v2/directions/driving-car"
_cache: dict[tuple[tuple[float, float], tuple[float, float]], float] = {}


def road_distance_km(
    start: tuple[float, float] | None, end: tuple[float, float] | None
) -> float | None:
    """Return routed one-way road kilometres, or None for unavailable routes."""
    key = os.getenv("OPENROUTESERVICE_API_KEY")
    if not key or start is None or end is None or start == end:
        return None
    pair = (start, end)
    if pair in _cache:
        return _cache[pair]
    try:
        response = requests.post(
            ORS_URL,
            headers={"Authorization": key, "Content-Type": "application/json"},
            json={"coordinates": [[start[1], start[0]], [end[1], end[0]]]},
            timeout=1.2,
        )
        response.raise_for_status()
        metres = response.json()["routes"][0]["summary"]["distance"]
        distance = float(metres) / 1000
        if not math.isfinite(distance) or distance <= 0:
            return None
        _cache[pair] = distance
        return distance
    except (requests.RequestException, ValueError, TypeError, KeyError, IndexError):
        return None