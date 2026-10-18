#!/bin/bash
# Apply the fourteen-task multitenancy migration chain (idempotent: applied|up-to-date).
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"
source /tmp/mt037-env.sh
OUT="$(dirname "$0")/verification/migration/generated"
mkdir -p "$OUT"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027; do
  echo "-- $TASK"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT" >/dev/null
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json" | tail -1
done
