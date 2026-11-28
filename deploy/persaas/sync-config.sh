#!/usr/bin/env bash
set -euo pipefail
cd /opt/persaas
# Middleware is owned exclusively by Persaas Infrastructure.
python3 middleware-config.py apply --project temporal
python3 middleware-config.py apply --project flexprice
