from travel_nlu.entity_rules import extract_travel_entities, normalise_travellers, merge_travel_entities


def values(text, **kwargs):
    return [(e["entity"], e["value"]) for e in extract_travel_entities(text, **kwargs)]


def test_route_roles_and_multiword_places():
    assert values("from New York via Montréal to Buenos Aires") == [
        ("origin", "New York"), ("stopover", "Montréal"), ("destination", "Buenos Aires")]


def test_correction_and_preserving_exact_span():
    assert values("change my origin to Cape Town instead") == [("origin", "Cape Town")]


def test_grounded_lowercase_place():
    assert values("from dublin to london", place_spans=[(5, 11), (15, 21)]) == [
        ("origin", "dublin"), ("destination", "london")]


def test_date_range_is_one_entity_not_route():
    assert values("from 2027-01-10 to 2027-01-15") == [
        ("travel_dates", "2027-01-10 to 2027-01-15")]


def test_budget_and_party_do_not_conflict():
    assert values("two adults and one child with USD 2,500") == [
        ("travelers", "two adults and one child"), ("budget", "USD 2,500")]


def test_composed_group():
    assert values("three adults and two children") == [("travelers", "three adults and two children")]


def test_no_hallucination_from_nontravel_text():
    for text in ["I want to save money", "from home to work", "I am 27 years old",
                 "I want somewhere affordable", "the price is unavailable", "hello"]:
        assert values(text) == []


def test_written_budget_and_month_dates():
    assert values("two thousand euros for 5 April 2027") == [
        ("budget", "two thousand euros"), ("travel_dates", "5 April 2027")]


def test_ranges_and_traveller_counts():
    assert values("4 travellers on 8 to 12 November 2026") == [
        ("travelers", "4"), ("travel_dates", "8 to 12 November 2026")]


def test_traveller_values_are_usable_by_rasa_float_slot():
    assert normalise_travellers("five") == 5
    assert normalise_travellers("2 adults and one child") == 3
    assert normalise_travellers("three adults plus two children") == 5
    assert normalise_travellers("unknown") == "unknown"
    assert normalise_travellers("21") == 21  # Real form validator enforces bounds.


def test_off_topic_and_fallback_cannot_change_trip_details():
    text = "to Chicago"
    learned = [{"entity": "origin", "start": 3, "end": 10, "value": "Chicago"}]
    for intent in ["out_of_scope", "nlu_fallback", "nonsense", "prompt_injection", "greet"]:
        assert merge_travel_entities(text, learned, extract_travel_entities(text), intent) == []


def test_punctuation_predictions_removed_and_roles_not_duplicated():
    text = "to Chicago."
    learned = [{"entity": "origin", "start": 3, "end": 10, "value": "Chicago"},
               {"entity": "origin", "start": 10, "end": 11, "value": "."}]
    assert [(e["entity"], e["value"]) for e in merge_travel_entities(
        text, learned, extract_travel_entities(text), "inform")] == [("destination", "Chicago")]


def test_partial_geographical_tag_does_not_truncate_city_name():
    assert values("from Newcastle upon Tyne via Leeds", place_spans=[(5, 14), (29, 34)]) == [
        ("origin", "Newcastle upon Tyne"), ("stopover", "Leeds")]


def test_money_budget_is_not_an_accommodation_preference():
    text = "my budget is GBP 900"
    learned = [{"entity": "accommodation_need", "start": 3, "end": 9, "value": "budget"}]
    assert [(e["entity"], e["value"]) for e in merge_travel_entities(
        text, learned, extract_travel_entities(text), "inform")] == [("budget", "GBP 900")]


def test_unspaced_iso_range_and_relative_dates():
    assert values("2027-02-02–2027-02-08") == [("travel_dates", "2027-02-02–2027-02-08")]
    assert values("depart next Friday") == [("travel_dates", "next Friday")]
    assert values("3 adults, 2 children") == [("travelers", "3 adults, 2 children")]
    assert normalise_travellers("3 adults, 2 children") == 5
    assert values("budget EUR -90") == [("budget", "EUR -90")]


def test_fractional_party_count_does_not_become_its_last_digit():
    assert not any(e["entity"] == "travelers" for e in extract_travel_entities("3.5 people"))
    assert not any(e["entity"] == "travelers" for e in extract_travel_entities("1,5 passengers"))
    for text in ["-3 people", "minus three passengers", "three or five people", "3 to 5 adults"]:
        assert not any(e["entity"] == "travelers" for e in extract_travel_entities(text)), text
    assert values("minus five hundred pounds") == [("budget", "minus five hundred pounds")]


def test_multiple_explicit_stopovers():
    assert values("from Exeter via York, Leeds and Durham to Glasgow") == [
        ("origin", "Exeter"), ("stopover", "York"), ("stopover", "Leeds"),
        ("stopover", "Durham"), ("destination", "Glasgow")]


def test_rejected_message_cannot_change_optional_preferences_either():
    entities = [{"entity": "accommodation_need", "start": 0, "end": 5, "value": "hotel"},
                {"entity": "transport_preference", "start": 6, "end": 11, "value": "train"}]
    assert merge_travel_entities("hotel train", entities, [], "out_of_scope") == []


def test_numeric_words_in_unrelated_text_do_not_fill_party_or_date():
    text = "silver cloud seventeen train"
    learned = [{"entity": "travelers", "start": 13, "end": 22, "value": "seventeen"},
               {"entity": "travel_dates", "start": 23, "end": 28, "value": "train"}]
    assert merge_travel_entities(text, learned, [], "inform") == []
    assert merge_travel_entities("seventeen", [
        {"entity": "travelers", "start": 0, "end": 9, "value": "seventeen"}], [], "inform")[0]["value"] == 17