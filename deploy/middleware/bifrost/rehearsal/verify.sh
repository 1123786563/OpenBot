#!/usr/bin/env bash
set -euo pipefail

directory=$(cd "$(dirname "$0")/.." && pwd)
image=maximhq/bifrost:v2.6.0@sha256:5968d007ba4f74ee01bc4ceb071decb9927a0b7bb43dbb9072208f75e2d522e3
previous=maximhq/bifrost:v2.4.0@sha256:a1c90607dcfd13c1fb2f9476ceb3bb24407a50ade7fdf3e61a59fb42b09e5c57
database=postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32
python=python:3-alpine@sha256:0f9552bb28711333da16915ec146f5e6bb44a7fdac9ced15dc17c2e0206346dd

actual=$(env -u BIFROST_IMAGE BIFROST_SETUP_TOKEN=fixture BIFROST_DB_HOST=fixture-db \
  BIFROST_DB_PASSWORD=fixture docker compose --env-file /dev/null \
  -f "$directory/docker-compose.yml" config --images)
if [[ "$actual" != "$image" ]]; then
  echo "Expected Compose to resolve $image, got $actual" >&2
  exit 1
fi
echo "Compose resolves $image"

# Use a private network with no published ports or access to external providers.
temp=$(mktemp -d "${TMPDIR:-/tmp}/openbot-bifrost-rehearsal-XXXXXXXX")
project=${temp##*/}
cleanup() {
  status=$?
  if (( status != 0 )); then
    docker logs --tail 25 "$project-gateway" >&2 || true
    docker logs --tail 15 "$project-fixture" >&2 || true
    if [[ -n "${market_rehearsal:-}" ]]; then
      docker logs --tail 15 "$project-edge" >&2 || true
    fi
  fi
  docker rm -fv "$project-edge" "$project-gateway" "$project-fixture" "$project-db" >/dev/null 2>&1 || true
  docker network rm "$project" >/dev/null 2>&1 || true
  rm -rf "$temp"
}
trap cleanup EXIT
docker network create --internal "$project" >/dev/null

docker run -d --name "$project-db" --network "$project" --network-alias db \
  -e POSTGRES_USER=bifrost -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=before_upgrade \
  --tmpfs /var/lib/postgresql/data:rw,size=512m "$database" -c fsync=off >/dev/null
docker run -d --name "$project-fixture" --network "$project" --network-alias upstream \
  -v "$directory/rehearsal/fixture.py:/fixture.py:ro" "$python" python /fixture.py upstream >/dev/null

for attempt in {1..60}; do
  if docker exec "$project-db" pg_isready -h 127.0.0.1 -U bifrost -d before_upgrade >/dev/null; then
    break
  fi
  if (( attempt == 60 )); then
    docker logs --tail 30 "$project-db" >&2
    exit 1
  fi
  sleep 1
done

docker exec -i "$project-fixture" python /fixture.py seed < "$directory/bifrost.json" > "$temp/seed.json"

docker exec -i "$project-fixture" python /fixture.py restore < "$directory/bifrost.json" > "$temp/restore.json"
printf '%s\n' '{"gpt-4o-mini":{"provider":"openai","mode":"chat","input_cost_per_token":0,"output_cost_per_token":0}}' > "$temp/pricing.json"

start_gateway() {
  echo "Starting $1 against $2"
  docker run -d --name "$project-gateway" --network "$project" --network-alias gateway \
    -e BIFROST_SETUP_TOKEN=fixture-setup-token \
    -e BIFROST_DB_HOST=db -e BIFROST_DB_PORT=5432 -e BIFROST_DB_NAME="$2" \
    -e BIFROST_DB_USER=bifrost -e BIFROST_DB_PASSWORD=fixture -e BIFROST_DB_SSL_MODE=disable \
    -v "$3:/app/data/config.json:ro" -v "$temp/pricing.json:/fixture-pricing.json:ro" "$1" >/dev/null
}

start_gateway "$previous" before_upgrade "$temp/seed.json"
docker exec "$project-fixture" python /fixture.py models
docker rm -fv "$project-gateway" >/dev/null

docker exec "$project-db" pg_dump -U bifrost -Fc before_upgrade > "$temp/before.dump"
docker exec "$project-db" createdb -U bifrost restored_upgrade
docker exec -i "$project-db" pg_restore --exit-on-error -U bifrost -d restored_upgrade < "$temp/before.dump"
echo "Restored v2.4.0 PostgreSQL snapshot into a separate database"

# The candidate starts with the deployment's database config, local pricing data,
# and a fresh container filesystem. Provider and routing state must come from the snapshot.
start_gateway "$image" restored_upgrade "$temp/restore.json"
docker exec "$project-fixture" python /fixture.py models
docker exec "$project-fixture" python /fixture.py skills

if [[ "${1:-}" == "--skill-market" || "${1:-}" == "--skill-migration" ]]; then
  market_rehearsal=1
  repository=$(cd "$directory/../../.." && pwd)
  docker exec "$project-fixture" python /fixture.py seed-market
  docker exec -i "$project-db" psql -v ON_ERROR_STOP=1 -U bifrost -d restored_upgrade <<'SQL'
CREATE ROLE openbot_skill_reader LOGIN PASSWORD 'fixture-market-reader';
UPDATE public.skill_files SET blob_id = NULL
WHERE skill_version_id IN (
  SELECT version.id FROM public.skill_versions AS version
  JOIN public.skills AS skill ON skill.id = version.skill_id
  WHERE skill.name = 'missing-blob'
);
UPDATE public.skill_files SET file_size_bytes = file_size_bytes + 1
WHERE skill_version_id IN (
  SELECT version.id FROM public.skill_versions AS version
  JOIN public.skills AS skill ON skill.id = version.skill_id
  WHERE skill.name = 'wrong-size'
);
SQL
  docker exec -i "$project-db" psql -v ON_ERROR_STOP=1 -U bifrost -d restored_upgrade \
    < "$directory/skill-market-reader.sql"
  docker run --rm --network "$project" -v "$repository:/work:ro" -w /work \
    -e BIFROST_SKILL_MARKET_DATABASE_URL=postgres://openbot_skill_reader:fixture-market-reader@db/restored_upgrade \
    oven/bun:1.4.3-alpine bun --no-env-file server/tests/support/bifrost-market-rehearsal.ts
  if [[ "${1:-}" == "--skill-migration" ]]; then
    docker exec "$project-db" createdb -U bifrost skillhub_fixture
    docker run --rm --network "$project" -v "$repository:/work:ro" -w /work \
      oven/bun:1.4.3-alpine bun --no-env-file server/tests/support/bifrost-migration-rehearsal.ts
  fi
  docker exec "$project-fixture" python /fixture.py market-pointer

  mkdir -p "$temp/edge/private"
  sed 's#127\.0\.0\.1:18080#gateway:8080#' "$directory/../openresty/openbot-middleware.conf" \
    > "$temp/market-edge.conf"
  cp "$directory/../openresty/proxy-headers.conf" "$temp/edge/"
  printf '%s\n' 'set $openbot_otlp_authorization "Bearer fixture";' > "$temp/edge/private/otlp-token.conf"
  docker run -d --name "$project-edge" --network "$project" --network-alias edge \
    -v "$temp/market-edge.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$temp/edge:/www/openbot-middleware:ro" nginx:1.28-alpine >/dev/null
  docker exec "$project-edge" nginx -t
  docker exec "$project-fixture" python /fixture.py market-edge http://edge external
  docker run --rm --network "container:$project-edge" \
    -v "$directory/rehearsal/fixture.py:/fixture.py:ro" "$python" \
    python /fixture.py market-edge http://127.0.0.1 local
fi
