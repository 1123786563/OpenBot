#!/usr/bin/env bash
# O01 — OpenBot API + database baseline: one postgres container, one API process.
# O02 — plus an optional OpenConnector container wired into the API's env.
#
# Subcommands: up | status | smoke-db-off | down
# Ports default to 55432 (postgres) and 18787 (API) because 5432/8787/55433 are
# occupied by other projects on this machine; override with OPENMUSE_V4_PGPORT /
# OPENMUSE_V4_PORT. Every chosen port is verified free before use. All state
# (pid, logs, generated key) lives under /tmp/openmuse-v4-baseline.
set -euo pipefail

CONTAINER=openbot-v4-postgres
PGPORT="${OPENMUSE_V4_PGPORT:-55432}"
APIPORT="${OPENMUSE_V4_PORT:-18787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR=/tmp/openmuse-v4-baseline
PID_FILE="$STATE_DIR/api.pid"
API_ENV_FILE="$STATE_DIR/api.env"
LOG_FILE="$STATE_DIR/api.log"
KEY_FILE="$STATE_DIR/key-encryption-key"
DATABASE_URL="postgres://openbot:openbot@127.0.0.1:${PGPORT}/openbot"

# O02 connector service. OPENMUSE_V4_CONNECTOR=0 leaves the stack exactly the
# O01 API-only baseline (no OPENCONNECTOR_URL in the API env). The image is the
# vendor's official distribution — GHCR ghcr.io/oomol-lab/open-connector (repo
# README "Docker Image (GHCR)" + docs/docker-ghcr.md, fetched 2026-10-13); there
# is no oomol/open-connector on Docker Hub. CONNECTOR_IMAGE overrides it (e.g. a
# self-built `docker build` of the public repo) without editing this script.
CONNECTOR_CONTAINER=openbot-v4-connector
CONNECTORPORT="${OPENMUSE_V4_CONNECTOR_PORT:-55441}"
CONNECTOR_IMAGE="${CONNECTOR_IMAGE:-ghcr.io/oomol-lab/open-connector:latest}"
CONNECTOR_KEY_FILE="$STATE_DIR/connector.key"
CONNECTOR_DATA_DIR="$STATE_DIR/connector-data"
CONNECTOR_ENABLED="${OPENMUSE_V4_CONNECTOR:-1}"
# The origin Google redirects back to after consent: the public origin the
# browser reaches the API on (index.ts strips trailing slashes; the callback
# path it composes is /api/public/openmuse-google/callback).
PUBLIC_ORIGIN="${OPENMUSE_V4_PUBLIC_ORIGIN:-http://127.0.0.1:${APIPORT}}"

say() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

require_free() {
  local port="$1" name="$2" var="$3"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    die "port $port ($name) is already in use. Set $var to a free port."
  fi
}

api_pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true; }
api_alive() {
  local pid
  pid="$(api_pid)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # 防 PID 复用：进程退出后系统复用该数字时，kill -0 仍成功，但命令行已不是本脚本
  # 启动的 bun —— 不校验就会把无关进程当「API 仍在运行」，up 死于无关的 /ready
  # 超时、down 向无辜进程发 SIGTERM。
  ps -p "$pid" -o command= 2>/dev/null | grep -q "bun run dev"
}

wait_for() {
  # wait_for <description> <seconds> <command...> — succeed when <command> exits 0.
  local what="$1" seconds="$2"; shift 2
  local deadline=$(( $(date +%s) + seconds ))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "timed out after ${seconds}s waiting for $what"
    sleep 1
  done
}

ready_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${APIPORT}/ready"; }

baseline_env() {
  # The config.ts required set (plus PORT). Intelligence is never contacted at
  # boot; these placeholder URLs exist only so loadConfig accepts the contract.
  # OPENBOT_SINGLE_USER=true is the documented no-provider mode: one administrator,
  # no sign-in — what a local baseline is.
  #
  # O03 capacity bounds (server/src/computer/capacity.ts), documented not set: a
  # single-user baseline never contends them, so the §10 defaults apply.
  #   OPENMUSE_MAX_ACTIVE_COMPUTERS (default 20) — concurrent running computers,
  #     counted deployment-wide over the provider's list; a 21st start answers 503
  #     with code computer_capacity_exceeded, after idle computers are swept.
  #   OPENMUSE_COMPUTER_IDLE_MINUTES (default 15) — a computer this idle without
  #     run activity or human control is stopped when the cap is contended; its
  #     workspace state persists (the provider's own stop semantics).
  #   OPENMUSE_COMPUTER_DISK_GIB (default 2) — per-Bot workspace write budget; a
  #     write that would pass it answers 413 with code workspace_quota_exceeded.
  # O04 worker capacity (server/src/openmuse-tasks/capacity.ts), documented not
  # set for the same reason:
  #   OPENMUSE_TASK_WORKERS (default 4) — concurrent Task workers per API
  #     process; a fifth runnable Task stays queued and visible until a slot
  #     frees, and the queue's claim stays oldest-due-first (fairness recorded
  #     in capacity.ts, not faked).
  #   Active Tasks per user (100, not env-configurable) — the 101st active
  #     Task's creation answers 409 "Finish or cancel some tasks before adding
  #     more", matching the legacy OpenMuse service limit; terminal Tasks
  #     (succeeded/failed/cancelled) never count.
  # D09 backup retention (server/src/openmuse-deletion/retention.ts), documented
  # not set: the §9 policy seam — the backup system itself is deployment
  # infrastructure, the API provides the enforcement point and visibility only.
  #   OPENMUSE_BACKUP_RETENTION_DAYS (default 30) — days past the restore
  #     window a deployment's backups may still carry deleted personal bytes;
  #     past it the admin cleanup view flags the deletion's marker
  #     retention-elapsed (the manifest itself stays until the operator
  #     archives it — nothing is silently cleared).
  cat <<EOF
DATABASE_URL=$DATABASE_URL
PORT=$APIPORT
KEY_ENCRYPTION_KEY=$(cat "$KEY_FILE")
OPENBOT_SINGLE_USER=true
INTELLIGENCE_API_URL=http://127.0.0.1:7100
INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:7103
INTELLIGENCE_API_KEY=openmuse-v4-baseline
EOF
  if [ "$CONNECTOR_ENABLED" = 1 ]; then
    # O02: the API dials OpenConnector on the loopback forward, and the Google
    # callback origin is named for every seam that composes redirect URIs from
    # it. GOOGLE_OAUTH_* stays OUT on purpose: config.ts reads it as the
    # sign-in provider, which switches off OPENBOT_SINGLE_USER's no-sign-in
    # mode and demands BETTER_AUTH_* — a local baseline is single-user, so the
    # OAuth client is registered against the connector by the O02 evidence
    # PUT, not by the boot-time pushGmailClientConfig path.
    cat <<EOF
OPENCONNECTOR_URL=http://127.0.0.1:${CONNECTORPORT}
OPENBOT_PUBLIC_ORIGIN=$PUBLIC_ORIGIN
EOF
  fi
}

cmd_up() {
  docker info >/dev/null 2>&1 || die "docker daemon unavailable (OrbStack not running?)"
  mkdir -p "$STATE_DIR"
  [ -f "$KEY_FILE" ] || { umask 077; openssl rand -base64 32 > "$KEY_FILE"; }

  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    say "container $CONTAINER exists, starting it"
    docker start "$CONTAINER" >/dev/null
    # 端口映射在 docker run 创建时即固定，docker start 不会更新：与本次 PGPORT 不一致
    # 说明容器属于旧配置，而容器内探测（docker exec psql）照常通过，只会把宿主侧
    # db:migrate 的失败伪装成无关的 ECONNREFUSED（新端口被占时甚至完全静默）。
    # 与 API 复用分支的端口一致性检查对齐：拒绝复用，让 down 重建。
    local mapped
    mapped="$(docker port "$CONTAINER" 5432/tcp 2>/dev/null || true)"
    case "$mapped" in
      *":$PGPORT") : ;;
      *) die "container $CONTAINER maps 5432 to '${mapped:-nothing}', not $PGPORT; run '$0 down' first" ;;
    esac
  else
    require_free "$PGPORT" postgres OPENMUSE_V4_PGPORT
    say "running new container $CONTAINER on 127.0.0.1:$PGPORT"
    # pgvector/pgvector:pg16, not postgres:16-alpine: migration 0000 (collapsed schema)
    # creates the vector extension for the chunks.embedding column — migration 0010 drops
    # it again, but a fresh database still has to walk past 0000, and alpine has no pgvector.
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_DB=openbot -e POSTGRES_USER=openbot -e POSTGRES_PASSWORD=openbot \
      -p 127.0.0.1:"$PGPORT":5432 pgvector/pgvector:pg16 >/dev/null
  fi
  # A real query, not pg_isready: a fresh container's first server accepts connections
  # and then shuts down briefly for init finalization, and pg_isready inside that window
  # reports ready about a server that is about to refuse everything.
  wait_for "postgres to accept connections" 30 \
    docker exec "$CONTAINER" psql -U openbot -d openbot -tAc 'select 1'
  say "postgres is ready"

  # The enterprise RLS migrations (0056+) create policies TO ob_ent_* roles, which roles.sql
  # (the DBA-side precondition) must have created first — see its own header.
  say "creating enterprise capability roles (server/ops/enterprise/roles.sql)"
  if ! docker exec -i "$CONTAINER" psql -U openbot -d openbot -q -v ON_ERROR_STOP=1 \
      -f - < "$ROOT/server/ops/enterprise/roles.sql" >/dev/null 2>&1; then
    # Restart path: the roles already exist from the first up. Anything else is a real failure.
    have=$(docker exec "$CONTAINER" psql -U openbot -d openbot -tAc \
      "select count(*) from pg_roles where rolname in ('ob_ent_directory','ob_ent_data','ob_ent_operator','ob_ent_identity_operator','ob_ent_identity')")
    [ "$have" = 5 ] || die "enterprise roles could not be created (server/ops/enterprise/roles.sql)"
    say "enterprise roles already present"
  fi

  say "applying migrations (bun run db:migrate)"
  (cd "$ROOT/server" && DATABASE_URL="$DATABASE_URL" bun run db:migrate)
  say "applied migrations in database: $(docker exec "$CONTAINER" psql -U openbot -d openbot -tAc \
    'select count(*) from drizzle.__drizzle_migrations')"
  say "migration journal at HEAD of worktree: $(find "$ROOT/server/drizzle" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ') files, latest $(basename "$(find "$ROOT/server/drizzle" -maxdepth 1 -name '*.sql' | sort | tail -1)")"

  if [ "$CONNECTOR_ENABLED" = 1 ]; then
    mkdir -p "$CONNECTOR_DATA_DIR"
    [ -f "$CONNECTOR_KEY_FILE" ] || { umask 077; openssl rand -base64 32 > "$CONNECTOR_KEY_FILE"; }
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONNECTOR_CONTAINER"; then
      say "container $CONNECTOR_CONTAINER exists, starting it"
      docker start "$CONNECTOR_CONTAINER" >/dev/null
      # 同 postgres 分支：映射创建时固定，与本次 CONNECTORPORT 不一致说明旧配置。
      # 容器内服务照常启动，但 wait_for 对新端口的探测会空转满 60s 后以误导性的
      # 「timed out waiting for connector」失败——真实原因是旧容器映射在旧端口上。
      local cmapped
      cmapped="$(docker port "$CONNECTOR_CONTAINER" 3000/tcp 2>/dev/null || true)"
      case "$cmapped" in
        *":$CONNECTORPORT") : ;;
        *) die "container $CONNECTOR_CONTAINER maps 3000 to '${cmapped:-nothing}', not $CONNECTORPORT; run '$0 down' first" ;;
      esac
    else
      require_free "$CONNECTORPORT" connector OPENMUSE_V4_CONNECTOR_PORT
      say "running new container $CONNECTOR_CONTAINER from $CONNECTOR_IMAGE on 127.0.0.1:$CONNECTORPORT"
      # The backend restriction is the 127.0.0.1 publish: the API is a host
      # process dialing the loopback forward, and nothing off-host can reach the
      # port. No OOMOL_CONNECT_ADMIN_TOKEN on purpose — the OpenBot dial
      # (openmuse-connectors/client.ts) sends no bearer, so a token here would
      # 401 the tokenless requests this deployment's seams send.
      docker run -d --name "$CONNECTOR_CONTAINER" \
        -p 127.0.0.1:"$CONNECTORPORT":3000 \
        -v "$CONNECTOR_DATA_DIR":/app/data \
        -e OOMOL_CONNECT_ORIGIN="http://127.0.0.1:${CONNECTORPORT}" \
        -e OOMOL_CONNECT_ENCRYPTION_KEY="$(cat "$CONNECTOR_KEY_FILE")" \
        "$CONNECTOR_IMAGE" >/dev/null
    fi
    # The API's OpenMuse connector seams (connect, mail, calendar) dial this
    # address on first use, so the connector answers before the API starts.
    wait_for "connector to answer /api/providers" 60 \
      curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${CONNECTORPORT}/api/providers"
    say "connector is ready"
  fi

  if api_alive; then
    # api_alive 只证明那个 pid 活着，不证明它按本次配置在运行：两次运行之间改了
    # OPENMUSE_V4_PORT 时旧进程仍占旧端口，复用会让下面的就绪循环对新端口轮询 30s
    # 后死于无关超时；改了 OPENMUSE_V4_CONNECTOR 更糟——旧 env 没有 OPENCONNECTOR_URL，
    # /ready 照样 200，O02 接线被静默跳过。所以复用前确认监听端口等于本次 APIPORT。
    # bun run dev 的 PID 文件记的是父进程，真正持端口的是 bun --watch src/index.ts 子进程，
    # 对父 pid 做 lsof 永远查不到 LISTEN 端口；按「端口 + 命令行」认领真正的监听进程（与
    # cmd_down 收尾一致）。lsof 无匹配时非零退出，|| true 防 set -euo pipefail 在打印任何
    # 诊断前把脚本静默退出——含 run '$0 down' 提示的 die 分支必须真的可达。
    local lpid ours
    ours=""
    for lpid in $(lsof -nP -iTCP:"$APIPORT" -sTCP:LISTEN -t 2>/dev/null || true); do
      ps -p "$lpid" -o command= 2>/dev/null | grep -q "src/index.ts" && ours="$ours $lpid"
    done
    [ -n "$ours" ] || die \
      "no src/index.ts listener on $APIPORT (API pid $(api_pid) holds no port; config changed? run '$0 down' first)"
    # 复用前校验环境一致性：与本次 up 启动 API 时落盘的 baseline_env 快照比对。
    # 两次 up 之间翻转 OPENMUSE_V4_CONNECTOR（或改 OPENBOT_PUBLIC_ORIGIN 等注入 API
    # 的变量）后，旧进程带着旧拓扑继续跑，/ready 照样 200，O02 接线被静默跳过或
    # 残留——快照缺失（更早版本的脚本启动的进程）同样拒绝，与端口检查对齐。
    if ! diff -q "$API_ENV_FILE" <(baseline_env) >/dev/null 2>&1; then
      die "API on $APIPORT runs with a different baseline env than this run's (OPENMUSE_V4_CONNECTOR/ports/origin changed?); run '$0 down' first"
    fi
    say "API already running on $APIPORT (pids:$ours), not starting another"
  else
    require_free "$APIPORT" API OPENMUSE_V4_PORT
    say "starting API on port $APIPORT (log: $LOG_FILE)"
    # baseline_env 的值是用户可控的（OPENMUSE_V4_PUBLIC_ORIGIN 等一旦含空格/glob，
    # 无引号词分割会把值拆成多个词、把多余片段当作命令）。逐行读入数组后整体传参，
    # 值含任何空白都不再被拆坏。
    local -a env_args=()
    while IFS= read -r kv; do env_args+=("$kv"); done < <(baseline_env)
    # The exec makes the recorded pid the bun process itself, not the bash wrapper,
    # so `down` kills the API directly.
    (cd "$ROOT/server" && exec nohup env "${env_args[@]}" bun run dev \
      > "$LOG_FILE" 2>&1) & echo $! > "$PID_FILE"
    # 本次启动所用 env 的快照，供下次 up 的复用分支比对（含 KEY_ENCRYPTION_KEY，
    # umask 077；down 一并清掉）。
    ( umask 077; baseline_env > "$API_ENV_FILE" )
  fi
  local deadline=$(( $(date +%s) + 30 )) code
  while :; do
    code="$(ready_code || true)"
    [ "$code" = 200 ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "/ready did not answer 200 within 30s (last: $code)"
    sleep 1
  done
  say "/ready is 200: $(curl -s "http://127.0.0.1:${APIPORT}/ready")"
}

cmd_status() {
  # inspect prints a bare newline to stdout for an absent container before
  # failing; tr drops it and || true keeps pipefail+errexit from killing the
  # script over an absent container being, well, absent.
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | tr -d '\n' || true)"
  say "container: ${state:-absent}"
  state="$(docker inspect -f '{{.State.Status}}' "$CONNECTOR_CONTAINER" 2>/dev/null | tr -d '\n' || true)"
  say "connector container: ${state:-absent}"
  if api_alive; then say "api: pid $(api_pid) alive"; else say "api: not running"; fi
  say "/health: $(curl -s --max-time 3 "http://127.0.0.1:${APIPORT}/health" || echo unreachable)"
  say "/ready:  $(curl -s -w ' [http %{http_code}]' --max-time 3 "http://127.0.0.1:${APIPORT}/ready" || echo unreachable)"
  say "connector /api/providers: $(curl -s -o /dev/null -w '[http %{http_code}]' --max-time 3 "http://127.0.0.1:${CONNECTORPORT}/api/providers" || echo unreachable)"
}

cmd_smoke_db_off() {
  api_alive || die "API is not running; nothing to smoke-test"
  say "stopping container $CONTAINER"
  docker stop "$CONTAINER" >/dev/null
  local deadline=$(( $(date +%s) + 10 )) code
  while :; do
    code="$(ready_code || true)"
    if [ "$code" = 503 ]; then say "/ready answered 503 within 10s"; break; fi
    [ "$(date +%s)" -lt "$deadline" ] || die "/ready did not answer 503 within 10s (last: $code)"
    sleep 1
  done
  say "/ready body: $(curl -s "http://127.0.0.1:${APIPORT}/ready")"
  say "/health while db down: $(curl -s -w ' [http %{http_code}]' "http://127.0.0.1:${APIPORT}/health")"
}

cmd_down() {
  if api_alive; then
    say "stopping API (pid $(api_pid))"
    kill "$(api_pid)" 2>/dev/null || true
  else
    say "API not running"
  fi
  rm -f "$PID_FILE"
  rm -f "$API_ENV_FILE"
  # bun run dev 的 PID 文件记的是父进程，真正持端口的是 bun --watch src/index.ts 子进程，
  # 二者脱节是常态；收尾只能按命令行认领（src/index.ts），端口被无关服务抢占时告警留人处理，
  # 不能仅凭端口归属就向陌生进程发 SIGTERM。
  local stray pid ours
  stray="$(lsof -nP -iTCP:"$APIPORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  ours=""
  for pid in $stray; do
    ps -p "$pid" -o command= 2>/dev/null | grep -q "src/index.ts" && ours="$ours $pid"
  done
  if [ -n "$ours" ]; then
    say "killing stray API listener on $APIPORT:$ours"
    # shellcheck disable=SC2086  # multiple pids, one per space; splitting is the point
    kill $ours 2>/dev/null || true
  elif [ -n "$stray" ]; then
    say "non-API process listens on $APIPORT, NOT killing: $stray"
  fi
  if docker rm -f "$CONTAINER" >/dev/null 2>&1; then
    say "removed container $CONTAINER"
  else
    say "no container to remove"
  fi
  if docker rm -f "$CONNECTOR_CONTAINER" >/dev/null 2>&1; then
    say "removed container $CONNECTOR_CONTAINER"
  else
    say "no connector container to remove"
  fi
  say "down complete"
}

case "${1:-}" in
  up) cmd_up ;;
  status) cmd_status ;;
  smoke-db-off) cmd_smoke_db_off ;;
  down) cmd_down ;;
  *) echo "usage: $0 {up|status|smoke-db-off|down}" >&2; exit 2 ;;
esac
