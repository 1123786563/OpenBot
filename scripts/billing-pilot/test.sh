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
