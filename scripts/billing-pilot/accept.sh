#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 5 ]]; then
  echo 'Usage: accept.sh BUILD_EVIDENCE_DIR NEW_ACCEPTANCE_DIR MISMATCHED_WORKER_IMAGE BIFROST_NETWORK BIFROST_ORIGIN' >&2
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
export PILOT_BIFROST_NETWORK=$4
bifrost_origin=$5
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
smoke_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${compose[@]}" exec -T server bun - < "$script_dir/smoke.mjs" | tee "$output/smoke.jsonl"
bash "$script_dir/verify.sh" "$build" "$project" > "$output/runtime-after.jsonl"
cmp "$output/runtime-before.jsonl" "$output/runtime-after.jsonl"
worker=$(jq -er 'select(.service == "worker") | .container' "$output/runtime-after.jsonl")
jq -se '[.[] | select(.type == "worker-task" and .source == "schedule" and
  .status == "succeeded" and (.routineId | type == "string" and length > 0))] | length == 1' \
  "$output/smoke.jsonl" >/dev/null
# The isolated database contains only the smoke Routine. Its successful run
# must be accompanied by exactly one firing from the verified Worker.
if ! docker logs --since "$smoke_started" "$worker" 2>&1 | jq -Rsce '
  [split("\n")[] | fromjson? | objects | select(.event_category == "routine_sweep_completed"
    and (.fired | type == "number" and . > 0))]
  | select(length == 1 and .[0].fired == 1) | .[0]
' > "$output/worker-dispatch.jsonl"; then
  echo 'Expected exactly one Worker Routine firing during the smoke test' >&2
  exit 1
fi

# Record the release and image that verify.sh found on the running Server.
jq -n --slurpfile inputs "$build/inputs.json" --slurpfile image "$build/image.json" \
  --slurpfile runtime "$output/runtime-after.jsonl" --rawfile manifest "$build/platform-manifest.txt" \
  '$runtime[] | select(.service == "server" and .image == $image[0].Id and .commit == $inputs[0].release.commit)
   | $inputs[0].release + {image: .image, platformManifest: ($manifest | rtrimstr("\n"))}' \
  > "$output/target-provenance.json"
jq -e '.commit | test("^[0-9a-f]{40}$")' "$output/target-provenance.json" >/dev/null \
  || { echo 'Target provenance does not match the verified runtime' >&2; exit 1; }

# Provider keys belong to the separately deployed gateway. Server, Worker and
# the Harness fixture may carry only the credentials this pilot Compose file
# needs and no mount beyond the fixture script; names are recorded, never values.
# The allowlist stays here rather than in compose.yml so adding a key there fails.
declared=KEY_ENCRYPTION_KEY,INTELLIGENCE_API_KEY,MANAGED_AGENT_TOKEN,WORKER_SHARED_SECRET
for service in server worker fixture; do
  containers=$("${compose[@]}" ps -q "$service")
  [[ -n $containers && $containers != *$'\n'* ]] \
    || { echo "Expected one running container for $service" >&2; exit 1; }
  docker inspect --type container "$containers" | jq -c --arg service "$service" --arg declared "$declared" '
    .[0] | {service: $service,
      credentials: ([.Config.Env[] | split("=")[0] | select(test("KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL"; "i"))]
        - ($declared | split(","))),
      mounts: [.Mounts[].Destination]}'
done > "$output/provider-key-isolation.jsonl"
offenders=$(jq -cs '.[] | select(.credentials != [] or
  .mounts != (if .service == "fixture" then ["/fixture.mjs"] else [] end))' \
  "$output/provider-key-isolation.jsonl")
[[ -z $offenders ]] \
  || { echo "Credential or mount outside the pilot baseline: $offenders" >&2; exit 1; }

# The gateway must answer the verified Server through the controlled network
# and refuse the same direct call from the default Docker bridge.
probe='
  try {
    const response = await fetch(`${process.env.PILOT_BIFROST_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openbot-pilot-boundary-probe", messages: [], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(response.status);
  } catch (error) {
    console.log(`refused ${error.code ?? error.name}`);
  }'
controlled=$("${compose[@]}" exec -T --env PILOT_BIFROST_ORIGIN="$bifrost_origin" server bun -e "$probe")
[[ $controlled =~ ^[0-9]{3}$ && $controlled != 403 ]] \
  || { echo "Bifrost did not answer the Server through network $PILOT_BIFROST_NETWORK ($controlled)" >&2; exit 1; }
uncontrolled=$(docker run --rm --network bridge --env PILOT_BIFROST_ORIGIN="$bifrost_origin" oven/bun:1.4.3 bun -e "$probe")
[[ $uncontrolled == 'refused '* || $uncontrolled == 403 ]] \
  || { echo "Bifrost answered a direct call from the non-controlled network ($uncontrolled)" >&2; exit 1; }
jq -n --arg network "$PILOT_BIFROST_NETWORK" --arg origin "$bifrost_origin" \
  --argjson controlled "$controlled" --arg uncontrolled "$uncontrolled" \
  '{network: $network, origin: $origin, controlledStatus: $controlled,
    uncontrolled: ($uncontrolled | tonumber? // .)}' > "$output/bifrost-boundary.json"

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
