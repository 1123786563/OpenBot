#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/persaas-postgres-backup.lock
flock -n 9 || exit 0
base=/opt/persaas/backups
mkdir -p "$base"
tmp=$(mktemp -d "$base/.pending.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
pg=1Panel-pgvector-T1Hu
for db in openbot casdoor flexprice temporal temporal_visibility; do
  docker exec "$pg" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc --dbname "$1"' sh "$db" > "$tmp/$db.dump"
done
docker exec "$pg" sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$tmp/roles.sql"
tar -czf "$tmp/configuration.tar.gz" -C /opt \
  persaas/credentials.json persaas/server.env persaas/worker.env \
  persaas/data.yml persaas/flexprice.env persaas/temporal.env \
  1panel/apps/casdoor/casdoor/.env 1panel/apps/casdoor/casdoor/conf \
  1panel/apps/pgvector/pgvector/.env \
  1panel/apps/redis-cluster/redis-cluster-master/.env
target=$base/postgres-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
tar -czf "$target" -C "$tmp" .
ln -sfn "${target##*/}" "$base/latest.tar.gz"
sha256sum "$target"
