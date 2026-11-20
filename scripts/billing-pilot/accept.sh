#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo 'Usage: accept.sh BUILD_EVIDENCE_DIR NEW_ACCEPTANCE_DIR MISMATCHED_WORKER_IMAGE' >&2
  exit 2
fi
script_dir=$(cd "$(dirname "$0")" && pwd)
build=$1
output=$2
alternate=$(docker image inspect "$3" --format '{{.Id}}')
expected=$(jq -er .Id "$build/image.json")
[[ $alternate != "$expected" ]] || { echo 'The negative test needs a different backend image' >&2; exit 1; }
# Verify the generated tag still names the exact built image before starting any service.
export PILOT_IMAGE
PILOT_IMAGE=$(jq -er .tag "$build/inputs.json")
[[ $(docker image inspect "$PILOT_IMAGE" --format '{{.Id}}') == "$expected" ]] \
  || { echo 'The recorded image tag no longer names the built image' >&2; exit 1; }
export PILOT_ENCRYPTION_KEY
PILOT_ENCRYPTION_KEY=$(openssl rand -base64 32)
project="openbot-billing-pilot-$(openssl rand -hex 8)"
mkdir -m 700 -- "$output"
printf '%s\n' "$project" > "$output/project.txt"
compose=(docker compose --env-file /dev/null -f "$script_dir/compose.yml" -p "$project")
cleanup() {
  local status=$?
  if [[ $status != 0 ]]; then
    "${compose[@]}" logs --no-color > "$output/failure.log" 2>&1 || true
  fi
  "${compose[@]}" down --volumes > "$output/cleanup.log" 2>&1
}
trap cleanup EXIT

"${compose[@]}" up -d --wait --wait-timeout 120 > "$output/deploy.log" 2>&1
bash "$script_dir/verify.sh" "$build" "$project" > "$output/runtime-before.jsonl"
"${compose[@]}" exec -T server bun - < "$script_dir/smoke.mjs" | tee "$output/smoke.jsonl"
bash "$script_dir/verify.sh" "$build" "$project" > "$output/runtime-after.jsonl"
cmp "$output/runtime-before.jsonl" "$output/runtime-after.jsonl"
worker=$(jq -er 'select(.service == "worker") | .container' "$output/runtime-after.jsonl")
routine=$(jq -er 'select(.type == "worker-task") | .routineId' "$output/smoke.jsonl")
docker logs "$worker" 2>&1 | jq -Rce --arg routine "$routine" '
  fromjson? | select(.type == "routine-sweep" and (.fired | index($routine) != null))
' > "$output/worker-dispatch.jsonl"

assert_rejected() {
  local service=$1
  if bash "$script_dir/verify.sh" "$build" "$project" > "$output/rejected-$service.log" 2>&1; then
    echo "Expected $service to be rejected" >&2
    exit 1
  fi
  grep -Fq "$service: untraceable or mismatched image" "$output/rejected-$service.log"
}

PILOT_IMAGE=$3 "${compose[@]}" up -d --force-recreate --no-deps --pull never worker \
  > "$output/replace-worker.log" 2>&1
assert_rejected worker

cat > "$output/untraceable-server.yml" <<'YAML'
services:
  server:
    image: oven/bun:1.4.3
    entrypoint: [sleep, '120']
    healthcheck:
      disable: true
YAML
"${compose[@]}" -f "$output/untraceable-server.yml" up -d --force-recreate --no-deps --pull never server \
  > "$output/replace-server.log" 2>&1
assert_rejected server
printf 'Pilot accepted. Evidence saved in %s\n' "$output"
