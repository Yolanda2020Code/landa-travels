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

The Docker image has **not** been built or run as part of this validation.
The Hugging Face Space has **not** been published or tested. The supplied CI
workflow performs a Docker build on GitHub. Hosted startup and browser flows
must then be checked using the configured assessment database and credentials.

Dependency installation reports peer-version warnings for authentication UI
packages and the API logging build plugin. They did not prevent the source
build or tests from passing; they must not be presented as a warning-free or
fully deployment-verified installation.

PostgreSQL is required for the API. Authentication, provider access and upload
storage each require their own configuration. See README.md for prerequisites
and assessment commands. Never substitute private production data or keys.