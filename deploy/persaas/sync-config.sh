#!/usr/bin/env bash
set -euo pipefail
cd /opt/persaas
mkdir -p runtime
chmod 700 runtime
# Compose validates env_file paths before running a tool container.
for service in flexprice temporal; do
  test -e "runtime/$service.env" || install -m 600 /dev/null "runtime/$service.env"
done
docker compose -f data.yml run --rm --no-deps --interactive=false sync-flexprice
docker compose -f data.yml run --rm --no-deps --interactive=false sync-temporal
