#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/repo"
cd "$fixture/repo"
git init -q
printf 'committed source\n' > source
git add source
git -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
printf 'dirty source\n' > source
if bash "$script_dir/build.sh" "$fixture/evidence" openbot-pilot-test:local linux/arm64 > "$fixture/result" 2>&1; then
  echo 'Expected a dirty checkout to be refused' >&2
  exit 1
fi
grep -Fq 'Build requires a clean Git checkout' "$fixture/result" || { cat "$fixture/result" >&2; exit 1; }
test ! -e "$fixture/evidence"

# A Compose project with no approved build record cannot be accepted.
if bash "$script_dir/verify.sh" "$fixture/missing" pilot-test > "$fixture/result" 2>&1; then
  echo 'Expected missing Buildx evidence to be refused' >&2
  exit 1
fi
grep -Fq 'Build evidence is missing or incomplete' "$fixture/result" || { cat "$fixture/result" >&2; exit 1; }

# The isolated fixture has one scheduled Routine. Current Worker logs record
# counts, so the smoke receipt supplies the Routine ID.
mkdir "$fixture/bin" "$fixture/build"
export TEST_BUILD="$fixture/build"
image="sha256:$(printf '%064d' 1)"
manifest="sha256:$(printf '%064d' 2)"
export TEST_IMAGE="$image" TEST_MANIFEST="$manifest"
commit=$(git rev-parse HEAD)
jq -n --arg commit "$commit" \
  '{tag:"pilot-built",release:{commit:$commit,version:"0.0.0-pilot.fixture"}}' > "$TEST_BUILD/inputs.json"
jq -n --arg id "$image" --arg commit "$commit" \
  '{Id:$id,Labels:{"org.opencontainers.image.revision":$commit}}' > "$TEST_BUILD/image.json"
jq -n --arg id "$image" '{"containerimage.config.digest":$id}' > "$TEST_BUILD/buildx.json"
printf '%s\n' "$manifest" > "$TEST_BUILD/platform-manifest.txt"

cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail


case "$1 $2" in
  'image inspect')
    if [[ $3 == pilot-built ]]; then
      echo "$TEST_IMAGE"
    else
      echo "sha256:$(printf '%064d' 3)"
    fi
    ;;
  'ps -q') printf '%s\n' "${7##*=}" ;;
  'run --rm')
    # Only the controlled network reaches the gateway.
    if [[ $4 == "$TEST_BIFROST_NETWORK" ]]; then
      echo 401
    else
      echo "${TEST_UNCONTROLLED:-refused ENOTFOUND}"
    fi
    ;;
  'inspect --type')
    service=$4
    actual=$TEST_IMAGE
    if [[ -f $TEST_BUILD/replaced-$service ]]; then
      actual="sha256:$(printf '%064d' 3)"
    fi
    command=src/production-entry.ts
    if [[ $service == worker ]]; then command=../worker/src/index.ts; fi
    env='[]'
    mounts='[]'
    case $service in
      server) env='["NODE_ENV=development","DATABASE_URL=postgres://openbot:pilot-only@postgres:5432/openbot",
        "KEY_ENCRYPTION_KEY=fixture-encryption-key","INTELLIGENCE_API_KEY=cpk-offline-fixture",
        "MANAGED_AGENT_TOKEN=pilot-offline-agent","WORKER_SHARED_SECRET=pilot-offline-worker"]' ;;
      worker) env='["DATABASE_URL=postgres://openbot:pilot-only@postgres:5432/openbot","WORKER_SHARED_SECRET=pilot-offline-worker"]' ;;
      fixture) mounts='[{"Destination":"/fixture.mjs"}]' ;;
    esac
    if [[ $service == "${TEST_PROVIDER_KEY_SERVICE:-}" ]]; then
      env=$(jq -cn --argjson env "$env" '$env + ["ZHIPU_API_KEY=fixture-provider-key"]')
    fi
    if [[ $service == "${TEST_PROVIDER_KEY_MOUNT_SERVICE:-}" ]]; then
      mounts=$(jq -cn --argjson mounts "$mounts" '$mounts + [{"Destination":"/run/secrets/zhipu"}]')
    fi
    jq -n --arg service "$service" --arg image "$actual" --arg manifest "$TEST_MANIFEST" --arg command "$command" \
      --argjson env "$env" --argjson mounts "$mounts" \
      '[{Id:$service,Image:$image,State:{Running:true},ImageManifestDescriptor:{digest:$manifest},
        Path:"/usr/local/bin/docker-entrypoint.sh",Args:["bun",$command],Config:{WorkingDir:"/app/server",Env:$env},
        Mounts:$mounts}]'
    ;;
  'exec server') jq -c .release "$TEST_BUILD/inputs.json" ;;
  'logs --since')
    [[ $4 == worker ]]
    echo 'Worker starting'
    echo '{"event_category":"routine_sweep_completed","fired":0}'
    echo '{"event_category":"routine_sweep_completed","fired":'"${TEST_FIRED:-1}"'}'
    ;;
  'compose --env-file')
    case " $* " in
      *' ps -q '*) printf '%s\n' "${!#}" ;;
      *' exec -T server bun - '*)
        cat >/dev/null
        echo '{"type":"worker-task","routineId":"fixture-routine","source":"schedule","status":"succeeded"}'
        ;;
      *' exec -T '*) echo "${TEST_CONTROLLED:-401}" ;;
      *' --force-recreate '*)
        touch "$TEST_BUILD/replaced-${!#}"
        ;;
    esac
    ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
export TEST_BIFROST_NETWORK=pilot-bifrost

# Runs acceptance against the mock Docker. Leading VAR=value assignments are
# exported for that run only.
accept() {
  local dir=$1
  shift
  rm -f "$TEST_BUILD"/replaced-*
  env "$@" PATH="$fixture/bin:$PATH" bash "$script_dir/accept.sh" \
    "$TEST_BUILD" "$fixture/$dir" pilot-previous "$TEST_BIFROST_NETWORK" http://bifrost:8080
}
refused() {
  local message=$1 dir=$2
  shift 2
  if accept "$dir" "$@" > "$fixture/$dir.log" 2>&1; then
    echo "Expected $dir to be refused" >&2
    exit 1
  fi
  grep -Fq "$message" "$fixture/$dir.log" || { cat "$fixture/$dir.log" >&2; exit 1; }
}

accept accepted
jq -e '.event_category == "routine_sweep_completed" and .fired == 1' \
  "$fixture/accepted/worker-dispatch.jsonl" >/dev/null
refused 'Expected exactly one Worker Routine firing' no-firing TEST_FIRED=0

# The acceptance records the release and image verified on the running Server.
jq -e --arg commit "$commit" --arg image "$image" --arg manifest "$manifest" \
  '.commit == $commit and .version == "0.0.0-pilot.fixture" and
  .image == $image and .platformManifest == $manifest' \
  "$fixture/accepted/target-provenance.json" >/dev/null

# Provider keys stay in the Bifrost workload: server, worker and fixture carry
# only the credentials the Compose file declares and no mount beyond the fixture script.
jq -se 'map(.service) == ["server", "worker", "fixture"] and all(.credentials == []) and
  .[0].mounts == [] and .[1].mounts == [] and .[2].mounts == ["/fixture.mjs"]' \
  "$fixture/accepted/provider-key-isolation.jsonl" >/dev/null
refused '"service":"worker","credentials":["ZHIPU_API_KEY"]' provider-key TEST_PROVIDER_KEY_SERVICE=worker
grep -Fq 'fixture-provider-key' "$fixture/provider-key.log" \
  && { echo 'The refusal printed the credential value' >&2; exit 1; }
refused '"service":"server","credentials":[],"mounts":["/run/secrets/zhipu"]' \
  provider-mount TEST_PROVIDER_KEY_MOUNT_SERVICE=server

# The gateway answers the Server through the controlled network and refuses
# the same direct call from any other network.
jq -e '.network == "pilot-bifrost" and .origin == "http://bifrost:8080" and
  .controlledStatus == 401 and .uncontrolled == "refused ENOTFOUND"' \
  "$fixture/accepted/bifrost-boundary.json" >/dev/null
refused 'Bifrost answered a direct call from the non-controlled network (401)' \
  open-boundary TEST_UNCONTROLLED=401
refused 'Bifrost did not answer the Server through network pilot-bifrost (refused ECONNREFUSED)' \
  unreachable TEST_CONTROLLED='refused ECONNREFUSED'
accept boundary-acl TEST_UNCONTROLLED=403
jq -e '.uncontrolled == 403' "$fixture/boundary-acl/bifrost-boundary.json" >/dev/null
