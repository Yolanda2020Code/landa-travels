# Assessment package validation

The standalone package was installed using its frozen JavaScript lockfile.
Its OpenAPI code generation, shared-library type checks, API/frontend type
checks, production API build and production website build passed.

Source tests passed:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| API | 125 | 0 |
| Frontend | 15 | 0 |
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

Independent external-host authentication is still required. Existing managed
authentication keys cannot be used as an independent hosted tenant. No
authenticated sign-in, saved-trip, or recruitment-owner browser flow is claimed
until a separate authentication application is configured and tested.