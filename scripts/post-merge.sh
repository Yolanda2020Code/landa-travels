#!/bin/bash
set -e
pnpm install --no-frozen-lockfile
pnpm --filter db push-force
