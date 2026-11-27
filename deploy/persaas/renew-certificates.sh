#!/usr/bin/env bash
set -euo pipefail
base=/opt/openbot-middleware/skillhub
for domain in www.persaas.cn sandboxes.persaas.cn casdoor.persaas.cn infisical.persaas.cn openobserve.persaas.cn; do
  "$base/certbot-venv/bin/certbot" renew --cert-name "$domain" \
    --config-dir "$base/acme-config" --work-dir "$base/acme-work" \
    --logs-dir "$base/acme-logs" --quiet
done
for site in www.persaas.cn:www.persaas.cn sandboxes:sandboxes.persaas.cn casdoor.persaas.cn:casdoor.persaas.cn infisical.persaas.cn:infisical.persaas.cn openobserve.persaas.cn:openobserve.persaas.cn; do
  target=/opt/1panel/1panel/www/sites/${site%%:*}/ssl
  source=$base/acme-config/live/${site#*:}
  install -m 644 "$source/fullchain.pem" "$target/fullchain.pem"
  install -m 600 "$source/privkey.pem" "$target/privkey.pem"
done
docker exec 1Panel-openresty-1334 openresty -t
docker exec 1Panel-openresty-1334 openresty -s reload
