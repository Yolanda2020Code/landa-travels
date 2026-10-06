# Landa Travels

### A conversational platform for sustainable travel planning

Landa Travels brings transport, accommodation and activities into one planning conversation. Built with Rasa, it helps travellers compare cost, comfort and estimated carbon impact, with clear sources and the option to request human support.

**MSc Artificial Intelligence · Advanced Conversational UI Design and Chatbot Development · 2026**

## Explore the project

| Resource | Link |
|---|---|
| Live application | [Open Landa Travels](https://yolandankala-landa-travels.hf.space) |
| Hugging Face Space | [Application page](https://huggingface.co/spaces/yolandankala/landa-travels) |
| Hugging Face files | [Browse source and report](https://huggingface.co/spaces/yolandankala/landa-travels/tree/main) |
| GitHub repository | [Browse the code](https://github.com/Yolanda2020Code/landa-travels) |
| Final submitted report | [Read the PDF](reports/Landa-Travels-Final-Report-2026.pdf) |

For sign-in on a phone, open the **live application** directly in Safari or Chrome rather than inside the Space preview.

## Overview

The project explores how conversational interfaces can support more informed travel decisions without overstating environmental benefits. Travellers provide their route, dates, budget, accessibility needs and preferences, review the collected details, and approve a search.

Recommendations use category-specific ranking with **climate-first, balanced and comfort-first** priorities. Carbon estimates, mapped places, certification evidence and provider offers are labelled separately so that an estimate or map listing is not presented as a verified booking or environmental certification.

## Key features

- **Guided planning:** natural-language input, quick replies, validation and field-specific corrections.
- **Transparent comparisons:** transport, stays and activities with estimated carbon impact, ranking explanations and source information.
- **Certification evidence:** official EU Ecolabel records distinguished from ordinary OpenStreetMap hotel listings.
- **Traveller accounts:** saved trips, trip resumption, impact summaries and rewards features.
- **Human support:** consent-gated advisor requests with a visible handover summary.
- **Supporting context:** maps, weather and currency references.

## Evaluation and findings

The submitted report documents layered NLU, dialogue and source-code testing. The results below are recorded evaluation results, not new tests run for this README.

| Evaluation | Result |
|---|---|
| Main labelled set: intent accuracy | **83.3%** — 40 of 48 examples |
| Main labelled set: entity precision / recall / F1 | **1.000 / 0.750 / 0.857** |
| Five-fold cross-validation | **496 examples across 21 intents** |
| Pooled out-of-fold intent accuracy | **66.53%** |
| Pooled weighted / macro F1 | **0.658 / 0.636** |
| Dialogue regression tests | **16 of 16 stories; 84 of 84 actions** |
| Source tests reported | **259 passed** |

The difference between labelled-set and cross-validated accuracy shows that intent recognition still depends on familiar phrasing. Entity extraction on the main set was precise but missed some entities, making accessibility requests and ambiguous short messages important improvement areas. Transparent sources and explicit confirmation support trust, but reliable recognition remains essential.

See the [final report](reports/Landa-Travels-Final-Report-2026.pdf) and [reproducible evaluation evidence](reports/EVALUATION-README.md) for methods and limitations.

## Technology

**Frontend:** React, TypeScript and Vite  
**Backend:** Express, PostgreSQL and typed API contracts  
**Conversation:** Rasa 3.6.21, DIET intent classification, custom entity extraction and Python actions  
**Hosting:** Docker and Nginx on Hugging Face Spaces

Provider integrations include Climatiq for carbon estimates, Duffel test-mode flight offers, and OpenStreetMap/Nominatim/Overpass for mapped context. Accommodation certification is checked against official registry evidence.

## Limitations and next steps

- Carbon figures are estimates, not measurements of an individual journey.
- Flight offers are in test mode; the platform does not complete real bookings or payments.
- Certified-stay coverage is limited, and mapped hotels do not establish certification or room availability.
- Typed budgets and post-results questions about certification need stronger recognition.
- Rewards and longer-term behaviour measurement remain development areas.

Next steps include broader language coverage, improved accessibility-entity recall, expanded certified-stay data and further evaluation with travellers before operational booking support.

## Code and setup

```text
apps/web/       Website and traveller interface
apps/api/       API, provider integrations and source tests
packages/      Database schema and typed API contracts
rasa-bot/      NLU data, dialogue rules, actions and tests
deployment/    Container startup, Nginx and health checks
reports/       Final report and evaluation evidence
```

For installation, secrets configuration, reproduction commands and hosting guidance, see [Setup and deployment](docs/SETUP.md).

## About the author

**Yolanda N. Nkala** is a Data Scientist, AI Practitioner and entrepreneur pursuing a Master's in Artificial Intelligence. Her interests connect behavioural analytics, recommendation systems and human-centred technology, with a focus on practical products and sustainable innovation.

[GitHub profile](https://github.com/Yolanda2020Code) · [Hugging Face profile](https://huggingface.co/yolandankala)
