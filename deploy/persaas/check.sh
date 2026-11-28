#!/usr/bin/env bash
set -euo pipefail
# Run on the corresponding node after copying its compose file to /opt/persaas.
role=${1:?Usage: check.sh data|apps}
cd /opt/persaas
case "$role" in
  data)
    docker compose -f data.yml ps
    curl --fail --silent --show-error http://127.0.0.1:18083/health
    curl --fail --silent --show-error https://casdoor.persaas.cn/.well-known/openid-configuration >/dev/null
    curl --fail --silent --show-error https://sandboxes.persaas.cn/health
    curl --fail --silent --show-error https://www.persaas.cn/health
    curl --fail --silent --show-error https://infisical.persaas.cn/api/v1/admin/config >/dev/null
    curl --fail --silent --show-error https://openobserve.persaas.cn/healthz >/dev/null
    curl --fail --silent --show-error https://opik.persaas.cn/health
    curl --fail --silent --show-error http://127.0.0.1:18085/healthz
    for url in https://bifrost.persaas.cn/api/providers https://opik.persaas.cn/; do
      status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$url")
      test "$status" = 401
    done
    code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://www.persaas.cn/api/me)
    test "$code" = 401
    ;;
  apps)
    systemctl is-active --quiet persaas-data-link
    docker compose -f apps.yml ps
    curl --fail --silent --show-error http://127.0.0.1:18001/health
    ;;
  *) echo "Unknown role: $role" >&2; exit 2 ;;
esac
