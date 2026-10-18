#!/bin/bash
# MT042 dedicated test-database provisioning (pgvector/pgvector:pg16 @ 127.0.0.1:55564, loopback only).
# Idempotent three-step recipe (same recipe family as MT041/MT028; safe to re-run):
#   step 1: dedicated container (created only if absent; started if stopped)
#   step 2: databases + kb owner role + base drizzle migration + restricted logins (guarded)
#   step 3: multitenancy task chain in dependency order, MT042 last (journal = idempotence)
# Chain order = dependency order (4th-worker fix 2026-10-18): MT112 creates
# enterprise_deployment_anchors and MT012 ALTERs it, so MT112 must precede MT012;
# MT112's anchor backfill reads enterprise_workspace_memberships (MT004). The
# original mtime-guessed order failed a fresh DB at MT012 (relation does not exist).
#   MT004→MT008→MT112→MT012→MT014→MT009→MT010→MT016→MT026→MT027→MT028→MT069→MT076→MT077→MT041→MT070→MT042.
# Seven-variable env (brief: 同 MT022, 库名 w14b) is exported once and consumed by every step.
# NOTE (2026-10-17 continuation): the first provisioning attempt was slowed to a crawl by a
# host-wide load spike (~150, parallel agents + OrbStack crash/recovery); this rewrite makes
# each step re-enterable so recovery never duplicates or re-migrates.
set -euo pipefail
cd "$(dirname "$0")/../../../../../server"

CONTAINER=mt042-impl-pg

if [ "${1:-}" = "env" ]; then
  cat <<'EOF'
export TEST_DATABASE_URL=postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b
export ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_w14b_directory:entpw.dir01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_directory
export ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_w14b_data:entpw.data01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_data
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_w14b_operator:entpw.operator01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_operator
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b_assigned"
export KB_TEST_DATABASE_URL="postgres://ent_w14b_kb:entpw.kb01@127.0.0.1:55564/openbot_kb_w14b"
EOF
  exit 0
fi

# Export once: the base migration AND the migrate-test chain both read these.
export TEST_DATABASE_URL="postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b"
export ENTERPRISE_TEST_SETUP_DATABASE_URL="$TEST_DATABASE_URL"
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL="postgres://ent_w14b_directory:entpw.dir01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_directory"
export ENTERPRISE_TEST_DATA_DATABASE_URL="postgres://ent_w14b_data:entpw.data01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_data"
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL="postgres://ent_w14b_operator:entpw.operator01@127.0.0.1:55564/openbot_enterprise_w14b?options=-c%20role%3Dob_ent_operator"
export MT003_ASSIGNED_TEST_DATABASE_URL="postgres://postgres:w14b@127.0.0.1:55564/openbot_enterprise_w14b_assigned"
export KB_TEST_DATABASE_URL="postgres://ent_w14b_kb:entpw.kb01@127.0.0.1:55564/openbot_kb_w14b"

echo "== step 1: dedicated container =="
if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=w14b -p 127.0.0.1:55564:5432 pgvector/pgvector:pg16
else
  echo "container exists (state: $(docker inspect -f '{{.State.Status}}' $CONTAINER)) — starting if stopped"
  docker start "$CONTAINER" >/dev/null 2>&1 || true
fi
for i in $(seq 1 120); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$CONTAINER" pg_isready -U postgres
docker exec "$CONTAINER" psql -U postgres -tc "select version();"

echo "== step 2: databases + kb owner role (guarded) =="
docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE openbot_enterprise_w14b'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openbot_enterprise_w14b')\gexec
SELECT 'CREATE DATABASE openbot_enterprise_w14b_assigned'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openbot_enterprise_w14b_assigned')\gexec
SELECT 'CREATE DATABASE openbot_kb_w14b'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openbot_kb_w14b')\gexec
SELECT 'CREATE ROLE ent_w14b_kb LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ''entpw.kb01'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ent_w14b_kb')\gexec
ALTER DATABASE openbot_kb_w14b OWNER TO ent_w14b_kb;
SQL

echo "== step 2b: base migration (only when public schema still empty) + restricted logins =="
PUBLIC_OBJECTS=$(docker exec "$CONTAINER" psql -U postgres -d openbot_enterprise_w14b -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')")
if [ "$PUBLIC_OBJECTS" = "0" ]; then
  bun --no-env-file scripts/enterprise-test-db.ts migrate
else
  echo "base schema already present ($PUBLIC_OBJECTS public objects) — skipping migrate"
  # Login provisioning is the migration's second half; provision mode repairs it
  # without re-running (and being refused by) the fresh-schema guard.
  bun --no-env-file scripts/enterprise-test-db.ts provision
fi

echo "== step 3: multitenancy task chain (dependency order, MT042 last) =="
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT042/verification/migration/generated"
for TASK in MT004 MT008 MT112 MT012 MT014 MT009 MT010 MT016 MT026 MT027 MT028 MT069 MT076 MT077 MT041 MT070 MT042; do
  APPLIED=$(docker exec "$CONTAINER" psql -U postgres -d openbot_enterprise_w14b -tAc "select count(*) from mt_task_migration_journal where task_id='$TASK'" 2>/dev/null || echo 0)
  if [ "$APPLIED" != "0" ]; then
    echo "-- $TASK already applied ($APPLIED journal rows) — skipping"
    continue
  fi
  echo "-- $TASK generate+apply"
  bun --no-env-file scripts/multitenancy/migrate-test.ts generate "$TASK" --out "$OUT"
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$TASK" --apply --manifest "$OUT/$TASK/manifest.json"
done
echo "== chain journal =="
docker exec "$CONTAINER" psql -U postgres -d openbot_enterprise_w14b -c "select task_id, count(*) as steps from mt_task_migration_journal group by task_id order by task_id;"
echo "== restricted logins =="
docker exec "$CONTAINER" psql -U postgres -c "select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname like 'ent_w14b%' or rolname like 'ob_ent%' order by rolname;"
