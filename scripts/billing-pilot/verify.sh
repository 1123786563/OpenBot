#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ! $2 =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'Usage: verify.sh BUILD_EVIDENCE_DIR COMPOSE_PROJECT' >&2
  exit 2
fi
evidence=$1
project=$2
if [[ ! -s $evidence/inputs.json || ! -s $evidence/buildx.json || ! -s $evidence/image.json || ! -s $evidence/platform-manifest.txt ]]; then
  echo 'Build evidence is missing or incomplete' >&2
  exit 1
fi
release=$(jq -ce '.release | select(type == "object" and (.commit | test("^[0-9a-f]{40}$")))' "$evidence/inputs.json")
commit=$(jq -r .commit <<< "$release")
manifest=$(cat "$evidence/platform-manifest.txt")
[[ $manifest =~ ^sha256:[0-9a-f]{64}$ ]]
image=$(jq -er '.Id | select(test("^sha256:[0-9a-f]{64}$"))' "$evidence/image.json")
jq -e --arg id "$image" '[."containerimage.digest", ."containerimage.config.digest"] | index($id) != null' "$evidence/buildx.json" >/dev/null
jq -e --arg id "$image" --arg commit "$commit" \
  '.Id == $id and .Labels["org.opencontainers.image.revision"] == $commit' "$evidence/image.json" >/dev/null

refuse() {
  echo "$1: $2" >&2
  exit 1
}

for service in server worker; do
  containers=$(docker ps -q --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --filter 'label=com.docker.compose.oneoff=False')
  [[ -n $containers && $containers != *$'\n'* ]] || refuse "$service" 'expected one running Compose service container'
  case $service in
    server) command=src/production-entry.ts ;;
    worker) command=../worker/src/index.ts ;;
  esac
  observed=$(docker inspect --type container "$containers" | jq -c '.[0] | {
    container: .Id, image: .Image, running: .State.Running, startedAt: .State.StartedAt, manifestDigest: .ImageManifestDescriptor.digest,
    command: ([.Path] + .Args), workdir: .Config.WorkingDir, mounts: [.Mounts[].Destination]
  }')
  actual=$(jq -r .image <<< "$observed")
  [[ $actual == "$image" ]] || refuse "$service" "untraceable or mismatched image $actual (expected $image)"
  jq -e --arg manifest "$manifest" '.manifestDigest == $manifest' <<< "$observed" >/dev/null \
    || refuse "$service" "platform manifest does not match $manifest"
  jq -e --arg command "$command" '
    .running and .command == ["/usr/local/bin/docker-entrypoint.sh", "bun", $command] and .workdir == "/app/server" and
    (.mounts | all(. != "/" and . != "/app" and (startswith("/app/") | not)))
  ' <<< "$observed" >/dev/null || refuse "$service" 'unexpected entrypoint, workdir, or mount over image source'
  if [[ $service == server ]]; then
    identity=$(docker exec "$containers" bun -e '
      const response = await fetch("http://127.0.0.1:3001/release", {signal: AbortSignal.timeout(5000)});
      if (!response.ok) process.exit(1);
      console.log(await response.text());
    ') || refuse "$service" 'running process did not report its release identity'
    jq -e --argjson release "$release" '. == $release' <<< "$identity" >/dev/null \
      || refuse "$service" 'running release identity differs from the build record'
  fi
  jq -c --arg service "$service" --arg commit "$commit" '. + {service:$service, commit:$commit}' <<< "$observed"
done
