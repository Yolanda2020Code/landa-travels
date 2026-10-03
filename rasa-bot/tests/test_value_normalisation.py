import pytest
from travel_nlu.value_normalisation import normalise_dates, normalise_budget


@pytest.mark.parametrize("value, expected", [
    ("2027-02-02–2027-02-08", "2027-02-02 to 2027-02-08"),
    ("from 5 May 2027 to 9 May 2027", "2027-05-05 to 2027-05-09"),
    ("5–9 May 2027", "2027-05-05 to 2027-05-09"),
    ("04/06/2027 to 07/06/2027", "2027-06-04 to 2027-06-07"),
    ("July 3rd, 2027 through July 6th, 2027", "2027-07-03 to 2027-07-06"),
    ("next weekend", "next weekend"),
    ("5 May to 9 May", "5 May to 9 May"),
    ("2027-07-03 to flexible return", "2027-07-03 to flexible return"),
])
def test_exact_dates_without_inventing_missing_information(value, expected):
    assert normalise_dates(value) == expected


@pytest.mark.parametrize("value", [
    "2027-02-30 to 2027-03-04", "2027-07-03 to 2027-06-28",
    "31 April 2027 to 4 May 2027", "20–12 May 2027",
    "April 31 2027 to May 4 2027",
])
def test_invalid_and_reversed_exact_dates_fail(value):
    with pytest.raises(ValueError):
        normalise_dates(value)


@pytest.mark.parametrize("value, expected", [
    ("two thousand euros", "EUR 2000"), ("GBP Five hundred", "GBP 500"),
    ("£600", "GBP 600"), ("USD 1,500", "USD 1,500"),
    ("under EUR 700", "under EUR 700"), ("flexible", "flexible"),
])
def test_explicit_budget_normalisation(value, expected):
    assert normalise_budget(value) == expected


@pytest.mark.parametrize("value", ["EUR -90", "-€90", "-90 euros", "minus five hundred pounds"])
def test_negative_budget_is_not_misread_as_positive(value):
    with pytest.raises(ValueError):
        normalise_budget(value)


def test_form_owns_normalisation_and_rejects_bad_values():
    from actions.actions import ValidateTripForm
    from rasa_sdk.executor import CollectingDispatcher
    from datetime import date, timedelta
    form = ValidateTripForm()
    dispatcher = CollectingDispatcher()
    year = date.today().year + 2
    assert form.validate_travel_dates(f"5 May {year} to 9 May {year}", dispatcher, None, {}) == {
        "travel_dates": f"{year}-05-05 to {year}-05-09"}
    assert form.validate_budget("two thousand euros", dispatcher, None, {}) == {"budget": "EUR 2000"}
    assert form.validate_travel_dates("31 April 2027 to 4 May 2027", dispatcher, None, {}) == {
        "travel_dates": None}
    assert form.validate_budget("GBP -100", dispatcher, None, {}) == {"budget": None}
    yesterday = date.today() - timedelta(days=1)
    assert form.validate_travel_dates(f"{yesterday} to flexible return", dispatcher, None, {}) == {
        "travel_dates": None}
    assert form.validate_travel_dates(str(yesterday), dispatcher, None, {}) == {"travel_dates": None}
    assert len(dispatcher.messages) == 4


def test_unanswered_fields_do_not_emit_validation_errors_on_form_start():
    from actions.actions import ValidateTripForm
    from rasa_sdk.executor import CollectingDispatcher
    form = ValidateTripForm()
    dispatcher = CollectingDispatcher()
    for field in ("origin", "destination", "travelers", "travel_dates", "budget",
                  "transport_preference", "accessibility_need", "accommodation_need",
                  "sustainability_level", "activity_preferences", "location_mode",
                  "stopovers", "location"):
        assert getattr(form, "validate_" + field)(None, dispatcher, None, {}) == {field: None}
    assert dispatcher.messages == []