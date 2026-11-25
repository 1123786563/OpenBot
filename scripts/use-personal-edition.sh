#!/usr/bin/env bash
#
# Set the server's settings up for the personal edition: every key in .env.server.personal.example,
# written into deploy/openbot/.env.server with any earlier line for the same key removed, so each key
# appears once. Starts from .env.server.example when there is no file yet. Safe to rerun.
#
# ENV_FILE names another file to write, for tests.

. "$(dirname "$0")/require-bash.sh"

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/openbot/.env.server}"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/deploy/openbot/.env.server.example" "$ENV_FILE"
  printf '\033[2m%s\033[0m\n' "No deploy/openbot/.env.server yet, so started one from its .example."
fi

while IFS= read -r line; do
  case "$line" in
    '' | '#'*) continue ;;
  esac
  name="${line%%=*}"
  tmp="$(mktemp)"
  grep -vE "^$name=" "$ENV_FILE" > "$tmp" || true
  printf '%s\n' "$line" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
done < "$ROOT/deploy/openbot/.env.server.personal.example"

printf '\033[32m%s\033[0m\n' "Set deploy/openbot/.env.server up for the personal edition."
printf '%s\n' "Fill in the Intelligence settings there and OPENAI_API_KEY in deploy/agents/.env, then run: bash scripts/start.sh"
