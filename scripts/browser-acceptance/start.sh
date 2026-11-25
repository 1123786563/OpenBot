#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
bun --no-env-file --env-file=.env.test scripts/generate-app-config.ts
export FIXTURE_API_PORT=${FIXTURE_API_PORT:-41850}
export FIXTURE_APP_PORT=${FIXTURE_APP_PORT:-41849}
bun --no-env-file scripts/browser-acceptance/api.mjs &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT INT TERM
cd app
SERVER_PORT="$FIXTURE_API_PORT" APP_PORT="$FIXTURE_APP_PORT" bun --no-env-file node_modules/vite/bin/vite.js --config ../scripts/browser-acceptance/vite.config.mjs --host 127.0.0.1 --port "$FIXTURE_APP_PORT" --strictPort
