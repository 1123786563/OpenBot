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
docker exec persaas-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --triggers --events --no-tablespaces opik' > "$tmp/opik.sql"
# Include container env files discovered from current middleware stacks.
python3 - <<'PYENV' > "$tmp/middleware-env.paths"
import runpy
m = runpy.run_path('/opt/persaas/middleware-config.py')
paths = {path for name, compose in m['projects']().items() for path in m['env_files'](compose, name, include_databases=True).values()}
for path in sorted(paths):
    print(path.relative_to('/opt'))
PYENV
tar -czf "$tmp/configuration.tar.gz" -C /opt -T "$tmp/middleware-env.paths" \
  persaas/credentials.json persaas/server.env persaas/worker.env \
  persaas/data.yml persaas/runtime/flexprice.env persaas/runtime/temporal.env persaas/collector.env \
  1panel/1panel/www/sites/openobserve.persaas.cn/proxy/root.conf \
  1panel/1panel/www/sites/www.persaas.cn/proxy/root.conf \
  1panel/1panel/www/conf.d/flexprice.persaas.cn.conf \
  1panel/1panel/www/sites/flexprice.persaas.cn/proxy \
  1panel/1panel/www/sites/flexprice.persaas.cn/ssl \
  persaas/renew-certificates.sh \
  1panel/apps/openresty/openresty/1pwaf/data/conf/sites.json \
  1panel/apps/openresty/openresty/1pwaf/data/sites/flexprice.persaas.cn \
  persaas/infisical-server.env persaas/infisical-worker.env \
  1panel/apps/local/infisical/infisical/.env \
  1panel/apps/local/bifrost/bifrost/.env 1panel/apps/local/bifrost/bifrost/bifrost.json \
  1panel/apps/local/bifrost/bifrost/docker-compose.yml \
  1panel/apps/local/opik/opik/.env 1panel/apps/local/opik/opik/docker-compose.yml \
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
