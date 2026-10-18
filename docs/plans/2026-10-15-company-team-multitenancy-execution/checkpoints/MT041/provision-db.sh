#!/bin/bash
# MT041 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55516).
# Container mt041-impl-pg was pre-started by the coordinator (port 55516 precheck: brief
# names 55516 as the starting port; it hosts this ticket's own container — recorded, not
# a conflict). Database openbot_enterprise_mt041_test existed empty; this script runs the
# base drizzle migration + restricted role logins, then the multitenancy task chain in
# dependency order: MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069.
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"

export TEST_DATABASE_URL="postgres://postgres:mt041@127.0.0.1:55516/openbot_enterprise_mt041_test"
export ENTERPRISE_TEST_SETUP_DATABASE_URL="$TEST_DATABASE_URL"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_mt041_directory:entpw.dir01@127.0.0.1:55516/openbot_enterprise_mt041_test?options=-c%20role%3Dob_ent_directory"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_mt041_data:entpw.data01@127.0.0.1:55516/openbot_enterprise_mt041_test?options=-c%20role%3Dob_ent_data"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_mt041_operator:entpw.operator01@127.0.0.1:55516/openbot_enterprise_mt041_test?options=-c%20role%3Dob_ent_operator"

if [ "${1:-}" = "env" ]; then
  cat <<EOF
export TEST_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_SETUP_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL
export ENTERPRISE_TEST_DATA_DATABASE_URL=$ENTERPRISE_TEST_DATA_DATABASE_URL
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=$ENTERPRISE_TEST_OPERATOR_DATABASE_URL
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt041@127.0.0.1:55516/openbot_enterprise_mt003_assigned"
EOF
  exit 0
fi

echo "== base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== MT003 assigned database =="
docker exec mt041-impl-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_enterprise_mt003_assigned'" | grep -q 1 ||
  docker exec mt041-impl-pg psql -U postgres -c "create database openbot_enterprise_mt003_assigned"

echo "== multitenancy task chain =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT041/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt041-impl-pg psql -U postgres -d openbot_enterprise_mt041_test -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
