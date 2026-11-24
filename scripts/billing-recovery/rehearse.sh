#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

artifacts=${1:?"Usage: scripts/billing-recovery/rehearse.sh NEW_ARTIFACT_DIRECTORY"}
mkdir "$artifacts"
artifacts=$(cd "$artifacts" && pwd)
project="openbot-108-$(uuidgen | tr '[:upper:]' '[:lower:]')"
legacy=cf466ae4948c803227a530c7e24452c941d98713
legacy_dir=$(mktemp -d)
compose=(docker compose --env-file .env.test -p "$project" -f scripts/billing-recovery/compose.yml)
cleanup() {
  "${compose[@]}" down --volumes >&2
  rm -rf "$legacy_dir"
}
trap cleanup EXIT

git archive "$legacy" server/src server/tests/support/bifrost-evidence.ts | tar -x -C "$legacy_dir"
ln -s "$PWD/server/node_modules" "$legacy_dir/server/node_modules"
"${compose[@]}" up -d --wait >&2
"${compose[@]}" exec -T postgres createdb -U postgres recovery_source
addr=$("${compose[@]}" port postgres 5432)
export REHEARSAL_SOURCE="postgres://postgres:fixture@$addr/recovery_source"
export REHEARSAL_PROJECT="$project" REHEARSAL_ARTIFACTS="$artifacts"
export REHEARSAL_LEGACY="$legacy" REHEARSAL_LEGACY_DIR="$legacy_dir"
export REHEARSAL_HEAD
REHEARSAL_HEAD=$(git rev-parse HEAD)
DATABASE_URL=$REHEARSAL_SOURCE bun --no-env-file --env-file=.env.test server/scripts/migrate.ts >&2
bun --no-env-file server/scripts/rehearse-billing-recovery.ts | tee "$artifacts/result.json"
