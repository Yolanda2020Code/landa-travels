#!/usr/bin/env bash
set -euo pipefail

export TF_NUM_INTRAOP_THREADS="${TF_NUM_INTRAOP_THREADS:-2}"
export TF_NUM_INTEROP_THREADS="${TF_NUM_INTEROP_THREADS:-1}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-2}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

cleanup() {
  kill "${RASA_PID:-}" "${ACTION_PID:-}" 2>/dev/null || true
  wait "${RASA_PID:-}" "${ACTION_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$(dirname "$0")/../rasa-bot"

if [[ ! -f models/landa-travels.tar.gz ]]; then
  printf 'The evaluated model archive is missing.\n' >&2
  exit 1
fi

SANIC_HOST=127.0.0.1 python -m rasa_sdk --actions actions --port 5055 &
ACTION_PID=$!

rasa run \
  --enable-api \
  --interface 127.0.0.1 \
  --cors "*" \
  --credentials credentials.yml \
  --endpoints endpoints.yml \
  --model models/landa-travels.tar.gz \
  --port 5005 &
RASA_PID=$!

wait_url() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + 240))
  while (( SECONDS < deadline )); do
    if ! kill -0 "${RASA_PID}" 2>/dev/null ||
       ! kill -0 "${ACTION_PID}" 2>/dev/null; then
      printf 'A required Rasa service exited before readiness (%s).\n' "${name}" >&2
      return 1
    fi
    if python -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2).close()' "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Timed out waiting for Rasa readiness (%s).\n' "${name}" >&2
  return 1
}

wait_url "Rasa action server" "http://127.0.0.1:5055/health"
wait_url "Rasa model" "http://127.0.0.1:5005/status"
if ! python scripts/warmup-rasa.py --url http://127.0.0.1:5005; then
  printf 'Private synthetic Rasa warm-up failed; development readiness is withheld.\n' >&2
  exit 1
fi

set +e
wait -n "${RASA_PID}" "${ACTION_PID}"
SERVICE_EXIT_CODE=$?
set -e
printf 'A required Rasa process exited (status %s).\n' "${SERVICE_EXIT_CODE}" >&2
exit "${SERVICE_EXIT_CODE}"