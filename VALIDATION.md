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
provider credentials, and an external private-upload signing service are not
configured on this Space. The native Rasa tracker remains in memory.

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