#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Set Windows and Guacamole credentials, then run this script again."
  exit 1
fi

python3 prepare-config.py
docker compose up -d
echo "Guacamole: http://127.0.0.1:18082/"
