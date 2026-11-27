#!/usr/bin/env bash
set -euo pipefail
version=v2.0.22
out=${1:?Usage: build-flexprice-ui.sh /absolute/path/to/output.tar.gz}
case "$out" in /*) ;; *) echo 'Output must be an absolute path' >&2; exit 2 ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location "https://codeload.github.com/flexprice/flexprice-front/tar.gz/refs/tags/$version" -o "$work/source.tar.gz"
mkdir "$work/source"
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
cd "$work/source"
npm ci --no-audit --no-fund
VITE_API_URL=/v1 VITE_APP_ENV=self-hosted VITE_AUTH_ENABLED=true \
  VITE_AUTH_PROVIDER=flexprice VITE_POSTHOG_ENABLED=false \
  VITE_INTERCOM_ENABLED=false VITE_PADDLE_ENABLED=false npm run build
COPYFILE_DISABLE=1 tar -czf "$out" -C dist .
