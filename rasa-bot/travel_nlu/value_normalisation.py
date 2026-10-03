"""Normalize explicit values only; never invent missing years or return dates."""

import re
from datetime import datetime


def _explicit_date(value):
    value = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", value.strip(), flags=re.I)
    value = re.sub(r",", "", value)
    formats = ["%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%d %B %Y",
               "%d %b %Y", "%B %d %Y", "%b %d %Y"]
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    if re.search(r"\b20\d{2}\b", value) and (
            re.search(r"\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}", value)
            or (len(re.findall(r"\d+", value)) >= 2 and re.search(r"(?:January|February|March|April|May|June|July|August|"
                         r"September|October|November|December|Jan|Feb|Mar|Apr|Jun|"
                         r"Jul|Aug|Sep|Sept|Oct|Nov|Dec)", value, re.I))):
        raise ValueError("Invalid explicit calendar date")
    return None


def normalise_dates(value):
    cleaned = re.sub(r"^from\s+", "", value.strip(), flags=re.I)
    iso = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\s*(?:to|through|until|–|—|-)\s*"
                       r"(\d{4}-\d{2}-\d{2}|flexible return)", cleaned, re.I)
    compact = re.fullmatch(r"(\d{1,2})\s*(?:to|until|through|–|—|-)\s*"
                           r"(\d{1,2}\s+[A-Za-z]+\s+20\d{2})", cleaned, re.I)
    if iso:
        left, right = iso.groups()
    elif compact:
        day, right = compact.groups()
        left = day + " " + right.split(" ", 1)[1]
    else:
        parts = re.split(r"\s+(?:to|through|until)\s+|\s*[–—]\s*", cleaned, maxsplit=1, flags=re.I)
        if len(parts) == 1:
            parsed = _explicit_date(cleaned)
            return parsed.isoformat() if parsed else value
        left, right = parts
    start = _explicit_date(left)
    if right.casefold() == "flexible return":
        return f"{start.isoformat()} to flexible return" if start else value
    end = _explicit_date(right)
    if start and end:
        if end < start:
            raise ValueError("Return precedes departure")
        return f"{start.isoformat()} to {end.isoformat()}"
    return value


def normalise_budget(value):
    units = dict(zip("one two three four five six seven eight nine ten".split(), range(1, 11)))
    currency = r"(EUR|GBP|USD|CHF|CAD|AUD|euros?|pounds?|dollars?|[€£$])"
    if re.match(r"^\s*(?:minus\b|negative\b|-\s*(?:[€£$]|\d|(?:EUR|GBP|USD|CHF|CAD|AUD)\b))", value, re.I):
        raise ValueError("Budget cannot be negative")
    amount = r"(-?\d+(?:[,.]\d+)*|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hundred|thousand))"
    match = re.fullmatch(rf"(?:{currency}\s*{amount}|{amount}\s*{currency})", value.strip(), re.I)
    if not match:
        return value
    before_currency, before_amount, after_amount, after_currency = match.groups()
    raw_currency = (before_currency or after_currency).lower()
    raw_amount = before_amount or after_amount
    if raw_amount.startswith("-"):
        raise ValueError("Budget cannot be negative")
    if raw_amount.lower().split()[0] in units:
        count, scale = raw_amount.lower().split()
        amount = str(units[count] * (100 if scale == "hundred" else 1000))
    else:
        # Leave ambiguous decimal/thousands punctuation to the existing money
        # parser; normalization must not silently change the amount.
        amount = raw_amount
    code = {"€": "EUR", "£": "GBP", "$": "USD", "euro": "EUR", "euros": "EUR",
            "pound": "GBP", "pounds": "GBP", "dollar": "USD", "dollars": "USD"}.get(
                raw_currency, raw_currency.upper())
    return f"{code} {amount}"