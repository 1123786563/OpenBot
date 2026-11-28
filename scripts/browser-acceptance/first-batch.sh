#!/bin/sh
# Serve an existing build and capture #182 against the isolated fixture.
set -eu
cd "$(dirname "$0")/../.."
: "${BUILD_DIR:?Set BUILD_DIR to the archived production build}"
: "${BUILD_MANIFEST:?Set BUILD_MANIFEST to the archive manifest}"
: "${EVIDENCE_DIR:?Set EVIDENCE_DIR to an absolute output directory}"
export BUILD_MANIFEST EVIDENCE_DIR
export FIXTURE_API_PORT=${FIXTURE_API_PORT:-45182}
export FIXTURE_APP_PORT=${FIXTURE_APP_PORT:-45183}
export FIXTURE_APP_URL="http://127.0.0.1:$FIXTURE_APP_PORT"
export FIXTURE_API_URL="http://127.0.0.1:$FIXTURE_API_PORT"
mkdir -p "$EVIDENCE_DIR"
bun --no-env-file scripts/browser-acceptance/api.mjs >"$EVIDENCE_DIR/api.log" 2>&1 &
api_pid=$!
app_pid=
trap 'kill "$api_pid" ${app_pid:+"$app_pid"} 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
SERVER_PORT="$FIXTURE_API_PORT" APP_PORT="$FIXTURE_APP_PORT" bun --no-env-file --cwd app node_modules/vite/bin/vite.js preview --outDir "$BUILD_DIR" --host 127.0.0.1 --port "$FIXTURE_APP_PORT" --strictPort >"$EVIDENCE_DIR/preview.log" 2>&1 &
app_pid=$!
for attempt in $(seq 1 30); do
  kill -0 "$api_pid" "$app_pid"
  if curl -fsS -D - -o /dev/null "$FIXTURE_APP_URL/api/capabilities" 2>/dev/null |
    grep -qi '^x-openbot-fixture: isolated'; then
    case "${1:-}" in
      "") bun --no-env-file scripts/browser-acceptance/first-batch.mjs ;;
      --first-attachment) bun --no-env-file scripts/browser-acceptance/first-attachment.mjs ;;
      --group-stop) bun --no-env-file scripts/browser-acceptance/group-stop.mjs ;;
      --website-sign-in) bun --no-env-file scripts/browser-acceptance/website-sign-in.mjs ;;
      --full-sweep) bun --no-env-file scripts/browser-acceptance/full-sweep.mjs ;;
      *) echo "Unknown capture option: $1" >&2; exit 2 ;;
    esac
    exit
  fi
  sleep 1
done
echo "The isolated preview did not become ready. Check api.log and preview.log." >&2
exit 1
