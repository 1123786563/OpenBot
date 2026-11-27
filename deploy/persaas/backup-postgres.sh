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
for db in openbot casdoor flexprice temporal temporal_visibility infisical bifrost; do
  docker exec "$pg" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc --dbname "$1"' sh "$db" > "$tmp/$db.dump"
done
docker exec "$pg" sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$tmp/roles.sql"
docker exec persaas-lago-postgres pg_dump -U lago -Fc --dbname lago > "$tmp/lago.dump"
docker exec persaas-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --triggers --events --no-tablespaces opik' > "$tmp/opik.sql"
docker exec -u 0 persaas-lago-api cat /lago-secrets/keys.json > "$tmp/lago-secrets.json"
tar -czf "$tmp/configuration.tar.gz" -C /opt \
  persaas/credentials.json persaas/server.env persaas/worker.env \
  persaas/data.yml persaas/flexprice.env persaas/temporal.env \
  persaas/infisical-server.env persaas/infisical-worker.env \
  persaas/infisical-flexprice.env persaas/infisical-temporal.env \
  1panel/apps/local/infisical/infisical/.env \
  1panel/apps/local/bifrost/bifrost/.env 1panel/apps/local/bifrost/bifrost/bifrost.json \
  1panel/apps/local/bifrost/bifrost/docker-compose.yml \
  1panel/apps/local/opik/opik/.env 1panel/apps/local/opik/opik/docker-compose.yml \
  1panel/apps/local/lago/lago/.env 1panel/apps/local/lago/lago/docker-compose.yml \
  1panel/apps/local/lago/lago/secrets.rb \
  1panel/apps/mysql/mysql/.env 1panel/apps/mysql/mysql/conf \
  1panel/apps/clickhouse/clickhouse/persaas-opik.xml \
  1panel/apps/clickhouse/clickhouse/persaas-opik-user.xml \
  1panel/apps/casdoor/casdoor/.env 1panel/apps/casdoor/casdoor/conf \
  1panel/apps/pgvector/pgvector/.env \
  1panel/apps/redis-cluster/redis-cluster-master/.env
target=$base/postgres-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
tar -czf "$target" -C "$tmp" .
ln -sfn "${target##*/}" "$base/latest.tar.gz"
sha256sum "$target"
