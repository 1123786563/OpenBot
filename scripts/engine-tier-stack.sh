#!/bin/bash
# Bring up the stack the engine tier (`tests/e2e/*.e2e.ts`, run by `bunx e2e run --config e2e.config.ts`)
# needs, and take it down again. Nothing here is product config: it runs Casdoor from the repo's own
# casdoor/app.conf + casdoor/init-db.sql against a PostgreSQL you point at, on loopback ports that do
# not collide with a shared dev stack.
#
#   API_PORT=3221 APP_PORT=3010 bash scripts/engine-tier-stack.sh          # up
#   API_PORT=3221 APP_PORT=3010 TEARDOWN=1 bash scripts/engine-tier-stack.sh  # down
#
# Traps this encodes, each learned the hard way:
#   * Casdoor's config is read from `/conf`, not `/app/conf` (mounting the wrong path silently falls
#     back to MySQL on :3306).
#   * `initAdminPassword = 123` must be present before first boot, because auth.setup.e2e.ts signs in
#     as admin/123.
#   * `application.redirect_uris` is a JSON array string; a comma list makes Casdoor answer
#     `invalid character 'h' looking for beginning of value`.
#   * the client pair must be read from the database that is live now — `psql -Atc` separates columns
#     with `|`, so concatenate inside the SELECT instead of splitting on whitespace.
#   * `PORT` must equal `SERVER_PORT` (server/src/config.ts refuses otherwise), and app/vite.config.ts
#     resolves the `/api` proxy from `process.env.SERVER_PORT` with a 3001 fallback, so the app is
#     started with it exported rather than only in a file - otherwise the app silently proxies into
#     someone else's stack.
set -u
WT="$(cd "$(dirname "$0")/.." && pwd)"
PG_CONTAINER="${PG_CONTAINER:-ob-e2e-pg1}"
PG_URL_PORT="${PG_URL_PORT:-55433}"
APP_DB="${APP_DB:-openbot_app}"
CN="${CN:-ob-e2e-eng-casdoor}"
API_PORT="${API_PORT:-3221}"
CASDOOR_PORT="${CASDOOR_PORT:-8000}"
APP_PORT="${APP_PORT:-3010}"
CASDOOR_CONF_DIR="${CASDOOR_CONF_DIR:-$HOME/.cache/openbot-e2e/engine-conf}"

psql_pg() { docker exec "$PG_CONTAINER" psql -U openbot -d postgres "$@"; }

down() {
  echo "tearing down: container $CN, app processes, databases $APP_DB/casdoor"
  for port in "$API_PORT" "$APP_PORT"; do
    pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
    [ -z "$pid" ] && continue
    cwd=$(lsof -a -p "$pid" -d cwd 2>/dev/null | tail -1 | awk '{print $NF}')
    # Only ever kill a process whose cwd is this worktree: on a shared laptop a port alone does not
    # tell you whose it is.
    case "$cwd" in
      "$WT"*) kill "$pid" && echo "  stopped $pid ($cwd)" ;;
      *) echo "  left $pid alone, it belongs to $cwd" ;;
    esac
  done
  docker rm -f "$CN" >/dev/null 2>&1
  psql_pg -c "DROP DATABASE IF EXISTS casdoor WITH (FORCE);" >/dev/null 2>&1
  psql_pg -c "DROP DATABASE IF EXISTS $APP_DB WITH (FORCE);" >/dev/null 2>&1
  psql_pg -c "DROP ROLE IF EXISTS casdoor;" >/dev/null 2>&1
  rm -f "$WT/.env"
  echo "remaining databases: $(psql_pg -Atc "select string_agg(datname,',') from pg_database where datname in ('casdoor','$APP_DB');")"
}
[ "${TEARDOWN:-0}" = "1" ] && { down; exit 0; }
trap 'echo "run: API_PORT=$API_PORT APP_PORT=$APP_PORT TEARDOWN=1 bash scripts/engine-tier-stack.sh"' EXIT

mkdir -p "$CASDOOR_CONF_DIR"
[ -f "$CASDOOR_CONF_DIR/app.conf" ] ||
  sed -e 's#host=postgres port=5432#host=host.docker.internal port='"$PG_URL_PORT"'#' \
    "$WT/casdoor/app.conf" > "$CASDOOR_CONF_DIR/app.conf"
grep -q initAdminPassword "$CASDOOR_CONF_DIR/app.conf" ||
  printf '\ninitAdminPassword = 123\n' >> "$CASDOOR_CONF_DIR/app.conf"
# Casdoor builds its OAuth endpoints from its own `origin`, and discovery is what the server follows
# (server/src/auth/index.ts casdoor() -> issuer/.well-known/openid-configuration). Publishing the
# container on another host port does NOT change what it advertises, so the browser kept getting sent
# to :8000 - which on this machine belongs to the main repo's own casdoor service. Rewriting origin to
# the host port we actually use keeps this instance self-consistent and off everyone else's stack.
sed -i.bak -E "s|^origin = .*|origin = http://localhost:$CASDOOR_PORT|" "$CASDOOR_CONF_DIR/app.conf"
rm -f "$CASDOOR_CONF_DIR/app.conf.bak"

psql_pg -c "CREATE ROLE casdoor LOGIN PASSWORD 'casdoor';" >/dev/null 2>&1
docker exec -i "$PG_CONTAINER" psql -U openbot -d postgres -v ON_ERROR_STOP=0 < "$WT/casdoor/init-db.sql" >/dev/null 2>&1
psql_pg -c "CREATE DATABASE $APP_DB OWNER openbot;" >/dev/null 2>&1

echo "migrating $APP_DB"
(cd "$WT/server" && DATABASE_URL="postgres://openbot:openbot@127.0.0.1:$PG_URL_PORT/$APP_DB" \
  bun scripts/migrate.ts) || exit 1
# Product-side gap found while running this (2026-10-19): no server/drizzle/*.sql adds `skills.icon`
# although server/src/db/schema/plugins.ts declares it, so a freshly migrated database cannot boot the
# server. Fixture-only workaround; the migration itself belongs to the marketplace wave.
docker exec "$PG_CONTAINER" psql -U openbot -d "$APP_DB" -c \
  'ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "icon" text;' >/dev/null 2>&1

echo "starting casdoor on 127.0.0.1:$CASDOOR_PORT"
docker rm -f "$CN" >/dev/null 2>&1
docker run -d --name "$CN" -p 127.0.0.1:"$CASDOOR_PORT":8000 \
  -v "$CASDOOR_CONF_DIR:/conf" --add-host=host.docker.internal:host-gateway \
  casbin/casdoor:latest >/dev/null || exit 1
for _ in $(seq 1 40); do
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:"$CASDOOR_PORT"/ 2>/dev/null)" = "200" ] && break
  sleep 2
done
sleep 5
docker exec "$PG_CONTAINER" psql -U openbot -d casdoor -c \
  "update application set redirect_uris='[\"http://localhost:$API_PORT/api/auth/casdoor\",\"http://localhost:$API_PORT/api/auth/callback/casdoor\",\"http://localhost:$APP_PORT/\"]', homepage_url='http://localhost:$APP_PORT' where name='app-built-in';" >/dev/null 2>&1
pair=$(docker exec "$PG_CONTAINER" psql -U openbot -d casdoor -Atc \
  "select client_id || ' ' || client_secret from application where name='app-built-in';" | head -1)
CID=${pair%% *}; SEC=${pair##* }
echo "casdoor http=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:"$CASDOOR_PORT"/ 2>/dev/null) client=$CID"

# The run-only .env: this worktree has none (it is gitignored), so copy a real one and rewrite it.
ENV_SOURCE="${ENV_SOURCE:-$HOME/trea/OpenBot/.env}"
# The rewrite must happen on EVERY run, not only after a fresh copy: reusing a previous run's .env
# silently kept the old CASDOOR_OAUTH_ISSUER, which sent the browser into a *different* Casdoor on
# :8000 and produced a sign-in page with no Username field.
if [ ! -f "$WT/.env" ] && [ -f "$ENV_SOURCE" ]; then
  cp "$ENV_SOURCE" "$WT/.env"
elif [ ! -f "$WT/.env" ]; then
  echo "no .env in this worktree and ENV_SOURCE=$ENV_SOURCE does not exist"; exit 1
fi
python3 - "$WT/.env" "$CID" "$SEC" "$API_PORT" "$APP_PORT" "$PG_URL_PORT" "$APP_DB" "$CASDOOR_PORT" <<'PY'
import re, sys
p, cid, secret, api, app, pgport, db, cport = sys.argv[1:9]
s = open(p).read()
subs = {
    r"(?m)^DATABASE_URL=.*": f"DATABASE_URL=postgres://openbot:openbot@127.0.0.1:{pgport}/{db}",
    r"(?m)^CASDOOR_OAUTH_CLIENT_ID=.*": f"CASDOOR_OAUTH_CLIENT_ID={cid}",
    r"(?m)^CASDOOR_OAUTH_CLIENT_SECRET=.*": f"CASDOOR_OAUTH_CLIENT_SECRET={secret}",
    r"(?m)^CASDOOR_OAUTH_ISSUER=.*": f"CASDOOR_OAUTH_ISSUER=http://localhost:{cport}",
    r"(?m)^OPENAI_BASE_URL=.*": "OPENAI_BASE_URL=http://127.0.0.1:9/v1",
    r"(?m)^TRUSTED_ORIGINS=.*": f"TRUSTED_ORIGINS=http://localhost:{app},http://localhost:{api}",
    r"(?m)^PORT=.*": f"PORT={api}",
    r"(?m)^SERVER_PORT=.*": f"SERVER_PORT={api}",
    r"(?m)^APP_PORT=.*": f"APP_PORT={app}",
    r"(?m)^BETTER_AUTH_URL=.*": f"BETTER_AUTH_URL=http://localhost:{api}",
}
for k, v in subs.items():
    s = re.sub(k, v, s)
open(p, "w").write(s)
print("wrote run-only .env (gitignored; removed by TEARDOWN=1)")
PY

echo "starting server on :$API_PORT and app on :$APP_PORT"
(cd "$WT/server" && env PORT="$API_PORT" SERVER_PORT="$API_PORT" APP_PORT="$APP_PORT" \
  BETTER_AUTH_URL="http://localhost:$API_PORT" \
  nohup bun --env-file=../.env src/index.ts >> /tmp/engine-tier-server.log 2>&1 &)
(cd "$WT/app" && env SERVER_PORT="$API_PORT" APP_PORT="$APP_PORT" \
  nohup bun --env-file=../.env --bun node_modules/vite/bin/vite.js --port "$APP_PORT" --strictPort \
  >> /tmp/engine-tier-app.log 2>&1 &)
sh=""; ap=""
for _ in $(seq 1 60); do
  sh=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/health" 2>/dev/null)
  ap=$(curl -s -m 6 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" 2>/dev/null)
  [ "$sh" = "200" ] && [ "$ap" = "200" ] && break
  sleep 5
done
echo "readiness server=$sh app=$ap  logs: /tmp/engine-tier-server.log /tmp/engine-tier-app.log"
[ "$sh" = "200" ] && [ "$ap" = "200" ] || exit 1
echo "now: bunx e2e run --config e2e.config.ts"
