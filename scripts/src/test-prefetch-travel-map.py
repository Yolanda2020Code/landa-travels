import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs


SCRIPT = Path(__file__).with_name("prefetch-travel-map.py")
SPEC = importlib.util.spec_from_file_location("prefetch_travel_map", SCRIPT)
prefetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prefetch)


class FakeResponse:
    def __init__(self, value):
        self.body = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.body


class PipelineTests(unittest.TestCase):
    def test_missing_public_contact_email_fails_before_network(self):
        with self.assertRaisesRegex(prefetch.PrefetchError, "PUBLIC_OSM_CONTACT_EMAIL"):
            prefetch.prefetch("Lisbon, Portugal", "lisbon", contact_email=None, opener=lambda *_a, **_k: self.fail())

    def test_empty_and_ambiguous_geocoding_are_explicit(self):
        with self.assertRaisesRegex(prefetch.PrefetchError, "No OSM location"):
            prefetch.resolve_place("Nowhere", user_agent="identified agent", opener=lambda *_a, **_k: FakeResponse([]))
        candidates = [
            {"lat": "38.7", "lon": "-9.1", "osm_type": "relation", "osm_id": 1, "display_name": "Lisbon"},
            {"lat": "39.0", "lon": "-8.0", "osm_type": "node", "osm_id": 2, "display_name": "Lisboa, Portugal"},
        ]
        with self.assertRaisesRegex(prefetch.PrefetchError, "ambiguous") as raised:
            prefetch.resolve_place("Lisbon", user_agent="identified agent", opener=lambda *_a, **_k: FakeResponse(candidates))
        self.assertIn("relation/1", str(raised.exception))
        self.assertIn("node/2", str(raised.exception))
        self.assertIn("38.7, -9.1", str(raised.exception))
        self.assertIn("39.0, -8.0", str(raised.exception))
        self.assertIn("Lisboa, Portugal", str(raised.exception))

    def test_explicit_osm_id_selects_only_a_returned_candidate(self):
        candidates = [
            {"lat": "38.7", "lon": "-9.1", "osm_type": "relation", "osm_id": 1, "display_name": "Lisboa, Portugal"},
            {"lat": "38.8", "lon": "-9.2", "osm_type": "node", "osm_id": 2, "display_name": "Lisboa, Portugal"},
        ]
        opener = lambda *_a, **_k: FakeResponse(candidates)
        selected = prefetch.resolve_place(
            "Lisbon, Portugal",
            osm_id="node/2",
            user_agent="identified agent",
            opener=opener,
        )
        self.assertEqual(selected["osmObjectId"], "node/2")
        self.assertEqual(selected["latitude"], 38.8)
        self.assertEqual(selected["longitude"], -9.2)

        with self.assertRaisesRegex(prefetch.PrefetchError, "was not a unique result"):
            prefetch.resolve_place(
                "Lisbon, Portugal",
                osm_id="way/99",
                user_agent="identified agent",
                opener=opener,
            )

    def test_overpass_query_has_separate_bounded_category_outputs(self):
        query = prefetch.overpass_query(55.9533, -3.1883)
        self.assertEqual(query.count("out center"), 3)
        self.assertIn(f".hotels out center {prefetch.HOTEL_RESULT_CAP};", query)
        self.assertIn(f".attractions out center {prefetch.ATTRACTION_RESULT_CAP};", query)
        self.assertIn(f".transit out center {prefetch.TRANSIT_RESULT_CAP};", query)
        self.assertIn('nwr["tourism"="hotel"]', query)
        self.assertIn('nwr["railway"~"^(station|halt|tram_stop|subway_entrance)$"]', query)
        self.assertLessEqual(
            prefetch.HOTEL_RESULT_CAP + prefetch.ATTRACTION_RESULT_CAP + prefetch.TRANSIT_RESULT_CAP,
            prefetch.MAX_RECORDS,
        )

    def test_cache_is_bounded_normalized_and_keeps_wikipedia(self):
        calls = []

        def opener(request, **kwargs):
            calls.append((request, kwargs))
            if len(calls) == 1:
                return FakeResponse([{
                    "lat": "38.7223", "lon": "-9.1393", "osm_type": "relation", "osm_id": 123,
                    "display_name": "Lisbon, Portugal",
                }])
            return FakeResponse({"elements": [
                {"type": "way", "id": 44, "center": {"lat": 38.72, "lon": -9.14},
                 "tags": {"name": "Museum", "tourism": "museum", "wikipedia": "en:Example"}},
                {"type": "node", "id": 55, "lat": 38.73, "lon": -9.13,
                 "tags": {"name": "Central Station", "railway": "station", "opening_hours": "secret extra"}},
                {"type": "node", "id": 56, "lat": 38.73, "lon": -9.13,
                 "tags": {"name": "No category"}},
            ]})

        with tempfile.TemporaryDirectory() as directory:
            result = prefetch.prefetch(
                "Lisbon, Portugal", "lisbon", contact_email="maps@ecotravel.org",
                output_dir=Path(directory), opener=opener, clock=lambda: "2030-01-01T00:00:00Z",
            )
            cache = json.loads(result.read_text())
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0].full_url.split("?")[1], "q=Lisbon%2C+Portugal&format=json&limit=5")
        self.assertIn("maps@ecotravel.org", calls[0][0].get_header("User-agent"))
        self.assertEqual(cache["destination"]["osmObjectId"], "relation/123")
        self.assertEqual([item["category"] for item in cache["records"]], ["attraction", "transit"])
        self.assertEqual(cache["records"][0]["wikipedia"], "en:Example")
        self.assertNotIn("opening_hours", json.dumps(cache))
        self.assertTrue(all("sourceUrl" in item and "osmObjectId" in item and "checkedAt" in item for item in cache["records"]))
        query_data = parse_qs(calls[1][0].data.decode())["data"][0]
        self.assertIn(f"around:{prefetch.RADIUS_METERS},38.722300,-9.139300", query_data)
        self.assertEqual(query_data.count("out center"), 3)


if __name__ == "__main__":
    unittest.main()