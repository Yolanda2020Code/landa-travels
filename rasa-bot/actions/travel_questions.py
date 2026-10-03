"""Contextual travel FAQs handled by a Rasa action, not a frontend trip parser."""
from rasa_sdk import Action
from rasa_sdk.events import SlotSet

CLARIFICATIONS = {
    "origin": "Origin means the city or region you will leave from. I don't need your exact home address.",
    "destination": "Destination means the city or region you want to visit. Include its country if the name is ambiguous.",
    "travel_dates": "Please give departure and return dates, or an approximate period. Exact dates are needed for dated quotes.",
    "travelers": "How many people are travelling? Include adults and children, but not pets in the passenger count.",
    "budget": "I mean your total trip budget for everyone travelling, including transport and accommodation. Give an amount and currency, for example USD 500 or EUR 1,000. Estimates may not cover every expense; I won't treat a missing price as free.",
    "transport_preference": "Choose rail, coach, flight, or compare all. A preference is not a guarantee that a route is available.",
    "accommodation_need": "Tell me the kind of stay you want. Certification, vegan meals and pet policies need separate verification.",
    "accessibility_need": "Tell me functional access requirements such as step-free access. You do not need to disclose a diagnosis.",
    "sustainability_level": "Climate-first prioritises lower estimated emissions; balanced also considers price; comfort-first gives convenience more weight.",
    "activity_preferences": "Choose cultural, outdoor or relaxed activities, or describe an interest. Availability may be unverified.",
    "location_mode": "Location sharing is optional. You can enter an approximate city, explicitly allow approximate GPS, or skip it.",
    "location": "A city or region is enough. Please do not share an exact home address.",
    "review_confirmation": "Check the collected trip details before I compare options. You can correct a detail without restarting.",
}


class ActionAnswerTravelQuestion(Action):
    def name(self):
        return "action_answer_travel_question"

    def run(self, dispatcher, tracker, domain):
        intent = tracker.latest_message.get("intent", {}).get("name")
        origin, destination = tracker.get_slot("origin"), tracker.get_slot("destination")
        events = []
        # Entity-bearing FAQs must interrupt the form rather than be swallowed
        # as slot answers. Validate their NLU entities here; never overwrite an
        # existing trip or invalidate a confirmed recommendation snapshot.
        from .actions import ValidateTripForm
        values = {}
        for entity in tracker.latest_message.get("entities", []):
            name = entity.get("entity")
            if name not in {"origin", "destination", "budget"}:
                continue
            result = getattr(ValidateTripForm(), f"validate_{name}")(
                entity.get("value"), dispatcher, tracker, domain)
            if result.get(name) is not None:
                values[name] = result[name]
                if not tracker.get_slot(name) and not tracker.get_slot("review_confirmation"):
                    events.append(SlotSet(name, result[name]))
        origin = values.get("origin", origin)
        destination = values.get("destination", destination)
        if intent == "ask_eco_travel":
            answer = ("Responsible travel aims to reduce avoidable emissions, respect local communities and nature, and make informed choices. "
                      "Transport, distance, stay length and activities all matter. A certification or an offset does not make a trip impact-free. "
                      "I compare approximate footprints and explain where evidence or prices are missing.")
        elif intent == "ask_guided_help":
            answer = ("Guided input means answering one trip question at a time using the controls in the chat. "
                      "You can also type one answer or several trip details together. I keep your answers in this "
                      "Rasa conversation, and you can correct a detail without starting again.")
        elif intent == "ask_clarification":
            answer = CLARIFICATIONS.get(tracker.get_slot("requested_slot"),
                                       "I can help with destination, dates, budget, transport and sustainability preferences. Which part would you like explained?")
        elif intent == "ask_vegan_hotels":
            answer = ("I can record a vegan-friendly accommodation preference, but I don't have a verified vegan-hotel "
                      "or menu feed. Eco-certification alone does not prove that a hotel is vegan. Confirm meals and policies "
                      "directly with the property; an advisor can help verify them. "
                      + (f"Your requested stay is in {destination}. " if destination else "")
                      + "Continue with the guided trip question below, or ask an advisor to verify a property's vegan options.")
            events += [SlotSet("accommodation_need", "vegan"), SlotSet("review_confirmation", None)]
        elif intent == "ask_destination_ideas":
            budget = values.get("budget", tracker.get_slot("budget"))
            answer = (f"Your stated budget is {budget}. " if budget else "") + (
                "A nearby rail or coach trip, fewer transfers and a longer stay in one place are useful lower-impact starting points. "
                "A destination is not inherently 'sustainable': the route, transport, stay and activities matter. "
                "I can't guarantee a complete trip within that budget without dates and verified prices. ")
            answer += (f"From {origin}, I can compare nearby destinations once you give the trip length and dates."
                       if origin else "Which city will you leave from, and is that budget for the whole party?")
        elif intent in {"ask_transport_comparison", "ask_carbon_footprint"}:
            if not origin or not destination:
                answer = ("To estimate a flight's footprint I need the departure city and a specific arrival city, "
                          "plus whether it is one-way or return and the passenger count. I won't invent a distance or emissions value. "
                          + ("Where will you fly from?" if not origin else "Which city will you arrive in?"))
            elif str(origin).strip().casefold() == str(destination).strip().casefold():
                answer = "The departure and arrival cities are the same. Please give two different cities; I won't treat a zero-distance flight as a meaningful comparison."
            else:
                # Import lazily: this module is also discovered by the Rasa SDK.
                from .actions import CITY_COORDINATES, _city_key, build_transport_options
                if _city_key(origin) not in CITY_COORDINATES or _city_key(destination) not in CITY_COORDINATES:
                    answer = (f"I can't calculate a defensible route distance for {origin} → {destination} from my current coverage. "
                              "Please specify the cities/airports; a country name is too broad. I won't use an illustrative distance as your actual footprint.")
                else:
                    options, distance_source = build_transport_options(origin, destination)
                    selected = options if intent == "ask_transport_comparison" else [o for o in options if "flight" in o["id"]]
                    details = "; ".join(f'{o["name"]}: approximately {o["carbon_kg"]:.1f} kg CO₂e ({o.get("source", "labelled planning factor")})' for o in selected)
                    answer = (f"For {origin} → {destination}, a return-journey comparison for one passenger is: {details}. "
                              f"Distance basis: {distance_source}. These are approximate modelled estimates, not measured emissions or schedules. "
                              "Convenience depends on actual timetables and connections. "
                              "No price or availability is guaranteed; offsets do not erase these emissions.")
        else:
            answer = "I can explain a planning question without changing your trip. What would you like to know?"
        dispatcher.utter_message(text=answer, buttons=[
            {"title": "Continue guided planning", "payload": "/guided_continue"},
            {"title": "Ask a travel advisor", "payload": "/request_handover"},
        ])
        return events