#!/usr/bin/env bash
set -euo pipefail

export TF_NUM_INTRAOP_THREADS="${TF_NUM_INTRAOP_THREADS:-2}"
export TF_NUM_INTEROP_THREADS="${TF_NUM_INTEROP_THREADS:-1}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-2}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

cleanup() {
  kill "${NGINX_PID:-}" "${ACTION_PID:-}" "${RASA_PID:-}" "${API_PID:-}" 2>/dev/null || true
  wait "${NGINX_PID:-}" "${ACTION_PID:-}" "${RASA_PID:-}" "${API_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd /app/rasa-bot

if [[ -z "${DATABASE_URL:-}" ]]; then
  printf 'DATABASE_URL is required by the API server; configure an external PostgreSQL secret before startup.\n' >&2
  exit 1
fi

python - <<'PY'
import json
import os
from pathlib import Path

config = {
    "clerkPublishableKey": os.environ.get("CLERK_PUBLISHABLE_KEY", "").strip(),
    "clerkProxyUrl": os.environ.get("CLERK_PROXY_URL", "").strip(),
}
Path("/usr/share/nginx/html/runtime-config.js").write_text(
    "window.__LANDA_RUNTIME_CONFIG__ = "
    + json.dumps(config, separators=(",", ":"))
    + ";\n",
    encoding="utf-8",
)
PY

ENDPOINTS_FILE=endpoints.yml
RASA_CORS_ORIGIN="${RASA_CORS_ORIGIN:-*}"
TRACKER_VARS=(
  RASA_TRACKER_DB_URL
  RASA_TRACKER_DB_HOST
  RASA_TRACKER_DB_PORT
  RASA_TRACKER_DB_NAME
  RASA_TRACKER_DB_USER
  RASA_TRACKER_DB_PASSWORD
)
TRACKER_CONFIGURED=0
for variable in "${TRACKER_VARS[@]}"; do
  if [[ -n "${!variable:-}" ]]; then
    TRACKER_CONFIGURED=1
  fi
done

if [[ "${TRACKER_CONFIGURED}" -eq 1 ]]; then
  for variable in "${TRACKER_VARS[@]}"; do
    if [[ -z "${!variable:-}" ]]; then
      printf 'PostgreSQL tracker configuration is incomplete: %s is required.\n' "${variable}" >&2
      exit 1
    fi
  done
  export RASA_ACTION_SERVER_URL=http://127.0.0.1:5055/webhook
  ENDPOINTS_FILE=endpoints.production.yml
  printf 'Starting Rasa with the configured external PostgreSQL tracker.\n'
else
  printf 'Starting Rasa with its in-memory tracker; conversations will not persist across restarts.\n'
fi

SANIC_HOST=127.0.0.1 python -m rasa_sdk --actions actions --port 5055 &
ACTION_PID=$!

rasa run \
  --enable-api \
  --interface 127.0.0.1 \
  --cors "${RASA_CORS_ORIGIN}" \
  --credentials credentials.yml \
  --endpoints "${ENDPOINTS_FILE}" \
  --model models/landa-travels.tar.gz \
  --port 5005 &
RASA_PID=$!

PORT=5001 NODE_ENV=production node /app/api/index.mjs &
API_PID=$!

wait_ready() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + 240))

  while (( SECONDS < deadline )); do
    if ! kill -0 "${ACTION_PID}" 2>/dev/null ||
       ! kill -0 "${RASA_PID}" 2>/dev/null ||
       ! kill -0 "${API_PID}" 2>/dev/null; then
      printf 'A required service exited before readiness (%s).\n' "${name}" >&2
      return 1
    fi

    if python -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2).close()' "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  printf 'Timed out waiting for service readiness (%s).\n' "${name}" >&2
  return 1
}

wait_action_socket() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if ! kill -0 "${ACTION_PID}" 2>/dev/null; then
      printf 'The action server exited before readiness.\n' >&2
      return 1
    fi
    if (echo > /dev/tcp/127.0.0.1/5055) >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Timed out waiting for the private action server.\n' >&2
  return 1
}

wait_database() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if ! kill -0 "${ACTION_PID}" 2>/dev/null ||
       ! kill -0 "${RASA_PID}" 2>/dev/null; then
      printf 'A required service exited while waiting for PostgreSQL readiness.\n' >&2
      return 1
    fi
    if python -c 'import os, psycopg2; connection = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=3); connection.close()' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  printf 'Timed out waiting for the API PostgreSQL database.\n' >&2
  return 1
}

wait_action_socket
wait_ready "Rasa server" "http://127.0.0.1:5005/status"
wait_database
wait_ready "API server" "http://127.0.0.1:5001/api/healthz"
if ! python /app/rasa-bot/scripts/warmup-rasa.py --url http://127.0.0.1:5005; then
  printf 'Private synthetic Rasa warm-up failed; public readiness is withheld.\n' >&2
  exit 1
fi

nginx -g "daemon off;" &
NGINX_PID=$!
printf 'All internal services are ready; Nginx is listening on port 7860.\n'

set +e
wait -n "${ACTION_PID}" "${RASA_PID}" "${API_PID}" "${NGINX_PID}"
SERVICE_EXIT_CODE=$?
set -e
printf 'A required container process exited (status %s); stopping the container.\n' "${SERVICE_EXIT_CODE}" >&2
exit "${SERVICE_EXIT_CODE}"
