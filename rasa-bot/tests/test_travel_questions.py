import unittest
from unittest.mock import patch
from rasa_sdk.executor import CollectingDispatcher
from actions.actions import ActionFindSustainableOptions, ActionReviewDenial, ValidateTripForm
from actions.travel_questions import ActionAnswerTravelQuestion
from travel_nlu.entity_rules import extract_travel_entities


class Tracker:
    def __init__(self, intent="inform", **slots):
        self.slots = slots
        self.latest_message = {"intent": {"name": intent}, "entities": []}
    def get_slot(self, name):
        return self.slots.get(name)


class TravelQuestionsTests(unittest.TestCase):
    def answer(self, intent, **slots):
        dispatcher = CollectingDispatcher()
        events = ActionAnswerTravelQuestion().run(dispatcher, Tracker(intent, **slots), {})
        return dispatcher.messages[0]["text"], events

    def test_budget_clarification_uses_current_slot(self):
        text, _ = self.answer("ask_clarification", requested_slot="budget")
        self.assertIn("total trip budget", text)
        self.assertIn("currency", text)

    def test_count_clarification_excludes_pets(self):
        text, _ = self.answer("ask_clarification", requested_slot="travelers")
        self.assertIn("not pets", text)

    def test_vegan_is_not_inferred_from_eco_certification(self):
        text, events = self.answer("ask_vegan_hotels")
        self.assertIn("does not prove", text)
        self.assertIn("don't have a verified", text)
        self.assertTrue(any(e.get("name") == "accommodation_need" and e.get("value") == "vegan" for e in events))

    def test_vegan_question_keeps_its_explicit_destination(self):
        tracker = Tracker("ask_vegan_hotels", requested_slot="origin")
        tracker.latest_message["entities"] = [{"entity": "destination", "value": "Paris"}]
        dispatcher = CollectingDispatcher()
        events = ActionAnswerTravelQuestion().run(dispatcher, tracker, {})
        self.assertTrue(any(e.get("name") == "destination" and e.get("value") == "Paris" for e in events))
        self.assertIn("guided trip question", dispatcher.messages[0]["text"])
        self.assertNotIn("Which area", dispatcher.messages[0]["text"])

    def test_carbon_without_origin_never_invents_a_value(self):
        text, _ = self.answer("ask_carbon_footprint", destination="Thailand")
        self.assertIn("Where will you fly from", text)
        self.assertNotIn("kg", text)

    def test_country_route_never_uses_demo_distance_as_actual(self):
        with patch("actions.actions.build_transport_options") as build:
            text, _ = self.answer("ask_carbon_footprint", origin="London", destination="Thailand")
        build.assert_not_called()
        self.assertIn("country name is too broad", text)

    def test_comparison_labels_source_return_basis_and_no_guarantees(self):
        options = [{"id": "rail-demo", "name": "Rail", "carbon_kg": 20, "source": "Demo estimate"},
                   {"id": "flight-demo", "name": "Flight", "carbon_kg": 120, "source": "Climatiq estimate"}]
        with patch("actions.actions.build_transport_options", return_value=(options, "great-circle proxy")):
            text, _ = self.answer("ask_transport_comparison", origin="London", destination="Paris")
        for term in ["return-journey", "one passenger", "Demo estimate", "Climatiq", "No price or availability"]:
            self.assertIn(term, text)

    def test_destination_ideas_preserve_currency_and_do_not_guarantee_cost(self):
        text, _ = self.answer("ask_destination_ideas", budget="USD 500")
        self.assertIn("USD 500", text)
        self.assertIn("can't guarantee", text)
        self.assertIn("Which city", text)

    def test_pronoun_correction_has_destination_entity(self):
        entities = extract_travel_entities("actually make it Norway")
        self.assertTrue(any(e["entity"] == "destination" and e["value"] == "Norway" for e in entities))

    def test_multiple_stopovers_remain_supported(self):
        entities = extract_travel_entities("from London to Paris via Amsterdam and Berlin")
        self.assertEqual([e["value"] for e in entities if e["entity"] == "stopover"], ["Amsterdam", "Berlin"])

    def test_missing_route_cannot_generate_recommendations(self):
        dispatcher = CollectingDispatcher()
        with patch("actions.actions.build_transport_options") as build:
            events = ActionFindSustainableOptions().run(dispatcher, Tracker(), {})
        build.assert_not_called()
        self.assertTrue(any(e.get("event") == "followup" for e in events))

    def test_unconfirmed_context_cannot_search(self):
        dispatcher = CollectingDispatcher()
        with patch("actions.actions.build_transport_options") as build:
            ActionFindSustainableOptions().run(dispatcher, Tracker(origin="London", destination="Paris"), {})
        build.assert_not_called()
        self.assertIn("confirm", dispatcher.messages[0]["text"])

    def test_question_route_does_not_overwrite_an_existing_confirmed_trip(self):
        tracker = Tracker("ask_transport_comparison", origin="Berlin", destination="Paris", review_confirmation=True)
        tracker.latest_message["entities"] = [
            {"entity": "origin", "value": "London"}, {"entity": "destination", "value": "Amsterdam"}]
        dispatcher = CollectingDispatcher()
        options = [{"id": "rail-demo", "name": "Rail", "carbon_kg": 20, "source": "Demo estimate"}]
        with patch("actions.actions.build_transport_options", return_value=(options, "proxy")):
            events = ActionAnswerTravelQuestion().run(dispatcher, tracker, {})
        self.assertEqual(events, [])
        self.assertIn("London", dispatcher.messages[0]["text"])
        self.assertEqual(tracker.get_slot("origin"), "Berlin")

    def test_repeated_no_pauses_without_clearing_trip(self):
        dispatcher = CollectingDispatcher()
        events = ActionReviewDenial().run(dispatcher, Tracker(consecutive_denials=2, origin="London", destination="Paris"), {})
        self.assertIn("paused", dispatcher.messages[0]["text"])
        self.assertFalse(any(e.get("event") == "reset_slots" for e in events))
        self.assertTrue(any(e.get("event") == "active_loop" and e.get("name") is None for e in events))

    def test_ambiguous_destination_requires_region(self):
        dispatcher = CollectingDispatcher()
        slots = ValidateTripForm().validate_destination("Springfield", dispatcher, Tracker(), {})
        self.assertIsNone(slots["destination"])
        self.assertTrue(slots["destination_ambiguity"])
        self.assertIn("Which Springfield", dispatcher.messages[0]["text"])