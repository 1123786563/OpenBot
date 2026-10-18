#!/bin/bash
# MT076 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55493).
# Base drizzle migration + restricted role logins, then the multitenancy task
# chain in dependency order: MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026.
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"

export TEST_DATABASE_URL="postgres://postgres:mt076@127.0.0.1:55493/openbot_enterprise_mt076_test"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_mt076_directory:entpw.dir01@127.0.0.1:55493/openbot_enterprise_mt076_test"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_mt076_data:entpw.data01@127.0.0.1:55493/openbot_enterprise_mt076_test"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_mt076_operator:entpw.operator01@127.0.0.1:55493/openbot_enterprise_mt076_test"

if [ "${1:-}" = "env" ]; then
  cat <<EOF
export TEST_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_SETUP_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL
export ENTERPRISE_TEST_DATA_DATABASE_URL=$ENTERPRISE_TEST_DATA_DATABASE_URL
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=$ENTERPRISE_TEST_OPERATOR_DATABASE_URL
EOF
  exit 0
fi

echo "== base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== multitenancy task chain =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT076/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt076-impl-pg psql -U postgres -d openbot_enterprise_mt076_test -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
