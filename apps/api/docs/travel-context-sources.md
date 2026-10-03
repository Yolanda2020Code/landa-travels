# Destination local-data coverage

## Current behavior

Only verified provider/city combinations are queried: Entur departures for
Oslo and current events for Paris. Each provider request is bounded by a
2.5-second timeout. Successful responses include a retrieval timestamp, source
link, attribution, and provider-backed results. Provider failures are reported
as `unavailable`, never replaced by invented data. Other destinations and
feed types remain `not-covered` with empty result arrays and no claimed check
time. OSM transit stops remain location references only; mapped attractions
are not presented as events.

## Verified providers

- **Oslo transit — Entur Journey Planner v3:** The official
  [Journey Planner GraphQL API](https://developer.entur.no/apis/graphql/journey-planner)
  is an open service under Norway's NLOD, requires the identifying
  `ET-Client-Name` request header, and does not require an API key. The
  integration requests up to three estimated calls at fixed stop
  `NSR:StopPlace:58366` (Jernbanetorget) over the next hour. This is explicitly
  a central-Oslo reference, not the traveller's nearest stop, a routed journey,
  or service for future trip dates. Expected times are shown as real-time
  estimates; aimed times are labelled scheduled.
- **Paris cultural events — Ville de Paris:** The
  [Que faire à Paris? dataset/API](https://opendata.paris.fr/explore/dataset/que-faire-a-paris-/api)
  is the city's current event/activity catalogue, and its dataset metadata
  declares the Open Database License (ODbL). The integration applies
  `date_start`, `date_end`, and Paris-city filters server-side and requests at
  most 60 records. It then validates dates/occurrences, a physical Paris
  venue, and an official HTTPS `paris.fr` event URL. Undated, expired,
  virtual-only, unsafe-link, and non-Paris records are excluded. If no trip
  dates are provided, it queries the next 30 Paris-local calendar days;
  explicit trip dates filter the event window. Results link to each event and
  the source dataset and display ODbL attribution.

## Not covered

- **Paris public transport:** The official
  [Île-de-France Mobilités dataset catalogue](https://transport.data.gouv.fr/datasets/reseau-urbain-et-interurbain-dile-de-france-mobilites?locale=en)
  publishes GTFS theoretical schedules (the catalogue says updates are made
  three times daily) and documents SIRI-Lite next-passage APIs. Its own
  description says real-time API use requires an account connected to the
  PRIM portal, and next-passage service covers only part of the network. No
  PRIM credentials, stop-coverage check, or per-resource reuse/attribution
  review is available here, so neither feed is queried.
- **Cultural events outside Paris:** Barcelona City Council's
  [official events guide](https://guia.barcelona.cat/en/) and
  [Open Data BCN API catalogue](https://opendata-ajuntament.barcelona.cat/en/api-cataleg)
  remain discovery leads only; no current-events integration is verified for
  Barcelona or other cities.
- Entur departures are not shown outside Oslo, and Paris events are not used
  for other cities. The map cache also covers Berlin, Lisbon, Amsterdam,
  Barcelona, Copenhagen, Edinburgh, and San José; those cities remain
  explicitly not covered for both feed types.

## EU Ecolabel certified hotel registry

The server uses the European Commission's public
[EU Ecolabel Product Catalogue](https://environment.ec.europa.eu/app/ecolabel-product-catalogue)
and its
[public DataQuery API](https://apps.data.env.service.ec.europa.eu/dataquery/docs).
The API documentation states that its data is public and original-source terms
apply. The Commission's
[reuse notice](https://commission.europa.eu/legal-notice_en) applies CC BY 4.0
unless otherwise noted. The normalized, factual subset is attributed to the
European Commission and EU Ecolabel; it is not endorsed by the Commission.

A bounded background refresh runs at API startup and every six hours. It
fetches city-alias pages with request timeouts, then requires an exact
normalized city and country match, `Hotel` service type, `Tourist
accommodation` group, a non-empty licence, and a future expiry date. Duplicate
licences are removed. Only the licence, expiry, hotel name, street, city,
country, and a validated HTTP(S) hotel website are retained. Emails, phones,
VAT identifiers, coordinates, photos, logos, and marketing descriptions are
not published. Invalid/malformed hotel URLs are omitted. The current bundled
snapshot was fetched from the official API at
`2026-09-30T22:05:17Z`: 57 Paris hotels (including official city spelling
variants), 3 Berlin hotels, and 1 Lisboa hotel; no records matched other
configured city/country pairs at that retrieval time.
An operator can perform a one-off refresh with
`pnpm --filter @workspace/api run refresh:certification-registry`.

The snapshot is usable for at most 24 hours. Failed refreshes retain the prior
snapshot, but stale evidence is then explicitly `unavailable` and never shown
as a verified hotel. Trip dates must parse as an ordered ISO date range and the
licence must remain valid through the trip's final day. Unknown dates do not
imply verification. No registry prices or availability are offered. Where a
separate booking provider already supplies a country-average hotel emissions
estimate, it is labelled as an indicative country average, never a
property-specific measurement; otherwise the estimate is absent.

Green Key is not scraped or presented as an integrated registry.