# Assessment package validation

The standalone package was installed using its frozen JavaScript lockfile.
Its OpenAPI code generation, shared-library type checks, API/frontend type
checks, production API build and production website build passed.

Source tests passed:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| API | 132 | 0 |
| Frontend | 18 | 0 |
| Python | 102 | 0 |

Validation used Node.js 24.13.0, Python 3.10.19, pnpm 10.26.1 and uv 0.9.5.
The Docker target and GitHub CI use Node.js 22 and Python 3.10.
The Python lockfile consistency and deployment-script syntax were checked.
Python tests used the available Python dependencies; the container's locked
Python installation has not been executed here.

The supplied Rasa archive is unchanged; its SHA-256 is in
`release-manifest.json`. These packaging checks are not a new NLU evaluation,
model retraining, hosted browser test or supplier fulfilment test.

## Hosted validation — 3 October 2026

Hugging Face built the Docker image successfully, including checksum-verified
assembly of the supplied Rasa model. The public Docker Space is available at:

https://huggingface.co/spaces/yolandankala/landa-travels

Application URL reported by the hosting API:

https://yolandankala-landa-travels.hf.space

A separate, empty external PostgreSQL database was inspected before applying
the schema. All 15 application tables were verified, and the connection was
configured privately as the Space's DATABASE_URL secret. No private workspace
records were copied.

The Space reached RUNNING. Its startup checks confirmed the action server,
Rasa, database connectivity, API readiness, and synthetic Rasa warm-up before
opening the public web port.

The repository's deployment/smoke-huggingface.py passed all four public checks:

| Check | Result |
| --- | --- |
| Website | HTTP 200 |
| API health | HTTP 200, status ok |
| Direct private Rasa webhook | HTTP 404, correctly inaccessible |
| Anonymous assistant greeting | HTTP 200, nonempty assistant messages |

A browser screenshot also confirmed the public homepage renders, with its
anonymous-planning controls and explicit sign-in-unavailable notice.

This is a hosted startup and anonymous greeting smoke check, not a complete
guided-trip browser test, authenticated save/resume test, new NLU evaluation,
provider fulfilment test, or private-upload test. Account authentication,
provider credentials, and private-upload storage were not configured during
that initial startup check. Further hosted configuration is recorded below.

Runtime logs include dependency deprecation and global-config permission
warnings; they did not prevent readiness or the smoke checks. This is not a
warning-free deployment. The GitHub workflow definitions remain inactive
templates until separately installed; these hosted results are not GitHub CI.

Dependency installation reports peer-version warnings for authentication UI
packages and the API logging build plugin. They did not prevent the source
build or tests from passing; they must not be presented as a warning-free or
fully deployment-verified installation.

PostgreSQL is required for the API. Authentication, provider access and upload
storage each require their own configuration. See README.md for prerequisites
and assessment commands. Never substitute private production data or keys.

## Further hosted configuration

The exported application now includes native private Hugging Face bucket
storage, method-bound expiring file capabilities, single-use upload sessions,
file size/signature validation, and retention deletion through the existing
recruitment service. Capability URLs are redacted from API logs and excluded
from web-server access logs. File bytes are not stored in Git or PostgreSQL.

A synthetic file was uploaded, inspected, downloaded with exact byte equality,
and deleted successfully from the private bucket. Type checks passed, together
with 127 API tests and 15 frontend tests. Python NLU tests were not rerun for
this storage-only change.

Duffel place lookup, Climatiq factor search, routing, and email-domain APIs
accepted the existing credentials (HTTP 200). Credentials are configured as
private Space settings. These checks are not flight purchasing, live hotel
inventory, or email-delivery evidence. Flight credentials remain test-mode;
the hotel provider's account access limit has not changed.

A separate PostgreSQL database is configured for the native Rasa tracker to
avoid mixing its independently owned event tables into the application ORM
schema.

The final hosted runtime reached RUNNING with a native tracker event table and
persisted events in its separate database. Website/API checks returned 200;
the private Rasa path remained 404. Anonymous owner access returned 401,
unsigned private-file access returned 403, and anonymous bucket access
returned 401.

An initial browser recruitment test exposed an SDK-cache permission failure.
It was reproduced under a read-only home directory and corrected by using a
per-operation temporary SDK cache. A subsequent live HTTP flow confirmed:
upload-session creation 201, signed file PUT 204, application submission 201,
repeat PUT rejection 410, and rejection of GET with a PUT capability 403.
Synthetic records and file objects from these checks were deleted.
The unchanged browser submission flow was not rerun after this server-only
fix; authenticated owner download still requires the external auth setup.

Three additional standalone hosted-endpoint regression checks passed.
Secret-bearing tracker endpoints are rendered into an owner-only temporary
JSON file at startup. This avoids duplicate constructor arguments and literal
nested environment placeholders in the pinned Rasa version.

An independently owned Clerk application is now configured on the external
host, without changing the original application's accounts or database.
The supplied key pair was checked for format, independent ownership, backend
API access, and matching session-token issuer/frontend domain.

A synthetic traveller completed browser sign-in. An inherited authentication
proxy subsequently caused token-renewal failures; the standalone frontend now
uses its own Clerk frontend API directly unless a proxy is explicitly
configured. A canonical HTTPS public origin is enforced for optional proxy
use, and forwarded HTTPS is preserved by the web server.

Live authenticated HTTP checks confirmed traveller denial of both staff
endpoints (403), advisor inbox access (200) with administrator denial (403),
and administrator access to both staff endpoints (200). Recruitment access
remained forbidden (403) for all synthetic accounts that did not match the
verified owner email. Administrator overview also exposed a PostgreSQL
reserved-alias error; its corrected query was executed against the external
database and the live endpoint returned 200 with metrics.

Guided future dates were accepted with an authenticated live HTTP request
(200). These endpoint checks alone are not authenticated browser save/resume
evidence or an actual recruitment-owner download check.

## Final authenticated browser verification

The direct identity connection passed in a fresh browser context. Forced
session-token renewal returned HTTP 200. A synthetic traveller completed the
guided Berlin–Paris trip for 15–18 November 2026, one adult, EUR 1,000, rail,
eco-hotel, and balanced sustainability. Assistant updates returned 200 and
trip creation returned 201.

The saved trip survived reload and sign-out/sign-in. Resuming it restored its
route, dates, traveller count, budget, and preferences. A second traveller's
trip list was empty and direct navigation to the first traveller's trip did
not disclose its details.

An additional authenticated HTTP check confirmed that the owner's trip list
included the saved test itinerary and the second traveller's list excluded it
(both list requests returned 200).

Browser role checks passed: the advisor opened the advisor inbox but was
redirected away from Quality Control; the administrator opened Quality
Control with loaded telemetry; the ordinary traveller was redirected away
from both staff pages; anonymous staff navigation ended at sign-in without
protected content. Private conversation rows were not opened.

The selected rail package explicitly reported `required_inventory_unavailable`.
No booking, payment, or outbound email was made. This is assessment-flow
verification, not live supplier fulfilment or verified external-email delivery.

After verification, the four synthetic identity accounts, their saved trips
and profile records, three owned conversations, and 265 native tracker events
were removed. The private temporary credentials fixture was deleted.