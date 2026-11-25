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
jq -n --arg commit "$(git rev-parse HEAD)" \
  '{tag:"pilot-built",release:{commit:$commit}}' > "$TEST_BUILD/inputs.json"
jq -n --arg id "$image" --arg commit "$(git rev-parse HEAD)" \
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
  'inspect --type')
    service=$4
    actual=$TEST_IMAGE
    if [[ -f $TEST_BUILD/replaced-$service ]]; then
      actual="sha256:$(printf '%064d' 3)"
    fi
    command=src/production-entry.ts
    if [[ $service == worker ]]; then command=../worker/src/index.ts; fi
    jq -n --arg service "$service" --arg image "$actual" --arg manifest "$TEST_MANIFEST" --arg command "$command" \
      '[{Id:$service,Image:$image,State:{Running:true},ImageManifestDescriptor:{digest:$manifest},
        Path:"/usr/local/bin/docker-entrypoint.sh",Args:["bun",$command],Config:{WorkingDir:"/app/server"},Mounts:[]}]'
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
      *' exec -T server bun - '*)
        cat >/dev/null
        echo '{"type":"worker-task","routineId":"fixture-routine","source":"schedule","status":"succeeded"}'
        ;;
      *' --force-recreate '*)
        touch "$TEST_BUILD/replaced-${!#}"
        ;;
    esac
    ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
PATH="$fixture/bin:$PATH" bash "$script_dir/accept.sh" "$TEST_BUILD" "$fixture/accepted" pilot-previous
jq -e '.event_category == "routine_sweep_completed" and .fired == 1' \
  "$fixture/accepted/worker-dispatch.jsonl" >/dev/null

rm "$TEST_BUILD/replaced-server" "$TEST_BUILD/replaced-worker"
if PATH="$fixture/bin:$PATH" TEST_FIRED=0 bash "$script_dir/accept.sh" \
  "$TEST_BUILD" "$fixture/no-firing" pilot-previous > "$fixture/result" 2>&1; then
  echo 'Expected a successful smoke receipt without a Worker firing to be refused' >&2
  exit 1
fi
grep -Fq 'Expected exactly one Worker Routine firing' "$fixture/result"
