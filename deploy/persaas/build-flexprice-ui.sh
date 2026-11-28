#!/usr/bin/env bash
set -euo pipefail
out=${1:?Usage: build-flexprice-ui.sh /absolute/path/to/output.tar.gz [source-directory]}
source_dir=${2:-/Users/wuyj/IdeaProjects/flexprice-front}
case "$out" in /*) ;; *) echo 'Output must be an absolute path' >&2; exit 2 ;; esac
cd "$source_dir"
npm ci --no-audit --no-fund
VITE_API_URL=/v1 VITE_APP_ENV=self-hosted VITE_AUTH_ENABLED=true \
  VITE_AUTH_PROVIDER=flexprice VITE_POSTHOG_ENABLED=false \
  VITE_INTERCOM_ENABLED=false VITE_PADDLE_ENABLED=false npm run build
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out" -C dist .
