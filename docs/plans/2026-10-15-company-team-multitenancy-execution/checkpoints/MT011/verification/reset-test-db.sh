#!/bin/bash
# MT011 dedicated test-database reset (idempotent): drop + recreate + base
# migration + the seven task migrations in dependency order
# (MT004→MT008→MT112→MT012→MT014→MT010→MT009). Trust container, loopback only.
set -euo pipefail
cd "$(dirname "$0")/../../../../../../server"

docker exec mt011-impl-pg psql -U postgres -c "drop database if exists openbot_enterprise_mt011" >/dev/null
docker exec mt011-impl-pg psql -U postgres -c "drop database if exists openbot_enterprise_mt011_assigned" >/dev/null
docker exec mt011-impl-pg psql -U postgres -c "create database openbot_enterprise_mt011" >/dev/null
docker exec mt011-impl-pg psql -U postgres -c "create database openbot_enterprise_mt011_assigned" >/dev/null

export TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55482/openbot_enterprise_mt011'
export ENTERPRISE_TEST_DIRECTORY_DATABASE_URL='postgresql://ent_mt011_dir:mt011-dir-pw@127.0.0.1:55482/openbot_enterprise_mt011'
export ENTERPRISE_TEST_DATA_DATABASE_URL='postgresql://ent_mt011_data:mt011-data-pw@127.0.0.1:55482/openbot_enterprise_mt011'
export ENTERPRISE_TEST_OPERATOR_DATABASE_URL='postgresql://ent_mt011_opr:mt011-opr-pw@127.0.0.1:55482/openbot_enterprise_mt011'

bun --no-env-file scripts/enterprise-test-db.ts migrate

for task in MT004 MT008 MT112 MT012 MT014 MT010 MT009; do
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$task" >/dev/null 2>&1
  MANIFEST_TASK="$task" bun --no-env-file -e '
    const { buildPlan, manifestFor } = await import("./scripts/multitenancy/migrate-test.ts");
    const task = process.env.MANIFEST_TASK;
    await Bun.write(`/tmp/mt011-manifest-${task}.json`, JSON.stringify(manifestFor(buildPlan(task)), null, 2) + "\n");
  '
  bun --no-env-file scripts/multitenancy/migrate-test.ts migrate "$task" --apply --manifest "/tmp/mt011-manifest-$task.json" >/dev/null
  echo "applied $task"
done
echo "MT011 test database ready"
