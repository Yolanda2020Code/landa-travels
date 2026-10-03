import importlib.util
import io
import sys
import unittest
import time
import threading
from contextlib import redirect_stdout
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from rasa_sdk.executor import CollectingDispatcher

import actions.actions as action_impl
from actions.actions import (
    ActionReviewSummary,
    ActionApplyGuidedInput,
    ActionAskActivityPreference,
    ActionAskDestination,
    ActionAskLocationMode,
    ActionAskTransportPreference,
    ActionCancelTrip,
    ActionFindSustainableOptions,
    ActionRestartTrip,
    ActionValidateReview,
    ValidateTripForm,
    build_transport_options,
    climatiq_estimate,
    estimate_trip_footprint,
    rank_options,
)
from actions.eco_stays import curated_stays
from actions.route_distance import _cache, road_distance_km

_WARMUP_SPEC = importlib.util.spec_from_file_location(
    "warmup_rasa",
    Path(__file__).resolve().parents[1] / "scripts" / "warmup-rasa.py",
)
warmup_rasa = importlib.util.module_from_spec(_WARMUP_SPEC)
_WARMUP_SPEC.loader.exec_module(warmup_rasa)


class FakeTracker:
    def __init__(self, slots, latest_message=None, sender_id=None):
        self.slots = slots
        self.latest_message = latest_message or {}
        self.sender_id = sender_id

    def get_slot(self, name):
        return self.slots.get(name)


COMPLETE = {
    "origin": "Berlin",
    "destination": "Paris",
    "travel_dates": "next month",
    "travelers": 2,
    "budget": "EUR 1000",
    "transport_preference": "rail",
    "accessibility_need": "none",
    "sustainability_level": "balanced",
    "accommodation_need": "hotel",
    "activity_preferences": ["flexible"],
    "location_mode": "none",
    "location": None,
}


class AdaptiveFormTests(unittest.IsolatedAsyncioTestCase):
    def test_generic_correction_keeps_confirmed_trip_and_offers_named_fields(self):
        dispatcher = CollectingDispatcher()
        tracker = FakeTracker({**COMPLETE, "review_confirmation": True},
                              {"intent": {"name": "correct_information"}})
        events = ActionReviewSummary().run(dispatcher, tracker, {})
        self.assertIn("Which trip detail", dispatcher.messages[0]["text"])
        self.assertEqual(dispatcher.messages[0]["buttons"][0]["title"], "Departure city")
        self.assertFalse(any(e.get("name") in COMPLETE or e.get("name") == "review_confirmation" for e in events))
        self.assertNotIn("transport_preference", dispatcher.messages[0]["text"])

    def test_ambiguous_place_correction_offers_roles_without_guessing(self):
        dispatcher = CollectingDispatcher()
        tracker = FakeTracker({"origin": "Paris", "destination": "Amsterdam"},
                              {"intent": {"name": "correct_information"},
                               "metadata": {"planner_correction_candidate": "England"}})
        events = ActionReviewSummary().run(dispatcher, tracker, {})
        self.assertIn("leave from England", dispatcher.messages[0]["text"])
        self.assertIn("travel to England", dispatcher.messages[0]["text"])
        self.assertFalse(any(e.get("name") in {"origin", "destination"} for e in events))

    def test_missing_review_does_not_expose_internal_slot_names(self):
        dispatcher = CollectingDispatcher()
        events = ActionValidateReview().run(dispatcher, FakeTracker({"origin": "Paris"}), {})
        self.assertIn("one question at a time", dispatcher.messages[0]["text"])
        self.assertNotIn("travel_dates", dispatcher.messages[0]["text"])
        self.assertTrue(any(e.get("name") == "trip_form" and e.get("event") == "followup" for e in events))

    async def test_manual_location_mode_adds_location_without_mutating_domain_slots(self):
        base_slots = ["origin", "destination", "travel_dates", "travelers"]
        required = await ValidateTripForm().required_slots(
            base_slots, CollectingDispatcher(), FakeTracker({"location_mode": "manual"}), {}
        )
        self.assertEqual(required, [*base_slots, "location"])
        self.assertEqual(base_slots, ["origin", "destination", "travel_dates", "travelers"])

    async def test_nonmanual_location_modes_do_not_require_location(self):
        base_slots = ["origin", "destination", "location", "travel_dates"]
        for mode in ("gps", "none", None):
            with self.subTest(location_mode=mode):
                required = await ValidateTripForm().required_slots(
                    base_slots,
                    CollectingDispatcher(),
                    FakeTracker({"location_mode": mode}),
                    {},
                )
                self.assertEqual(required, ["origin", "destination", "travel_dates"])

    async def test_activity_and_location_mode_are_rasa_form_slots(self):
        slots = [
            "origin", "destination", "travel_dates", "travelers", "budget",
            "transport_preference", "accessibility_need", "sustainability_level",
            "accommodation_need", "activity_preferences", "location_mode",
        ]
        required = await ValidateTripForm().required_slots(
            slots, CollectingDispatcher(), FakeTracker({"location_mode": "none"}), {}
        )
        self.assertEqual(required, slots)

    def test_location_mode_validation_clears_stale_manual_city_when_skipped(self):
        value = ValidateTripForm().validate_location_mode(
            "none", CollectingDispatcher(), FakeTracker({"location": "Berlin"}), {}
        )
        self.assertEqual(value, {"location_mode": "none", "location": None})


class ActionApplyGuidedInputTests(unittest.TestCase):
    @staticmethod
    def event_dicts(events):
        return [event if isinstance(event, dict) else event.as_dict() for event in events]

    def run_guided(self, values, slots=None):
        dispatcher = CollectingDispatcher()
        tracker = FakeTracker(
            slots or {},
            {"metadata": {"planner_slot_values": values}},
        )
        with patch.dict("os.environ", {
            "OPENROUTESERVICE_API_KEY": "",
            "CLIMATIQ_API_KEY": "",
        }):
            events = ActionApplyGuidedInput().run(dispatcher, tracker, {})
        return dispatcher, self.event_dicts(events)

    def test_structured_values_are_validated_by_the_custom_action(self):
        dispatcher, events = self.run_guided(
            {"destination": "Paris", "travelers": 2, "activity_preferences": ["cultural"]},
            {"origin": "Berlin"},
        )
        self.assertEqual(
            [(event["name"], event["value"]) for event in events],
            [("destination", "Paris"), ("travelers", 2), ("activity_preferences", ["cultural"])],
        )
        self.assertEqual(dispatcher.messages, [])

    def test_invalid_structured_location_is_rejected_before_slot_set(self):
        dispatcher, events = self.run_guided({"origin": "12 King Street"})
        self.assertEqual([(event["name"], event["value"]) for event in events], [("origin", None)])
        self.assertIn("not an address", dispatcher.messages[0]["text"])

    def test_optional_lookup_prewarm_follows_validation_and_coalesces(self):
        with patch("actions.actions.prewarm_transport_lookups") as prewarm:
            self.run_guided({"origin": "12 King Street", "destination": "Paris"})
            self.run_guided({"origin": "Berlin", "destination": "Berlin"})
            prewarm.assert_not_called()

            self.run_guided({"origin": "Berlin", "destination": "Paris"})
            prewarm.assert_called_once_with("Berlin", "Paris")
            prewarm.reset_mock()
            internal_tracker = FakeTracker(
                {},
                {"metadata": {
                    "planner_internal_warmup": True,
                    "planner_slot_values": {"origin": "Berlin", "destination": "Paris"},
                }},
                "__internal_rasa_warmup__test",
            )
            ActionApplyGuidedInput().run(CollectingDispatcher(), internal_tracker, {})
            prewarm.assert_not_called()
            ValidateTripForm().validate_destination(
                "Paris",
                CollectingDispatcher(),
                FakeTracker({"origin": "Berlin"}),
                {},
            )
            prewarm.assert_called_once_with("Berlin", "Paris")

        started = threading.Event()
        release = threading.Event()
        calls = []

        def queued_operation():
            calls.append(True)
            started.set()
            release.wait(timeout=1)
            return 1.0

        key = ("test-prewarm-coalescing", time.monotonic_ns())
        try:
            _, first = action_impl._optional_lookup_future(key, queued_operation)
            self.assertIsNotNone(first)
            self.assertTrue(started.wait(timeout=0.5))
            _, second = action_impl._optional_lookup_future(key, queued_operation)
            self.assertIs(first, second)
        finally:
            release.set()
        first.result(timeout=1)
        self.assertEqual(len(calls), 1)

    def test_fractional_structured_traveller_count_is_rejected(self):
        dispatcher, events = self.run_guided({"travelers": 2.5})
        self.assertEqual([(event["name"], event["value"]) for event in events], [("travelers", None)])
        self.assertIn("whole number", dispatcher.messages[0]["text"])

    def test_action_does_not_write_slots_without_turn_metadata(self):
        events = ActionApplyGuidedInput().run(CollectingDispatcher(), FakeTracker({}), {})
        self.assertEqual(events, [])

    def apply_restored_context(self, values):
        dispatcher = CollectingDispatcher()
        with patch.dict("os.environ", {
            "OPENROUTESERVICE_API_KEY": "",
            "CLIMATIQ_API_KEY": "",
        }):
            events = self.event_dicts(ActionApplyGuidedInput().run(
                dispatcher,
                FakeTracker({}, {"metadata": {"planner_slot_values": values}}),
                {},
            ))
        validated_slots = {
            event["name"]: event["value"]
            for event in events
            if event.get("event") == "slot"
        }
        return dispatcher, validated_slots

    def test_valid_complete_bootstrap_is_validated_then_can_confirm(self):
        bootstrap = {**COMPLETE, "review_confirmation": True}
        dispatcher, validated_slots = self.apply_restored_context(bootstrap)
        self.assertEqual(dispatcher.messages, [])
        self.assertEqual(validated_slots["travelers"], 2)
        self.assertEqual(validated_slots["travel_dates"], "next month")

        review_dispatcher = CollectingDispatcher()
        with patch("actions.actions.road_distance_km", return_value=None), \
             patch("actions.actions.climatiq_estimate", return_value=None), \
             patch.dict("os.environ", {"CLIMATIQ_API_KEY": ""}):
            ActionValidateReview().run(
                review_dispatcher,
                FakeTracker({**bootstrap, **validated_slots}),
                {},
            )
        self.assertTrue(any(
            message.get("custom", {}).get("type") == "recommendations"
            for message in review_dispatcher.messages
        ))

    def test_invalid_bootstrap_dates_or_party_cannot_confirm(self):
        invalid_contexts = (
            {**COMPLETE, "travel_dates": "2026-10-15 to 2026-10-12", "review_confirmation": True},
            {**COMPLETE, "travelers": 0, "review_confirmation": True},
        )
        for bootstrap in invalid_contexts:
            with self.subTest(bootstrap=bootstrap):
                _, validated_slots = self.apply_restored_context(bootstrap)
                review_dispatcher = CollectingDispatcher()
                events = ActionValidateReview().run(
                    review_dispatcher,
                    FakeTracker({**bootstrap, **validated_slots}),
                    {},
                )
                self.assertTrue(any("I still need:" in message.get("text", "") for message in review_dispatcher.messages))
                self.assertFalse(any(
                    message.get("custom", {}).get("type") == "recommendations"
                    for message in review_dispatcher.messages
                ))
                self.assertTrue(any(
                    event.get("event") == "active_loop" and event.get("name") == "trip_form"
                    for event in self.event_dicts(events)
                ))


class DynamicFormAskTests(unittest.TestCase):
    def test_activity_and_location_prompts_return_structured_safe_slot_payloads(self):
        activity_dispatcher = CollectingDispatcher()
        ActionAskActivityPreference().run(activity_dispatcher, FakeTracker({}), {})
        self.assertEqual(
            [button["payload"] for button in activity_dispatcher.messages[0]["buttons"]],
            [
                '/guided_slot{"activity_preferences":["cultural"]}',
                '/guided_slot{"activity_preferences":["outdoor"]}',
                '/guided_slot{"activity_preferences":["nature"]}',
                '/guided_slot{"activity_preferences":["flexible"]}',
            ],
        )

        location_dispatcher = CollectingDispatcher()
        ActionAskLocationMode().run(location_dispatcher, FakeTracker({}), {})
        self.assertEqual(
            [button["payload"] for button in location_dispatcher.messages[0]["buttons"]],
            [
                '/guided_slot{"location_mode":"gps"}',
                '/guided_slot{"location_mode":"manual"}',
                '/guided_slot{"location_mode":"none"}',
            ],
        )

    def test_destination_buttons_use_supported_cities_and_exclude_origin(self):
        dispatcher = CollectingDispatcher()
        with patch(
            "actions.actions.road_distance_km",
            side_effect=AssertionError("destination prompts must not call ORS"),
        ):
            ActionAskDestination().run(dispatcher, FakeTracker({"origin": "Berlin"}), {})

        message = dispatcher.messages[0]
        buttons = message["buttons"]
        self.assertIn("from Berlin", message["text"])
        self.assertGreater(len(buttons), 0)
        self.assertLessEqual(len(buttons), 5)
        self.assertNotIn("Berlin", [button["title"] for button in buttons])
        self.assertTrue(all(
            button["payload"].startswith('/inform{"destination":"')
            for button in buttons
        ))
        self.assertIn("Paris", [button["title"] for button in buttons])
        self.assertIn("straight-line proximity", message["text"])
        self.assertIn("availability", message["text"])
        self.assertIn("type another city", message["text"])

    def test_transport_buttons_offer_only_modes_used_by_comparison(self):
        dispatcher = CollectingDispatcher()
        ActionAskTransportPreference().run(
            dispatcher,
            FakeTracker({"origin": "Berlin", "destination": "Paris"}),
            {},
        )

        message = dispatcher.messages[0]
        self.assertIn("Berlin to Paris", message["text"])
        self.assertEqual(
            [button["title"] for button in message["buttons"]],
            ["Rail", "Coach", "Flight", "Flexible"],
        )
        self.assertEqual(
            [button["payload"] for button in message["buttons"]],
            [
                '/inform{"transport_preference":"rail"}',
                '/inform{"transport_preference":"coach"}',
                '/inform{"transport_preference":"flight"}',
                '/inform{"transport_preference":"flexible"}',
            ],
        )


class WarmupScriptTests(unittest.TestCase):
    def test_mocked_warmup_metadata_matches_validators_and_tracker_state(self):
        context = warmup_rasa.PLANNER_CONTEXT
        departure, return_date = [
            date.fromisoformat(part) for part in context["travel_dates"].split(" to ")
        ]
        self.assertEqual(return_date - departure, timedelta(days=4))
        self.assertGreater(departure, date.today())

        dispatcher = CollectingDispatcher()
        validator = ValidateTripForm()
        self.assertEqual(
            validator.validate_travel_dates(
                context["travel_dates"], dispatcher, FakeTracker({}), {}
            ),
            {"travel_dates": context["travel_dates"]},
        )
        self.assertEqual(
            validator.validate_budget(context["budget"], dispatcher, FakeTracker({}), {}),
            {"budget": context["budget"]},
        )
        self.assertEqual(dispatcher.messages, [])

        internal_tracker = FakeTracker(
            {},
            {"metadata": {
                "planner_internal_warmup": True,
                "planner_slot_values": context,
            }},
            f"{warmup_rasa.SENDER_PREFIX}test",
        )
        with patch.dict("os.environ", {
            "OPENROUTESERVICE_API_KEY": "",
            "CLIMATIQ_API_KEY": "",
        }):
            events = ActionApplyGuidedInput().run(dispatcher, internal_tracker, {})
        validated = {
            event["name"]: event["value"]
            for event in ActionApplyGuidedInputTests.event_dicts(events)
        }
        self.assertEqual(dispatcher.messages, [])
        for key in ("origin", "destination", "travel_dates", "budget", "travelers"):
            self.assertEqual(validated[key], context[key])

        current_slots = {}
        requested_slot = "origin"
        current_events = []
        webhook_bodies = []

        def mock_request_json(_base_url, path, method, payload=None):
            nonlocal requested_slot
            if method == "GET" and path.endswith("/tracker"):
                return {
                    "slots": {**current_slots, "requested_slot": requested_slot},
                    "active_loop": {"name": "trip_form"} if requested_slot else {},
                    "events": list(current_events),
                }
            self.assertEqual(path, "/webhooks/rest/webhook")
            self.assertEqual(method, "POST")
            webhook_bodies.append(payload)
            metadata = payload["metadata"]
            self.assertIs(metadata.get("planner_internal_warmup"), True)
            self.assertTrue(payload["sender"].startswith(warmup_rasa.SENDER_PREFIX))
            message = payload["message"]
            if message == "hello":
                current_events.append({"event": "action", "name": "utter_greet"})
                # Greeting copy is not a serving-readiness contract.
                return [{"text": "Welcome — I'm your AI travel assistant."}]
            if message == "/guided_continue":
                values = metadata["planner_slot_values"]
                turn_dispatcher = CollectingDispatcher()
                turn_events = ActionApplyGuidedInput().run(
                    turn_dispatcher,
                    FakeTracker(
                        current_slots,
                        {"metadata": metadata},
                        payload["sender"],
                    ),
                    {},
                )
                self.assertEqual(turn_dispatcher.messages, [])
                current_slots.update({
                    event["name"]: event["value"]
                    for event in ActionApplyGuidedInputTests.event_dicts(turn_events)
                })
                requested_slot = (
                    "review_confirmation" if "destination" in values else "destination"
                )
                # The helper must not depend on exact natural-language prompt copy.
                return [{"text": "A form question was returned."}]
            if message == "/confirm_review":
                turn_dispatcher = CollectingDispatcher()
                turn_events = ActionApplyGuidedInput().run(
                    turn_dispatcher,
                    FakeTracker(current_slots, {"metadata": metadata}, payload["sender"]),
                    {},
                )
                self.assertEqual(turn_dispatcher.messages, [])
                current_slots.update({
                    event["name"]: event["value"]
                    for event in ActionApplyGuidedInputTests.event_dicts(turn_events)
                })
                requested_slot = None
                return [{"custom": {"type": "recommendations"}}]
            if message == "/goodbye":
                current_events.append({"event": "action", "name": "utter_goodbye"})
                return [{"text": "You're welcome. Your trip details are unchanged."}]
            if message == "/restart_trip":
                return []
            self.fail(f"Unexpected synthetic warm-up message: {message}")

        output = io.StringIO()
        with patch.object(warmup_rasa, "request_json", side_effect=mock_request_json), \
             patch.object(sys, "argv", ["warmup-rasa.py", "--url", "http://mocked"]), \
             redirect_stdout(output):
            self.assertEqual(warmup_rasa.main(), 0)

        guided_turns = [
            body for body in webhook_bodies
            if body["message"] == "/guided_continue"
        ]
        self.assertEqual(
            guided_turns[0]["metadata"]["planner_slot_values"],
            {"origin": "London"},
        )
        self.assertEqual(
            guided_turns[1]["metadata"]["planner_slot_values"],
            warmup_rasa.PLANNER_CONTEXT,
        )
        self.assertEqual(current_slots["travel_dates"], context["travel_dates"])
        self.assertIsNone(requested_slot)
        self.assertIs(current_slots["review_confirmation"], True)
        self.assertEqual(
            sum(event.get("name") == "utter_goodbye" for event in current_events),
            2,
        )
        self.assertIn("no user-visible latency was measured", output.getvalue())


class ActionValidateReviewTests(unittest.TestCase):
    def setUp(self):
        with action_impl._OPTIONAL_LOOKUP_LOCK:
            action_impl._OPTIONAL_LOOKUP_CACHE.clear()

    def run_action(self, overrides=None):
        slots = {**COMPLETE, **(overrides or {})}
        dispatcher = CollectingDispatcher()
        with patch("actions.actions.road_distance_km", return_value=None), \
             patch("actions.actions.climatiq_estimate", return_value=None), \
             patch.dict("os.environ", {"CLIMATIQ_API_KEY": ""}):
            events = ActionValidateReview().run(dispatcher, FakeTracker(slots), {})
        return dispatcher.messages, events

    @staticmethod
    def event_dicts(events):
        return [event if isinstance(event, dict) else event.as_dict() for event in events]

    def test_complete_review_confirms_and_returns_recommendations(self):
        messages, events = self.run_action()
        self.assertIn(
            {"event": "slot", "timestamp": None, "name": "review_confirmation", "value": True},
            self.event_dicts(events),
        )
        self.assertTrue(any(message.get("custom", {}).get("type") == "recommendations" for message in messages))
        recommendation_message = next(
            message for message in messages
            if message.get("custom", {}).get("type") == "recommendations"
        )
        self.assertIn("Estimated trip footprint:", recommendation_message["text"])
        self.assertIn("footprint", recommendation_message["custom"])
        self.assertTrue(
            any(item["type"] == "stay" for item in recommendation_message["custom"]["items"])
        )
        self.assertTrue(
            any(item["type"] == "experience" for item in recommendation_message["custom"]["items"])
        )
        offset = next(
            item for item in recommendation_message["custom"]["items"]
            if item["type"] == "offset"
        )
        self.assertIn("not emissions erased", offset["description"])
        self.assertIn("mixed-source planning estimate", recommendation_message["text"])

    def test_no_accommodation_does_not_recommend_a_hotel(self):
        messages, _ = self.run_action({"accommodation_need": "none"})
        items = next(message["custom"]["items"] for message in messages if message.get("custom", {}).get("type") == "recommendations")
        self.assertFalse(any(item["type"] == "stay" for item in items))

    def test_experience_recommendation_matches_the_selected_activity_preference(self):
        messages, _ = self.run_action({"activity_preferences": ["outdoor"]})
        experience = next(
            item for message in messages
            for item in message.get("custom", {}).get("items", [])
            if item["type"] == "experience"
        )
        self.assertIn("Outdoor walk", experience["name"])
        self.assertEqual(experience["activity_preference"], "outdoor")

    def test_activity_preference_validation_limits_choices_to_supported_categories(self):
        validation = ValidateTripForm()
        dispatcher = CollectingDispatcher()
        self.assertEqual(
            validation.validate_activity_preferences(["cultural", "nature"], dispatcher, FakeTracker({}), {}),
            {"activity_preferences": ["cultural", "nature"]},
        )
        self.assertEqual(
            validation.validate_activity_preferences(["unsupported"], dispatcher, FakeTracker({}), {}),
            {"activity_preferences": None},
        )

    def test_hostel_preference_does_not_recommend_a_certified_hotel(self):
        messages, _ = self.run_action({"accommodation_need": "budget hostel"})
        items = next(message["custom"]["items"] for message in messages if message.get("custom", {}).get("type") == "recommendations")
        stays = [item for item in items if item["type"] == "stay"]
        self.assertEqual([item["id"] for item in stays], ["stay-category-estimate"])

    def test_missing_required_slot_reenters_form(self):
        messages, events = self.run_action({"budget": None})
        self.assertIn("budget", messages[0]["text"])
        self.assertTrue(any(event.get("event") == "active_loop" and event.get("name") == "trip_form" for event in self.event_dicts(events)))

    def test_manual_mode_requires_approximate_location(self):
        messages, events = self.run_action({"location_mode": "manual", "location": None})
        self.assertIn("approximate location", messages[0]["text"])
        self.assertTrue(any(event.get("event") == "active_loop" for event in self.event_dicts(events)))

    def test_manual_mode_accepts_approximate_location(self):
        _, events = self.run_action({"location_mode": "manual", "location": "Kreuzberg"})
        self.assertTrue(any(event.get("name") == "review_confirmation" and event.get("value") is True for event in self.event_dicts(events)))

    def test_gps_mode_never_requires_or_sets_coordinates(self):
        _, events = self.run_action({"location_mode": "gps", "location": None})
        self.assertFalse(any(event.get("name") == "location" for event in self.event_dicts(events)))
        self.assertTrue(any(event.get("name") == "review_confirmation" and event.get("value") is True for event in self.event_dicts(events)))

    def test_cancel_and_restart_deactivate_active_form(self):
        for action in (ActionCancelTrip(), ActionRestartTrip()):
            events = action.run(CollectingDispatcher(), FakeTracker({}), {})
            event_dicts = self.event_dicts(events)
            self.assertTrue(any(event.get("event") == "active_loop" and event.get("name") is None for event in event_dicts))
            self.assertTrue(any(event.get("event") == "reset_slots" for event in event_dicts))

    def test_footprint_uses_selected_dates_and_party_size(self):
        result = estimate_trip_footprint(
            {"name": "Daytime rail", "carbon_kg": 18.4},
            2,
            "2026-10-12 to 2026-10-15",
            "eco-hotel",
        )
        self.assertEqual(result["nights"], 3)
        self.assertTrue(result["exact_nights"])
        self.assertEqual(result["transport_kg"], 36.8)
        self.assertEqual(result["stay_kg"], 60.0)
        self.assertEqual(result["local_kg"], 9.0)
        self.assertEqual(result["total_kg"], 105.8)
        self.assertIn("property impact unverified", result["stay_label"])

    def test_transport_estimates_change_with_the_selected_route(self):
        with patch.dict("os.environ", {"OPENROUTESERVICE_API_KEY": "", "CLIMATIQ_API_KEY": ""}):
            paris, paris_source = build_transport_options("Berlin (BER)", "Paris (PAR)")
            amsterdam, _ = build_transport_options("Berlin", "Amsterdam")
        self.assertIn("selected cities", paris_source)
        self.assertGreater(paris[0]["carbon_kg"], amsterdam[0]["carbon_kg"])
        self.assertIn("return journey", paris[0]["description"])

    def test_build_transport_options_uses_climatiq_for_each_mode(self):
        with patch("actions.actions.road_distance_km", return_value=None), \
             patch("actions.actions.climatiq_estimate", side_effect=[10.0, 20.0, 30.0]) as estimate, \
             patch.dict("os.environ", {"CLIMATIQ_API_KEY": "test-key"}):
            options, _ = build_transport_options("Berlin", "Paris")
        self.assertEqual([option["carbon_kg"] for option in options], [10.0, 20.0, 30.0])
        self.assertEqual(estimate.call_count, 3)
        self.assertTrue(all(option["source"].startswith("Climatiq estimate") for option in options))
        self.assertTrue(all(
            call.args[1].get("passengers") == 1
            and call.args[1].get("distance_unit") == "km"
            and call.args[1].get("distance", 0) > 0
            for call in estimate.call_args_list
        ))

    def test_climatiq_failure_keeps_explicit_demo_source_per_mode(self):
        with patch("actions.actions.road_distance_km", return_value=None), \
             patch("actions.actions.climatiq_estimate", return_value=None), \
             patch.dict("os.environ", {"CLIMATIQ_API_KEY": "test-key"}):
            options, _ = build_transport_options("Berlin", "Paris")
        self.assertTrue(all("Demo estimate (Climatiq unavailable or request failed)" in item["source"] for item in options))

    def test_optional_provider_lookups_share_one_short_wait_budget(self):
        def slow_estimate(*_args):
            time.sleep(0.3)
            return 12.0

        started = time.perf_counter()
        with patch.dict("os.environ", {
            "CLIMATIQ_API_KEY": "test-key",
            "OPENROUTESERVICE_API_KEY": "",
            "PLANNER_OPTIONAL_LOOKUP_BUDGET_MS": "60",
        }), patch("actions.actions.climatiq_estimate", side_effect=slow_estimate) as estimate:
            options, _ = build_transport_options("Lisbon", "Oslo")
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 0.2)
        self.assertEqual(estimate.call_count, 3)
        self.assertTrue(all("Demo estimate (Climatiq unavailable or request failed)" in item["source"] for item in options))

    def test_internal_warmup_never_calls_optional_providers(self):
        tracker = FakeTracker(
            COMPLETE,
            {"metadata": {"planner_internal_warmup": True}},
            "__internal_rasa_warmup__test",
        )
        with patch.dict("os.environ", {
            "CLIMATIQ_API_KEY": "test-key",
            "OPENROUTESERVICE_API_KEY": "test-key",
        }), patch("actions.actions.climatiq_estimate") as climatiq, \
             patch("actions.actions.road_distance_km") as ors:
            dispatcher = CollectingDispatcher()
            ActionFindSustainableOptions().run(dispatcher, tracker, {})
        climatiq.assert_not_called()
        ors.assert_not_called()
        recommendations = next(
            message["custom"]
            for message in dispatcher.messages
            if message.get("custom", {}).get("type") == "recommendations"
        )
        self.assertTrue(all(
            "deliberately skipped for internal readiness warm-up" in item["source"]
            for item in recommendations["items"]
            if item["type"] == "transport"
        ))

    def test_climatiq_estimate_sends_api_request_and_rejects_malformed_estimate(self):
        with patch.dict("os.environ", {"CLIMATIQ_API_KEY": "test-key"}), \
             patch("actions.actions._request_json", return_value={"co2e": 12.5}) as request:
            self.assertEqual(climatiq_estimate("factor-id", {"passengers": 1, "distance": 100, "distance_unit": "km"}), 12.5)
        self.assertEqual(request.call_args.args[:2], ("POST", "https://api.climatiq.io/data/v1/estimate"))
        self.assertEqual(request.call_args.kwargs["data"]["parameters"], {"passengers": 1, "distance": 100, "distance_unit": "km"})
        with patch.dict("os.environ", {"CLIMATIQ_API_KEY": "test-key"}), \
             patch("actions.actions._request_json", return_value={"co2e": "invalid"}):
            self.assertIsNone(climatiq_estimate("factor-id", {"passengers": 1, "distance": 100, "distance_unit": "km"}))

    def test_rank_options_uses_budget_and_stated_transport_preference(self):
        options = [
            {"id": "rail-demo", "carbon_kg": 20, "price_eur": 90},
            {"id": "coach-demo", "carbon_kg": 20, "price_eur": 35},
            {"id": "flight-demo", "carbon_kg": 20, "price_eur": 80},
        ]
        ranked = rank_options(
            options,
            "balanced",
            budget="EUR 100",
            transport_preference="coach",
            travelers=2,
        )
        coach = next(item for item in ranked if item["id"] == "coach-demo")
        rail = next(item for item in ranked if item["id"] == "rail-demo")
        self.assertEqual(coach["preference_fit"], 1.0)
        self.assertEqual(rail["preference_fit"], 0.0)
        self.assertEqual(coach["budget_fit"], 1.0)
        self.assertEqual(rail["budget_fit"], 0.2)
        self.assertEqual(ranked[0]["id"], "coach-demo")

    def test_recommendation_footprint_uses_ranked_preferred_transport(self):
        options = [
            {"id": "rail-demo", "type": "transport", "name": "Rail", "carbon_kg": 20, "price_eur": 50},
            {"id": "coach-demo", "type": "transport", "name": "Coach", "carbon_kg": 24, "price_eur": 25},
            {"id": "flight-demo", "type": "transport", "name": "Flight", "carbon_kg": 200, "price_eur": 100},
        ]
        slots = {**COMPLETE, "transport_preference": "coach", "budget": "EUR 500"}
        dispatcher = CollectingDispatcher()
        with patch("actions.actions.build_transport_options", return_value=(options, "test route source")), \
             patch("actions.actions.curated_stays", return_value=[]):
            ActionFindSustainableOptions().run(dispatcher, FakeTracker({**slots, "review_confirmation": True}), {})
        recommendation = next(message["custom"] for message in dispatcher.messages if message.get("custom", {}).get("type") == "recommendations")
        self.assertEqual(recommendation["footprint"]["transport_name"], "Coach")

    def test_stays_are_destination_specific_with_no_invented_quote(self):
        paris = curated_stays("Paris (PAR)", 39.0)
        self.assertEqual(len(paris), 2)
        self.assertTrue(all(stay["price_eur"] is None for stay in paris))
        self.assertTrue(all(stay["source"].startswith("https://") for stay in paris))
        self.assertTrue(all(stay["verified_at"] == "2026-09-29" for stay in paris))
        self.assertEqual(curated_stays("Unknown city", 39.0), [])
        for city in ("Amsterdam", "Berlin", "Barcelona", "Copenhagen", "Lisbon", "Prague"):
            self.assertTrue(curated_stays(city, 39.0), city)

    def test_road_routing_uses_new_heigit_endpoint_and_does_not_expose_key(self):
        start, end = (52.52, 13.405), (48.8566, 2.3522)
        _cache.clear()
        with patch.dict("os.environ", {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch("actions.route_distance.requests.post") as post:
            post.return_value.json.return_value = {"routes": [{"summary": {"distance": 1000000}}]}
            self.assertEqual(road_distance_km(start, end), 1000)
            self.assertEqual(post.call_args.args[0], "https://api.heigit.org/openrouteservice/v2/directions/driving-car")
            self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "test-key")

    def test_road_routing_falls_back_on_provider_failure(self):
        with patch.dict("os.environ", {"OPENROUTESERVICE_API_KEY": "test-key"}), \
             patch("actions.route_distance.requests.post", side_effect=__import__("requests").Timeout):
            self.assertIsNone(road_distance_km((1, 2), (3, 4)))


if __name__ == "__main__":
    unittest.main()