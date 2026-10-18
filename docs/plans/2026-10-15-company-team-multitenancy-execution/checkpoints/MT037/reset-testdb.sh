#!/bin/bash
# MT037: recreate the enterprise test database fresh (deterministic full-suite runs).
# Rationale: MT069's billing regression test uses a fixed global-unique idempotency key
# (credit_grants.idempotency_key unique index), so the suite is single-run per database.
# This script drops/recreates the database and re-applies base migration + restricted
# logins + the fourteen-task multitenancy chain. The KB database is untouched (its rows
# are run-prefix isolated and its migrations are idempotent).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../../../../../server"
source /tmp/mt037-env.sh
docker exec mt037-impl-pg psql -U postgres -c "DROP DATABASE IF EXISTS openbot_enterprise_mt037_test;"
docker exec mt037-impl-pg psql -U postgres -c "DROP DATABASE IF EXISTS openbot_enterprise_mt037_test_assigned;"
docker exec mt037-impl-pg psql -U postgres -c "CREATE DATABASE openbot_enterprise_mt037_test;"
docker exec mt037-impl-pg psql -U postgres -c "CREATE DATABASE openbot_enterprise_mt037_test_assigned;"
echo "== base migration + restricted logins =="
bun --no-env-file scripts/enterprise-test-db.ts migrate
echo "== multitenancy chain (fourteen tasks) =="
bash "$DIR/chain-apply.sh"
