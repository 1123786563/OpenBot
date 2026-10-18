#!/bin/bash
# MT070 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55528).
# Container mt070-impl-pg created by the MT070 implementation round (port 55528
# precheck: free, see verification/00-port-preflight.txt). Runs the base drizzle
# migration + restricted role logins, then the full 16-task multitenancy chain in
# registry order (MT000→MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→
# MT076→MT069→MT016→MT041→MT027→MT070; journal 16 tasks / 32 steps), INCLUDING
# the MT041 task as modified by MT041-fix (F3 FORCE RLS + F4 column-scoped UPDATE
# grant): plan digest changed by design; test database rebuilt from scratch (no
# production impact).
# （修复轮 F3 更正：原头注释为 MT041-fix/13-task/55521 旧文案，与正文实况——
# 16 任务/端口 55528——不符；assigned 库名口径与 test-env.sh 统一为
# openbot_enterprise_mt070_assigned。）
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"

export TEST_DATABASE_URL="postgres://postgres:mt070@127.0.0.1:55528/openbot_enterprise_mt070_test"
export ENTERPRISE_TEST_SETUP_DATABASE_URL="$TEST_DATABASE_URL"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_mt070_directory:entpw.dir01@127.0.0.1:55528/openbot_enterprise_mt070_test?options=-c%20role%3Dob_ent_directory"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_mt070_data:entpw.data01@127.0.0.1:55528/openbot_enterprise_mt070_test?options=-c%20role%3Dob_ent_data"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_mt070_operator:entpw.operator01@127.0.0.1:55528/openbot_enterprise_mt070_test?options=-c%20role%3Dob_ent_operator"

if [ "${1:-}" = "env" ]; then
  cat <<EOF
export TEST_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_SETUP_DATABASE_URL=$TEST_DATABASE_URL
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL
export ENTERPRISE_TEST_DATA_DATABASE_URL=$ENTERPRISE_TEST_DATA_DATABASE_URL
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=$ENTERPRISE_TEST_OPERATOR_DATABASE_URL
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:mt070@127.0.0.1:55528/openbot_enterprise_mt070_assigned"
EOF
  exit 0
fi

echo "== base migration + restricted role logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate

echo "== MT003 assigned database =="
docker exec mt070-impl-pg psql -U postgres -tc "select 1 from pg_database where datname='openbot_enterprise_mt070_assigned'" | grep -q 1 ||
  docker exec mt070-impl-pg psql -U postgres -c "create database openbot_enterprise_mt070_assigned"

echo "== multitenancy task chain (13 tasks incl. modified MT041) =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT070/verification/migration/generated"
for TASK in MT000 MT004 MT008 MT112 MT012 MT014 MT010 MT009 MT077 MT026 MT076 MT069 MT016 MT041 MT027 MT070; do
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec mt070-impl-pg psql -U postgres -d openbot_enterprise_mt070_test -c "select task_id, count(*) as steps, min(applied_at)::date as day from mt_task_migration_journal group by task_id order by task_id;"
