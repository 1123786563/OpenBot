#!/bin/bash
# MT122 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55567).
# Three-step recipe, same shape as MT041/MT076:
#   1. base drizzle migration + restricted role logins (enterprise-test-db.ts migrate)
#   2. MT003 assigned database + KB database (already created beside this script's run)
#   3. multitenancy task chain generate+apply in dependency order
# Container precheck: port 55567 was free at ticket start; container name mt122-impl-pg.
set -euo pipefail
MT122_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$MT122_DIR/../../../../../server"
source "$MT122_DIR/test-env.sh"

if [ "${1:-}" = "env" ]; then
  cat "$MT122_DIR/test-env.sh"
  exit 0
fi

echo "== step 1: base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== step 3: multitenancy task chain =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT122/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027 MT028 MT070; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt122-impl-pg psql -U postgres -d openbot_enterprise_w14e -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
