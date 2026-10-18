#!/bin/bash
# MT037 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55531).
# Container mt037-impl-pg started by the implementer (port 55531 precheck: idle, recorded in
# verification/00-port-preflight.txt). Databases: openbot_enterprise_mt037_test (+ _assigned
# for the MT003 assigned cases) + openbot_kb_mt037_test (dedicated KB database, restricted
# login ent_mt037_kb, NOSUPERUSER NOBYPASSRLS, owner channel for drizzle-kb migrations).
# Chain (brief dependency order, fourteen tasks incl. this ticket's inherited tail):
#   MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"
source /tmp/mt037-env.sh

OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT037/verification/migration/generated"
mkdir -p "$OUT"

for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done

echo "== KB dedicated database migrations (drizzle-kb journal, owner channel) =="
bun --no-env-file -e '
import { runMigrations } from "./src/kb/db/migrate";
await runMigrations(process.env.KB_TEST_DATABASE_URL);
console.log("kb-migrations-ok");
'

echo "== chain journal =="
docker exec mt037-impl-pg psql -U postgres -d openbot_enterprise_mt037_test -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
echo "== kb tables =="
docker exec mt037-impl-pg psql -U postgres -d openbot_kb_mt037_test -c "\dt"
