#!/bin/bash
# MT017 fix-round dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55537).
# Per briefs/MT017-fix-brief.md: dedicated container mt017-fix-pg, loopback-only binding +
# random passwords (generated at run time, never embedded here — supplied via 0600 env),
# port precheck recorded in fix/before-hashes.txt, fourteen-task chain identical to impl round.
# Databases:
#   openbot_enterprise_mt017fix          — main enterprise test DB (setup + three capability logins)
#   openbot_enterprise_mt017fix_assigned — MT003 assigned-DB integration target
#   openbot_kb_mt017fix                  — KB-domain dedicated DB (7th variable)
# Chain (fourteen tasks, brief order): MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→
# MT026→MT076→MT069→MT016→MT041→MT027. MT017 registers NO migration task.
set -euo pipefail
cd "$(dirname "$0")/../../../../../../server"

: "${PW_ROOT:?PW_ROOT required}" "${PW_DIR:?PW_DIR required}" "${PW_DATA:?PW_DATA required}" "${PW_OP:?PW_OP required}"

export TEST_DATABASE_URL="postgres://postgres:${PW_ROOT}@127.0.0.1:55537/openbot_enterprise_mt017fix"
export ENTERPRISE_TEST_SETUP_DATABASE_URL="$TEST_DATABASE_URL"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_mt017fix_directory:${PW_DIR}@127.0.0.1:55537/openbot_enterprise_mt017fix?options=-c%20role%3Dob_ent_directory"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_mt017fix_data:${PW_DATA}@127.0.0.1:55537/openbot_enterprise_mt017fix?options=-c%20role%3Dob_ent_data"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_mt017fix_operator:${PW_OP}@127.0.0.1:55537/openbot_enterprise_mt017fix?options=-c%20role%3Dob_ent_operator"

if [ "${1:-}" = "env" ]; then
  cat <<EOF
export TEST_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_SETUP_DATABASE_URL=$ENTERPRISE_TEST_SETUP_DATABASE_URL
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL
export ENTERPRISE_TEST_DATA_DATABASE_URL=$ENTERPRISE_TEST_DATA_DATABASE_URL
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=$ENTERPRISE_TEST_OPERATOR_DATABASE_URL
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:${PW_ROOT}@127.0.0.1:55537/openbot_enterprise_mt017fix_assigned"
export KB_TEST_DATABASE_URL="postgres://postgres:${PW_ROOT}@127.0.0.1:55537/openbot_kb_mt017fix"
EOF
  exit 0
fi

echo "== create main database (fresh container: default db only) =="
docker exec mt017-fix-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_enterprise_mt017fix'" | grep -q 1 ||
  docker exec mt017-fix-pg psql -U postgres -c "create database openbot_enterprise_mt017fix"

echo "== base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== MT003 assigned database =="
docker exec mt017-fix-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_enterprise_mt017fix_assigned'" | grep -q 1 ||
  docker exec mt017-fix-pg psql -U postgres -c "create database openbot_enterprise_mt017fix_assigned"

echo "== KB dedicated database =="
docker exec mt017-fix-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_kb_mt017fix'" | grep -q 1 ||
  docker exec mt017-fix-pg psql -U postgres -c "create database openbot_kb_mt017fix"

echo "== multitenancy task chain (fourteen tasks) =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT017/fix/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt017-fix-pg psql -U postgres -d openbot_enterprise_mt017fix -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
