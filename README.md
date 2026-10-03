---
title: Landa Travels
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
---

# Landa Travels

A responsible-travel website with a conversational planner, transparent carbon
estimates, saved trips, consent-gated advisor support and administrative tools.

## Project structure

```text
apps/web/        React website
apps/api/        Express API, provider adapters and route tests
packages/       Database schema, OpenAPI contract and generated typed clients
rasa-bot/       Rasa configuration, training data, actions and tests
assets/         Website photography
deployment/     Nginx, service startup and health/smoke checks
```

## Prerequisites

- Node.js 22 and pnpm 10.26.1.
- Python 3.10 and uv 0.9.5 for the Rasa environment.
- PostgreSQL with the application schema applied.
- Provider credentials and production authentication configured where needed.

Create a local `.env` from `.env.example`, supply values privately, and load
them in the terminal or host's environment. No script automatically loads this
file; for local commands use a dotenv runner or export the variables yourself.
Never commit credentials.

```bash
corepack enable
corepack prepare pnpm@10.26.1 --activate
pnpm install --frozen-lockfile
uv sync --locked
python deployment/assemble-model.py
pnpm run build
pnpm test
uv run python -m pytest rasa-bot/tests -q
```

Python tests should run from `rasa-bot` when they depend on its import paths:

```bash
cd rasa-bot
uv run --project .. python -m pytest tests -q
```

Review the target database before applying schema changes:

```bash
pnpm db:push
```

For local development, run the API and website in separate terminals using
`pnpm dev:api` and `pnpm dev:web`. Start Rasa and its action server separately
using `bash deployment/start-rasa-development.sh` from an environment in which
the Python/Rasa executables are available. The website is on port 3000 and
proxies `/api` to the API on 5001.

## Hugging Face deployment

Upload this directory's contents, not the containing folder, to a Docker Space repository. Its root must
contain this README and Dockerfile. Configure `DATABASE_URL` as a Space secret
and apply the database schema before startup. The container exposes Nginx on
7860; the API, Rasa and action-server ports are private.

The supplied `rasa-bot/models/landa-travels.tar.gz` is the evaluated model,
renamed without changing its contents. Its SHA-256 appears in
`release-manifest.json`. The Docker build does not retrain it. A future
retrained model requires its own evaluation; recorded metrics are not a
promise of performance for new models or production traffic.

For GitHub API upload compatibility, the repository stores this large archive
as six binary parts under `rasa-bot/models/parts`. Run
`python deployment/assemble-model.py` before local Rasa commands. Docker performs
this step automatically and verifies the original archive's SHA-256 and size.
The downloadable source ZIP already contains the complete archive.

Configure provider keys only as host secrets. Without configured Clerk
authentication, the website operates in anonymous mode; sign-in/save/account
features are unavailable. An external host needs a Clerk instance and domain
configuration appropriate to that host; users/roles are not automatically
transferred from an existing authentication environment.

### Deployment limitations

- A successful source build is not a successful live Space deployment.
- Private recruitment uploads can use a private, non-versioned Hugging Face
  storage bucket. Set RECRUITMENT_STORAGE_BACKEND=huggingface,
  HF_PRIVATE_UPLOAD_BUCKET, HF_STORAGE_TOKEN, PRIVATE_UPLOAD_SIGNING_KEY
  (at least 32 random characters), and PUBLIC_APP_URL. The Docker image includes
  the storage helper. Only the server accesses the bucket credential; the
  browser receives method-bound, 15-minute capability URLs. Uploads are
  limited to 5 MB, one-use, and checked for supported file signatures.
  Download links are issued only through the existing recruitment-owner route.
  File bytes stay in the private bucket, not Git or PostgreSQL.
- Alternatively, private recruitment uploads use a signing service through
  `OBJECT_STORAGE_SIGNING_URL` and `PRIVATE_OBJECT_DIR`. The service accepts
  POST requests with `bucket_name`, `object_name`, `method` and `expires_at`,
  returning a `signed_url`. No signing service is supplied by this image.
  Configure one of these private storage backends before offering CV uploads; missing
  storage fails explicitly rather than pretending an upload succeeded.
- The default Rasa tracker is in memory. Configure the complete
  `RASA_TRACKER_DB_*` set for native conversation persistence across restarts.
- Registry/map data is not room inventory. Current flight access is TEST-mode;
  carbon figures are estimates and pet/dietary policies need confirmation.
- Configure production identity, database, storage, domain and secrets
  independently for the chosen host.

### GitHub to Hugging Face

The source ZIP includes workflow definitions under `.github/workflows`.
The GitHub-uploaded repository stores these same definitions under
`deployment/github-workflows`, because its upload connection cannot install
GitHub Actions workflows. To enable Actions, use GitHub's website to copy
`ci.yml` and `sync-to-hub.yml` into `.github/workflows` and commit them.
Until those files are activated, no GitHub CI or automatic sync is running.
Direct Docker Space deployment does not require GitHub Actions.

1. Create a GitHub repository and upload this package's contents at its root.
2. Create a Hugging Face Space with the Docker SDK.
3. In the GitHub repository's Actions settings, add the variable `HF_SPACE_ID`
   with your Space identifier, such as `your-name/landa-travels`.
4. Add the secret `HF_TOKEN` with a token permitted to write to that Space.
   Never paste this token into code, commits, screenshots or documentation.
5. In the Hugging Face Space's Settings, configure `DATABASE_URL` and any
   authentication/provider credentials as secrets. Apply the application schema
   to a separate assessment database before starting the Space.
6. Push to `main`, or run the **Sync to Hugging Face** GitHub workflow manually.

The official sync action uploads file contents, automatically handles large
model files on the Hub, and excludes GitHub workflow metadata from the Space.
Once activated, the **Build and test** workflow independently runs source tests and a Docker
build on GitHub. A successful sync does not mean the Space started successfully:
inspect the Space's build/runtime logs and run the hosted smoke test.

Space secrets are not copied when an assessor duplicates your Space. They must
provide their own secrets and database. Do not give assessors production keys
or expose private application records.

## Assessor testing

All API/frontend test sources and all Rasa test/evaluation datasets are included.
The host-independent identity-key tests deliberately check explicit configuration
rather than deriving identity keys from a particular hosting domain.

```bash
pnpm test
uv run python -m pytest rasa-bot/tests -q
cd rasa-bot
uv run --project .. rasa data validate
uv run --project .. rasa test core --model models/landa-travels.tar.gz \
  --stories tests/test_stories.yml --out evidence/assessor-core
```

For NLU evaluation, use the supplied scripts and held-out datasets rather than
training on the evaluation examples. From `rasa-bot`, inspect:

```bash
uv run --project .. python scripts/evaluate-current.py --help
```

Run the hosted readiness smoke check from the repository root:

```bash
python deployment/smoke-huggingface.py https://YOUR-SPACE.hf.space
```

Browser checks require Node.js 22 and an installed Chromium browser. Set
`CHROME_BIN` to its executable path if it is not available as `chromium`:

```bash
CHROME_BIN=/usr/bin/chromium \
  node deployment/browser-ui-check.mjs --url https://YOUR-SPACE.hf.space
CHROME_BIN=/usr/bin/chromium \
  node deployment/chatbot-challenge-widget.mjs \
  https://YOUR-SPACE.hf.space evidence/assessor-widget
```

Use synthetic accounts and test records for authenticated browser checks.
Anonymous browser scripts do not prove signed-in isolation or save/resume.
Do not run destructive or cleanup scenarios against a database containing real users.

For a local container run, after configuring and applying the database schema:

```bash
docker build -t landa-travels .
docker run --rm --env-file .env -p 7860:7860 landa-travels
```

The model and source are inspectable without credentials. Running the full API
requires PostgreSQL. Sign-in requires configured authentication, live providers
require the relevant permissions, and private uploads require a configured
storage adapter. These dependencies are not replaced by fabricated results.

## Independent hosted sign-in and staff permissions

Configure a matching key pair from your own Clerk application as
`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. Development keys are suitable for
controlled assessment on a host-provided domain, not a production identity
deployment. Authentication connects directly to that application's frontend
API by default. Leave `CLERK_PROXY_URL` empty unless you explicitly configure a
supported authentication proxy; an empty runtime value disables inherited
build-time proxy settings.

Set `PUBLIC_APP_URL` to the verified external HTTPS application URL.
Set `CLERK_ROLES_FROM_BACKEND=true` to authorize staff against Clerk's trusted
public metadata without customizing session-token claims. Assign staff public
metadata as `{"role":"advisor"}` or `{"role":"admin"}` in your own identity
application. Ordinary accounts remain travellers. Client-editable unsafe
metadata never grants staff access.

Recruitment access is independent of staff roles: the signed-in account must
have a verified email matching `RECRUITMENT_OWNER_EMAIL`, or
`RECRUITMENT_EMAIL` when no separate owner address is configured. Its protected
page is `/admin/applications`. No privileged assessment password is committed.

### Signing in on phones and embedded previews

Open the application's direct `.hf.space` URL in Safari or Chrome for account
access. Embedded previews show an explicit link to open secure sign-in outside
the frame. Google authentication uses a same-tab redirect instead of an
automatic popup. In-app browsers can restrict Google authentication; if one
shows a blank window, open the direct application link in your normal browser.

## Data attribution

Map context is derived from OpenStreetMap contributors and retains attribution
in the application/data. Accommodation certification evidence is independently
sourced from official records and is not inferred from map or booking matches.
Third-party libraries, generated clients and provider data retain their
respective notices and terms.