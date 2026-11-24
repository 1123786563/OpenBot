#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo 'Usage: build.sh NEW_EVIDENCE_DIR IMAGE_TAG PLATFORM' >&2
  exit 2
fi
evidence=$1
image=$2
platform=$3
if [[ -n $(git status --porcelain --untracked-files=all) ]]; then
  echo 'Build requires a clean Git checkout' >&2
  exit 1
fi
repo=$(git rev-parse --show-toplevel)
commit=$(git rev-parse HEAD)
repository=${PILOT_SOURCE_REPOSITORY:-1123786563/OpenBot}
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
mkdir -m 700 -- "$evidence"
context=$(mktemp)
trap 'rm -f "$context"' EXIT
git -C "$repo" archive --format=tar "$commit" > "$context"
context_sha=$(shasum -a 256 "$context" | cut -d ' ' -f 1)
version="0.0.0-pilot.${commit:0:12}"
jq -n --arg image "$image" --arg platform "$platform" --arg contextSha "$context_sha" \
  --arg commit "$commit" --arg version "$version" --arg repository "$repository" \
  '{tag:$image, platform:$platform, dockerfile:"server/Dockerfile", contextSha256:$contextSha,
    release:{commit:$commit,version:$version,repository:$repository,channel:"pilot",distributionId:"openbot-billing-pilot"}}' \
  > "$evidence/inputs.json"
docker version > "$evidence/docker-version.txt"
docker buildx version >> "$evidence/docker-version.txt"
BUILDX_METADATA_PROVENANCE=max docker buildx build --load --platform "$platform" \
  --file server/Dockerfile --tag "$image" --progress plain \
  --metadata-file "$evidence/buildx.json" \
  --build-arg "OPENBOT_BUILD_COMMIT=$commit" \
  --build-arg "OPENBOT_BUILD_VERSION=$version" \
  --build-arg "OPENBOT_BUILD_REPOSITORY=$repository" \
  --build-arg OPENBOT_BUILD_DISTRIBUTION_ID=openbot-billing-pilot \
  --build-arg OPENBOT_BUILD_CHANNEL=pilot \
  --label "org.opencontainers.image.revision=$commit" \
  --label "org.opencontainers.image.source=https://github.com/$repository" \
  - < "$context" 2>&1 | tee "$evidence/build.log"
image_id=$(docker image inspect "$image" --format '{{.Id}}')
jq -e --arg id "$image_id" '[."containerimage.digest", ."containerimage.config.digest"] | index($id) != null' "$evidence/buildx.json" >/dev/null
docker image inspect "$image_id" | jq '.[0] | {Id, Descriptor, RepoDigests, Os, Architecture, Variant, Labels:.Config.Labels}' \
  > "$evidence/image.json"
manifest=$(docker image inspect --platform "$platform" "$image" --format '{{.Descriptor.Digest}}')
[[ $manifest =~ ^sha256:[0-9a-f]{64}$ ]]
printf '%s\n' "$manifest" > "$evidence/platform-manifest.txt"
