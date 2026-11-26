#!/bin/sh
set -eu

if [ "$#" != 2 ]; then
  echo "Usage: $0 <output.tar.gz> <x86_64|aarch64>" >&2
  exit 2
fi

case "$1" in
  /*) output=$1 ;;
  *) output=$PWD/$1 ;;
esac
case "$2" in
  x86_64) target=bun-linux-x64-baseline ;;
  aarch64) target=bun-linux-arm64 ;;
  *) echo "Unsupported Flash architecture: $2" >&2; exit 2 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
cd "$root"
bun build --compile --target="$target" --minify --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig agent-computer/src/flash-files.ts --outfile "$staging/worker"
install -m 0755 deploy/agent-sandbox/lease_watchdog.py "$staging/openbot-lease"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$output" -C "$staging" openbot-lease worker
