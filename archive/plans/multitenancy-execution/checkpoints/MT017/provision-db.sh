#!/bin/bash
# MT017 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55527).
# Port preflight: 55527 was FREE at start (55528=mt070-impl-pg, 55529=mt021-impl-pg,
# 55531=mt037-impl-pg occupied by parallel tickets — recorded, no +1 needed).
# Container mt017-impl-pg created by this ticket; databases:
#   openbot_enterprise_mt017          — main enterprise test DB (setup + three capability logins)
#   openbot_enterprise_mt017_assigned — MT003 assigned-DB integration target
#   openbot_kb_mt017                  — KB-domain dedicated DB (7th variable)
# Chain (fourteen tasks, brief order): MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→
# MT026→MT076→MT069→MT016→MT041→MT027. MT017 registers NO migration task (publication
# reuses the MT008 visibility attribute on enterprise_resources — no new schema objects).
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"

export TEST_DATABASE_URL="postgres://postgres:mt017@127.0.0.1:55527/openbot_enterprise_mt017"
export ENTERPRISE_TEST_SETUP_DATABASE_URL="$TEST_DATABASE_URL"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_mt017_directory:entpw.dir01@127.0.0.1:55527/openbot_enterprise_mt017?options=-c%20role%3Dob_ent_directory"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_mt017_data:entpw.data01@127.0.0.1:55527/openbot_enterprise_mt017?options=-c%20role%3Dob_ent_data"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_mt017_operator:entpw.operator01@127.0.0.1:55527/openbot_enterprise_mt017?options=-c%20role%3Dob_ent_operator"

if [ "${1:-}" = "env" ]; then
  cat <<EOF
export TEST_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_SETUP_DATABASE_URL=$ENTERPRISE_TEST_SETUP_DATABASE_URL
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL
export ENTERPRISE_TEST_DATA_DATABASE_URL=$ENTERPRISE_TEST_DATA_DATABASE_URL
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=$ENTERPRISE_TEST_OPERATOR_DATABASE_URL
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt017@127.0.0.1:55527/openbot_enterprise_mt017_assigned"
export KB_TEST_DATABASE_URL="postgres://postgres:mt017@127.0.0.1:55527/openbot_kb_mt017"
EOF
  exit 0
fi

echo "== base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== MT003 assigned database =="
docker exec mt017-impl-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_enterprise_mt017_assigned'" | grep -q 1 ||
  docker exec mt017-impl-pg psql -U postgres -c "create database openbot_enterprise_mt017_assigned"

echo "== KB dedicated database =="
docker exec mt017-impl-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_kb_mt017'" | grep -q 1 ||
  docker exec mt017-impl-pg psql -U postgres -c "create database openbot_kb_mt017"

echo "== multitenancy task chain (fourteen tasks) =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT017/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt017-impl-pg psql -U postgres -d openbot_enterprise_mt017 -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
