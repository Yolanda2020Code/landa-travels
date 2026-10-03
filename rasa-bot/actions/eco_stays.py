"""Small, independently sourced accommodation directory; not live inventory."""

from __future__ import annotations

import re
from typing import Any


# Checked against the linked hotel site or national certification operator.
# These listings are not proof of today's availability, price, accessibility,
# property-specific emissions, or continued certification at booking time.
CHECKED_AT = "2026-09-29"
STAYS: dict[str, list[dict[str, str]]] = {
    "berlin": [
        {
            "id": "hotel-berlin-berlin",
            "name": "Hotel Berlin, Berlin",
            "certification": "Green Key (hotel-reported; reconfirm before booking)",
            "source_url": "https://www.hotel-berlin.de/en/sustainability",
            "evidence": "The hotel's sustainability page states that the property is Green Key certified.",
        }
    ],
    "paris": [
        {
            "id": "saint-petersbourg-paris",
            "name": "Hôtel Saint-Pétersbourg Paris Opéra & Spa",
            "certification": "La Clef Verte (listed by the French certification operator; reconfirm before booking)",
            "source_url": "https://www.laclefverte.org/etablissement/23648",
            "evidence": "The French Clef Verte directory lists this named Paris hotel.",
        },
        {
            "id": "le-bellechasse-paris",
            "name": "Hôtel Le Bellechasse Saint-Germain",
            "certification": "La Clef Verte (hotel-reported; reconfirm before booking)",
            "source_url": "https://www.lebellechasse.com/en/",
            "evidence": "The hotel's official site states it has obtained the La Clef Verte label.",
        },
    ],
    "amsterdam": [
        {
            "id": "crowne-plaza-amsterdam-south",
            "name": "Crowne Plaza Amsterdam South",
            "certification": "Green Key (listed by Dutch certification operator; reconfirm before booking)",
            "source_url": "https://www.greenkey.nl/deelnemer/crowne-plaza-amsterdam-south-ubm-hotel-zuidas-bv",
            "evidence": "The Dutch Green Key directory lists the property in Amsterdam as a hotel.",
        },
        {
            "id": "park-inn-amsterdam-city-west",
            "name": "Park Inn by Radisson Amsterdam City West",
            "certification": "Green Key (listed by Dutch certification operator; reconfirm before booking)",
            "source_url": "https://www.greenkey.nl/deelnemer/park-inn-by-radisson-amsterdam-city-west",
            "evidence": "The Dutch Green Key directory lists the property in Amsterdam as a hotel.",
        },
    ],
    "barcelona": [
        {
            "id": "intercontinental-barcelona",
            "name": "InterContinental Barcelona",
            "certification": "Green Key (hotel-reported; reconfirm before booking)",
            "source_url": "https://barcelona.intercontinental.com/en/corporate-social-responsibility",
            "evidence": "The hotel's responsibility page states that it holds Green Key certification.",
        },
    ],
    "copenhagen": [
        {
            "id": "villa-copenhagen",
            "name": "Villa Copenhagen",
            "certification": "Green Key and Nordic Swan Ecolabel (hotel-reported; reconfirm before booking)",
            "source_url": "https://villacopenhagen.com/responsibility",
            "evidence": "The hotel's responsibility page states that it obtained Green Key and Nordic Swan certification.",
        },
    ],
    "lisbon": [
        {
            "id": "four-seasons-ritz-lisbon",
            "name": "Four Seasons Hotel Ritz Lisbon",
            "certification": "Green Key (hotel-reported renewal in 2026; reconfirm before booking)",
            "source_url": "https://press.fourseasons.com/lisbon/hotel-news/2026/green-key",
            "evidence": "The hotel's July 2026 announcement reports a third consecutive Green Key award.",
        },
    ],
    "prague": [
        {
            "id": "radisson-blu-prague",
            "name": "Radisson Blu Hotel Prague",
            "certification": "Green Key (listed by Prague's tourism authority; reconfirm before booking)",
            "source_url": "https://prague.eu/en/ubytovani/radisson-blu-hotel-prague",
            "evidence": "Prague's tourism authority identifies this hotel as a Green Key holder.",
        },
    ],
}


def curated_stays(destination: Any, estimated_stay_kg: float) -> list[dict[str, Any]]:
    city = re.sub(r"\s*\([A-Z]{3}\)\s*$", "", str(destination or "")).strip().casefold()
    return [
        {
            "id": entry["id"],
            "type": "stay",
            "name": entry["name"],
            "price_eur": None,
            # This is a generic trip-category estimate, not measured hotel emissions.
            "carbon_kg": estimated_stay_kg,
            "score": 80.0,
            "source": entry["source_url"],
            "verified_at": CHECKED_AT,
            "certification": entry["certification"],
            "description": (
                f"{entry['evidence']} Indicative listing only. No live room price or "
                "availability; the displayed stay CO₂e is a generic accommodation "
                "assumption for your party and nights, not a measurement of this hotel. "
                "Confirm the certification, accessibility, price and dates directly."
            ),
        }
        for entry in STAYS.get(city, [])
    ]