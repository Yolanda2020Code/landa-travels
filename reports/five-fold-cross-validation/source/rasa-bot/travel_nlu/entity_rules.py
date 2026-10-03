"""Conservative span extraction; never infer a place or value absent from text."""

import re

NUMBER = r"(?:(?<![\w.,+-])\d{1,2}(?![\d.,])|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)"
DAY = r"\d{1,2}(?:st|nd|rd|th)?"
YEAR = r"(?:\s*,?\s*20\d{2})?"
DATE = rf"(?:20\d{{2}}-\d{{2}}-\d{{2}}|\d{{1,2}}[/.]\d{{1,2}}[/.]20\d{{2}}|{DAY}\s+{MONTH}{YEAR}|{MONTH}\s+{DAY}{YEAR})"
DATE_PATTERNS = [
    rf"\b{DATE}\s*(?:to|through|until|–|—|-)\s*{DATE}\b",
    rf"\b{DAY}\s*(?:to|through|until|–|-)\s*{DAY}\s+{MONTH}{YEAR}\b",
    rf"\b(?:from\s+)?{DATE}\s+(?:to|through|until)\s+{DAY}\b",
    rf"\b{DATE}\b",
    r"\b(?:the\s+)?(?:weekend|week|month)\s+after\s+next\b",
    r"\b(?:next|this)\s+(?:weekend|week|month|summer|winter|spring|autumn)\b",
    r"\b(?:during\s+)?(?:Easter|Christmas)\s+(?:week|weekend|holiday)\b",
    r"\b(?:this|next)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b",
    r"\b(?:today|tomorrow)\b",
]
CURRENCY = r"(?:EUR|GBP|USD|CHF|CAD|AUD|euros?|pounds?|dollars?)"
AMOUNT = r"(?:-?\d+(?:[,.]\d{3})*(?:[,.]\d{1,2})?|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hundred|thousand))"
BUDGET_PATTERN = rf"(?<!\w)(?:(?:minus|negative)\s+)?(?:-?[€£$]\s*{AMOUNT}|{CURRENCY}\s+{AMOUNT}|{AMOUNT}\s+{CURRENCY})\b"
ROUTE_CUES = [
    ("origin", r"\b(?:origin|departure\s+(?:city|point))\s+(?:is|as|to)\s+"),
    ("origin", r"\b(?:from|leaving|departing(?:\s+from)?|depart\s+from|start(?:ing)?\s+(?:at|in)|begin(?:ning)?\s+in)\s+"),
    ("stopover", r"\b(?:via|stop(?:over)?(?:ping)?\s+(?:at|in)|change\s+in|connection\s+(?:in|through)|by\s+way\s+of|break\s+(?:the\s+)?journey\s+in)\s+"),
    ("destination", r"\b(?:destination|arrival\s+city)\s+(?:is|as|to)\s+"),
    ("destination", r"\b(?:to|towards|heading\s+(?:to|for)|going\s+to|arriv(?:e|ing)\s+in|end(?:ing)?(?:\s+up)?\s+in|finish(?:ing)?\s+in|visit)\s+"),
]
PLACE_STOP = re.compile(
    r"\s+(?:to|via|from|and|with|for|on|during|between|then|instead|please|by|before|after|in\s+the|as\s+the)\b|[,;.!?]|\s+\d",
    re.I,
)
NON_PLACES = {"home", "work", "school", "somewhere", "anywhere", "there", "here",
              "travel", "spend", "book", "plan", "go", "a", "the", "my", "your",
              "next", "this", "under", "about", "roughly"}
NUMBER_VALUES = dict(zip(
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(),
    range(1, 21),
))
TRAVEL_LABELS = {"origin", "destination", "stopover", "travel_dates", "budget", "travelers"}
TRIP_LABELS = TRAVEL_LABELS | {
    "transport_preference", "accommodation_need", "accessibility_need",
    "sustainability_level", "activity_preference", "location", "location_mode", "review_confirmation",
}
NON_PLANNING_INTENTS = {"greet", "goodbye", "out_of_scope", "nonsense", "prompt_injection", "nlu_fallback"}


def merge_travel_entities(text, learned, extracted, intent):
    """Don't let rejected/off-topic messages or punctuation become trip slots."""
    if intent in NON_PLANNING_INTENTS:
        return [e for e in learned if e.get("entity") not in TRIP_LABELS]
    retained = []
    for entity in learned:
        start, end = entity.get("start", -1), entity.get("end", -1)
        if (entity.get("entity") == "accommodation_need" and
                str(entity.get("value", "")).lower() == "budget" and
                any(e["entity"] == "budget" for e in extracted) and
                not re.search(r"\bhotel|hostel|lodging|accommodation|stay\b", text, re.I)):
            continue
        if entity.get("entity") in TRAVEL_LABELS:
            if not 0 <= start < end <= len(text) or not any(c.isalnum() for c in text[start:end]):
                continue
        # A learned label is not evidence that an arbitrary word is a date or
        # party size. Preserve standalone slot answers and plausible language,
        # while excluding cross-role numeric fragments and unrelated nouns.
        if entity.get("entity") == "travelers":
            value = normalise_travellers(entity.get("value"))
            if not isinstance(value, int):
                continue
            standalone = bool(re.fullmatch(
                rf"\s*(?:(?:just|only)\s+)?{NUMBER}(?:\s+(?:please|thanks))?[ .!?]*", text, re.I))
            if not standalone and not any(e["entity"] == "travelers" for e in extracted):
                continue
        if entity.get("entity") == "travel_dates":
            raw = text[start:end]
            if not re.search(
                    rf"{DATE}|\b{MONTH}\b|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|"
                    r"weekends?|weeks?|months?|summer|winter|spring|autumn|fall|today|tomorrow|"
                    r"Easter|Christmas|flexible)\b", raw, re.I):
                continue
        if not any(start < new["end"] and end > new["start"] for new in extracted):
            retained.append(dict(entity))
    result = retained + extracted
    for entity in result:
        if entity.get("entity") == "travelers":
            entity["value"] = normalise_travellers(entity.get("value"))
    return result


def normalise_travellers(value):
    """Resolve written counts/party composition; leave unknown input to validation."""
    text = str(value).strip().lower()
    if text.isdigit():
        return int(text)
    if text in NUMBER_VALUES:
        return NUMBER_VALUES[text]
    party = re.fullmatch(
        rf"({NUMBER})\s+adults?\s*(?:and|plus|,|&)\s*({NUMBER})\s+(?:children|child)", text, re.I)
    if party:
        return sum(int(part) if part.isdigit() else NUMBER_VALUES[part.lower()] for part in party.groups())
    return value


def extract_travel_entities(text, place_spans=(), date_spans=()):
    """Return exact text spans; spaCy places supply grounding, cues supply roles."""
    found = []

    def add(label, start, end):
        if label == "travelers":
            # Do not turn an invalid negative/ranged count into a positive
            # fragment, such as the final digit in "-3" or "three or five".
            before = text[:start]
            after = text[end:]
            if (re.search(rf"(?:minus|negative|{NUMBER}\s+(?:to|or))\s*$", before, re.I)
                    or re.match(rf"\s+(?:people|adults?|travell?ers?)?\s*(?:to|or)\s+{NUMBER}\b",
                                after, re.I)):
                return
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if end <= start or any(start < e["end"] and end > e["start"] for e in found):
            return
        found.append({"entity": label, "start": start, "end": end,
                      "value": text[start:end], "confidence_entity": 1.0})

    # Longer ranges take precedence over their individual date fragments.
    for pattern in DATE_PATTERNS:
        for match in re.finditer(pattern, text, re.I):
            add("travel_dates", match.start(), match.end())
    for start, end in date_spans:
        value = text[start:end]
        # Never turn a year, age, amount, or arbitrary ordinal into travel dates.
        if re.search(rf"\b{MONTH}\b|week|month|weekend|tomorrow|today|Easter|Christmas", value, re.I):
            add("travel_dates", start, end)

    for match in re.finditer(BUDGET_PATTERN, text, re.I):
        add("budget", match.start(), match.end())

    party = rf"\b(?P<value>{NUMBER}\s+adults?\s*(?:and|plus|,|&)\s*{NUMBER}\s+(?:children|child))\b"
    for match in re.finditer(party, text, re.I):
        add("travelers", match.start("value"), match.end("value"))
    people_patterns = [
        rf"\b(?P<value>{NUMBER})\s+(?:adult(?:s)?|travell?ers?|passengers?|people|persons?|of\s+us)\b",
        rf"\b(?:party|group)\s+of\s+(?P<value>{NUMBER})\b",
        rf"\b(?:there\s+are|there\s+will\s+be|we\s+are|we['’]re)\s+(?P<value>{NUMBER})\b",
    ]
    for pattern in people_patterns:
        for match in re.finditer(pattern, text, re.I):
            add("travelers", match.start("value"), match.end("value"))

    for label, pattern in ROUTE_CUES:
        for cue in re.finditer(pattern, text, re.I):
            start = cue.end()
            stop = PLACE_STOP.search(text, start)
            limit = stop.start() if stop else len(text)
            # Prefer the language model's geographical spans, including lowercase.
            grounded = [(s, e) for s, e in place_spans if s == start and e <= limit]
            # A geographical tag may cover only a prefix of a multiword name.
            # Preserve a complete explicitly supplied proper name when possible.
            candidate = text[start:limit].strip()
            words = candidate.split()
            complete_name = (
                1 <= len(words) <= 5
                and all(w[:1].isupper() or w.lower() in {"de", "del", "la", "le", "du", "am", "upon", "and"}
                        for w in words)
                and all(re.fullmatch(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*", w) for w in words)
            )
            if complete_name:
                end = start + len(text[start:limit].rstrip())
            elif grounded:
                _, end = max(grounded, key=lambda pair: pair[1])
            else:
                continue
            value = text[start:end]
            if value.lower().split()[0] in NON_PLACES or re.fullmatch(rf"{MONTH}", value, re.I):
                continue
            add(label, start, end)
            # One explicit via cue can introduce several intermediate cities.
            if label == "stopover":
                for _ in range(4):
                    connector = re.match(r"\s*(?:,|and)\s+", text[end:], re.I)
                    if not connector:
                        break
                    next_start = end + connector.end()
                    stop = PLACE_STOP.search(text, next_start)
                    next_limit = stop.start() if stop else len(text)
                    name = text[next_start:next_limit].strip()
                    parts = name.split()
                    if not (1 <= len(parts) <= 5 and
                            all(p[:1].isupper() or p.lower() in {"de", "del", "la", "le", "du", "am", "upon"}
                                for p in parts) and
                            all(re.fullmatch(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*", p) for p in parts)):
                        break
                    if parts[0].lower() in NON_PLACES or re.fullmatch(MONTH, name, re.I):
                        break
                    end = next_start + len(text[next_start:next_limit].rstrip())
                    add(label, next_start, end)
    # Destination corrections need not repeat the word "destination".
    correction = re.search(r"\b(?:actually\s+)?(?:make it|switch (?:it )?to|change (?:it )?to)\s+", text, re.I)
    if correction:
        start = correction.end()
        candidate = re.sub(r"\s+(?:instead|please)[.!?]?$", "", text[start:]).strip().rstrip(".!?")
        grounded = any(s == start and e >= start + len(candidate) for s, e in place_spans)
        proper = bool(re.fullmatch(r"[A-Z][^\W\d_]+(?:\s+[A-Z][^\W\d_]+){0,3}", candidate))
        if grounded or proper:
            add("destination", start, start + len(candidate))
    return sorted(found, key=lambda entity: entity["start"])