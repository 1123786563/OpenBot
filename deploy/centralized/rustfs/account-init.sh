#!/bin/sh
set -eu
rc alias set bootstrap http://rustfs:19000 "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null
if ! rc admin service-account info bootstrap "$OPIK_S3_ACCESS_KEY" >/dev/null 2>&1; then
  rc admin service-account create bootstrap "$OPIK_S3_ACCESS_KEY" "$OPIK_S3_SECRET_KEY" \
    --policy /opik-policy.json >/dev/null
fi
