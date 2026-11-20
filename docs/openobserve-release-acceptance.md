# OpenObserve release acceptance and rollback

The isolated drill for #85 ran on November 20, 2026 UTC. OpenBot revision `e959b15f25310d0a1127e7a01470ca3c0bd1fd4e` ran against real PostgreSQL 17 with pgvector, Collector Contrib 0.139.0, and OpenObserve Community build `d16d693ba99bc20621a58b948ecbcad7ec7fa882`. The deployment ID was `acceptance85`.

## Local results

| Check | Observed result |
| --- | --- |
| Audit ingestion | A successful API write to the `skillSharing` setting produced PostgreSQL audit UUID `d1de055a-7fb7-46bc-93d9-8e8504aaf7f3`. The deployment-filtered `openbot_audit` query returned that UUID with `schema_version=1`, `canonical_source=postgresql.audit_events`, and `event_type=enterprise.setting_changed`. |
| Runtime ingestion | The API's real stdout `api_listening` at `12:35:54.534Z` reached `openbot_runtime` through the sample Collector. The result had `schema_version=1`, `canonical_source=openbot.stdout`, component `api`, and port `34585`. A different deployment ID returned zero results. |
| Run lineage | Audit UUID `ca841d44-3162-4028-9ff8-4ed6cd3ab6b4` returned `run_id=resumed-run`, `thread_id=conversation-thread`, `parent_run_id=interrupted-run`, and `attempt_id=resumed-run`. The approval fixture read the same run ID from the saved OpenBot approval `b45db7fb-f997-4e7c-ae84-a77806e3ef00` before cleanup. |
| Retention | OpenObserve returned 90 days for audit and 30 days for runtime, with original-data storage and indexing off. OpenBot's seven-day sweep removed one eight-day-old PostgreSQL fixture row. The existing audit copy remained readable and OpenObserve's settings remained 90 and 30 days. |
| OpenObserve outage and recovery | From `12:39:06Z` to `12:39:47Z`, the live API returned 200 for health, the setting write, and the audit read. Audit UUID `fb5c23b2-e4c1-45f8-a5db-6bde97e329a5` persisted in PostgreSQL. The Bot fixture completed two calls to its loopback model fixture, received the tool result, finished the run, and read the approval in Activity. Collector audit retries exhausted. A query after recovery returned fresh UUID `db7187ef-5fb3-4a98-98b4-4facd4947df3` and zero hits for the outage UUID. |
| Export disabled | With the live endpoint present and `OPENBOT_OTEL_EXPORT=off`, API writes and audit reads passed. UUID `93af8a3f-9fb0-4af3-9041-eab04752395c` had zero OpenObserve hits. Startup stdout still reached the independently configured runtime reader. The paused Bot fixture also passed. |
| Previous-revision rollback | OpenBot `414f577730fd0774d50a75ed60e291ca30159725` started against the same database with the endpoint removed and the Collector stopped. Health and the setting write succeeded. Audit UUID `5542735d-d7f7-4d99-9d8f-9a83e37a1bcc` existed in PostgreSQL and had zero OpenObserve hits. No migrator ran. The ordered migration ledger hash and count remained `836501840a71d12ca91daf62b559bf01\|89`. |
| Query access | The isolated nginx Basic-auth query gateway returned 200 for both `/web/` and a deployment-filtered search for the configured admin. Both routes returned 401 for anonymous requests and for the synthetic workspace-member and ingest usernames. OpenObserve used a loopback bootstrap endpoint for fixture setup. |

## Final review rerun

The local release drill ran again on November 20, 2026 UTC against PostgreSQL 17, Collector Contrib 0.139.0, and the same OpenObserve build. The results below cover the revised deployment pause procedure.

| Check | Observed result |
| --- | --- |
| Dual delivery | Audit event `f9ef7bfd-1732-40f9-adca-c453845d6d6a` and the API's `api_listening` event reached their respective streams with deployment `acceptance85` and schema version 1. The runtime event included `service=openbot`. |
| Saved approval lineage | OpenObserve returned both saved approval decisions, including audit UUID `0b5b36b3-3873-40c5-877c-159b9940dc2c` with product telemetry off. Both copies carried the stored run ID, thread ID, parent Run ID, root task ID, attempt ID, and work item key. |
| Coordinated pause | With `OPENBOT_OTEL_EXPORT=off` on OpenBot and the Collector, the API still served health and committed audit UUID `92e9a293-9172-4d0e-a4e0-4adaf518c29d`. Local stdout contained `audit_export_paused` and `api_listening`. OpenObserve returned zero hits for the audit UUID and for the startup record at `2026-11-20T13:04:07.549Z`. |
| No endpoint | With the API OTLP endpoint unset and the Collector stopped, audit UUID `568fd333-6beb-4be9-863d-43b57b4fa15a` persisted in PostgreSQL, startup was visible locally, and the UUID had zero OpenObserve hits. |
| Outage and recovery | PostgreSQL retained the audit row written during the OpenObserve outage. The enabled and paused Bot fixtures completed their model and tool calls and read Activity. The Collector exhausted its retry window. A fresh UUID reached OpenObserve after recovery, and the outage UUID stayed absent. |
| Independent retention | OpenObserve kept the 30-day runtime and 90-day audit settings and both original-data settings off. The seven-day PostgreSQL sweep deleted the old fixture row, and a fresh OpenObserve audit copy remained queryable. |
| Rollback and query access | The API at `414f5777` served health and wrote audit with the Collector stopped. The PostgreSQL migration ledger kept its previous hash and 89 rows. The nginx fixture allowed the platform admin to open the UI and query the audit stream. It returned 401 for the anonymous, workspace-member, and ingest requests. |

## Repeat the drill

Run these steps from a clean checkout. Keep host endpoints on loopback and use disposable data. The commands assume Bash, Docker, Bun, Python 3, curl, jq, and OpenSSL.

```bash
source_root=$PWD
fixture=$(mktemp -d /tmp/openbot85.XXXXXX)
printf '%s stdout F synthetic receiver readiness probe\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$fixture/api.cri"
docker network create openbot85
docker run -d --name openbot85-pg --network openbot85 -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=local-fixture-pg -e POSTGRES_DB=openbot85 \
  pgvector/pgvector@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd
docker run -d --name openbot85-oo --platform linux/amd64 --network openbot85 -p 127.0.0.1::5080 \
  -e ZO_ROOT_USER_EMAIL=admin@example.test -e 'ZO_ROOT_USER_PASSWORD=LocalFixture85!' \
  -e ZO_TELEMETRY=false \
  openobserve/openobserve@sha256:26618f379c86b253c0d91624c487dd14b71293699845ecbc8457c94dca14819f
oo_auth='admin@example.test:LocalFixture85!'
oo_header=$(printf %s "$oo_auth" | base64)
docker run -d --name openbot85-col --network openbot85 -p 127.0.0.1::4318 \
  -v "$fixture:/fixture:ro" -v "$source_root/docs/examples/openobserve-collector.yaml:/config.yaml:ro" \
  -e OPENBOT_DEPLOYMENT_ID=acceptance85 -e OPENBOT_RUNTIME_LOG_GLOB=/fixture/api.cri \
  -e OPENBOT_RUNTIME_COMPONENT=api -e OPENBOT_OTEL_EXPORT=on \
  -e OPENOBSERVE_OTLP_LOGS_URL=http://openbot85-oo:5080/api/default/v1/logs \
  -e "OPENOBSERVE_RUNTIME_AUTHORIZATION=Basic $oo_header" \
  -e "OPENOBSERVE_AUDIT_AUTHORIZATION=Basic $oo_header" \
  otel/opentelemetry-collector-contrib:0.139.0 --config /config.yaml

port_of() { docker port "$1" "$2/tcp" | cut -d: -f2; }
pg_url="postgres://postgres:local-fixture-pg@127.0.0.1:$(port_of openbot85-pg 5432)/openbot85"
collector="http://127.0.0.1:$(port_of openbot85-col 4318)"
for attempt in {1..60}; do
  if docker exec openbot85-pg pg_isready -h 127.0.0.1 -U postgres -d openbot85; then break; fi
  sleep 1
done
docker exec openbot85-pg pg_isready -h 127.0.0.1 -U postgres -d openbot85 || exit 1
bun install --frozen-lockfile
(cd server && DATABASE_URL="$pg_url" bun --no-env-file scripts/migrate.ts)
openssl rand -base64 32 > "$fixture/key"

cat > "$fixture/loopback.ts" <<'TS'
const serve = Bun.serve;
Bun.serve = ((options) =>
  serve({ ...options, hostname: "127.0.0.1" })) as typeof Bun.serve;
TS
cat > "$fixture/cri.py" <<'PY'
from datetime import datetime, timezone
import sys

for line in sys.stdin:
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(timestamp, sys.argv[1], "F", line.rstrip("\n"), flush=True)
PY

start_api() {
  (
    cd "$1/server"
    shift
    exec env -i PATH="$PATH" HOME="$fixture" DATABASE_URL="$pg_url" \
      DEPLOYMENT_ID=acceptance85 PORT=34585 OPENBOT_SINGLE_USER=true AUDIT_RETENTION_DAYS=7 \
      KEY_ENCRYPTION_KEY="$(cat "$fixture/key")" OPENBOT_PRODUCT_TELEMETRY=0 \
      INTELLIGENCE_API_URL=http://127.0.0.1:1 INTELLIGENCE_GATEWAY_WS_URL=ws://127.0.0.1:1 \
      INTELLIGENCE_API_KEY=local-fixture OPENAI_BASE_URL=http://127.0.0.1:1/v1 \
      COPILOTKIT_TELEMETRY_DISABLED=true "$@" \
      bun --no-env-file --preload "$fixture/loopback.ts" src/index.ts
  ) > >(python3 "$fixture/cri.py" stdout >> "$fixture/api.cri") \
    2> >(python3 "$fixture/cri.py" stderr >> "$fixture/api.cri") &
  api_pid=$!
}
api=http://127.0.0.1:34585
write_audit() {
  curl -fsS -X PUT -H 'content-type: application/json' -d "{\"value\":$1}" \
    "$api/api/admin/enterprise/settings/skillSharing" >&2
  curl -fsS "$api/api/admin/audit-events" |
    jq -er '[.events[] | select(.targetId == "skillSharing")][0].id'
}
query() {
  now=$(python3 -c 'import time; print(time.time_ns()//1000)')
  jq -nc --arg sql "$1" --argjson now "$now" \
    '{query:{sql:$sql,start_time:($now-3600000000),end_time:$now,from:0,size:100}}' |
    curl -fsS -u "$oo_auth" -H 'content-type: application/json' -d @- \
      "http://127.0.0.1:$(port_of openbot85-oo 5080)/api/default/_search?type=logs"
}
pg() { docker exec openbot85-pg psql -U postgres -d openbot85 -Atc "$1"; }
audit_copy() {
  query "SELECT * FROM openbot_audit WHERE deployment_id='acceptance85' AND audit_event_id='$1'"
}

# The file receiver starts at EOF. Confirm that it can export a newly appended
# synthetic record before starting the API, which emits api_listening once.
receiver_ready=false
for attempt in {1..60}; do
  printf '%s stdout F synthetic receiver readiness probe\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$fixture/api.cri"
  if query "SELECT * FROM openbot_runtime WHERE deployment_id='acceptance85' AND event_category='legacy_unstructured'" 2>/dev/null |
      jq -e '.hits | length > 0' >/dev/null; then
    receiver_ready=true
    break
  fi
  sleep 1
done
if [ "$receiver_ready" != true ]; then
  docker logs openbot85-col
  exit 1
fi

start_api "$source_root" OTEL_EXPORTER_OTLP_ENDPOINT="$collector"
curl -fsS --retry 10 --retry-connrefused "$api/health"
audit_id=$(write_audit false)
pg "select id,event_type,target_id from audit_events where id='$audit_id'"
sleep 3
audit_copy "$audit_id" | jq -e '.hits[] | select(.schema_version==1 and .canonical_source=="postgresql.audit_events")'
query "SELECT * FROM openbot_runtime WHERE deployment_id='acceptance85' AND event_category='api_listening'" |
  jq -e '.hits[] | select(.schema_version==1 and .canonical_source=="openbot.stdout")'
```

1. Set both stream policies using the stream settings API and read back the saved values. Use the fixture bootstrap credential for those calls. For PostgreSQL, seed and sweep a separate old row, then recheck the fresh copy. [Platform handoff](openobserve-platform-handoff.md)

   ```bash
   oo="http://127.0.0.1:$(port_of openbot85-oo 5080)"
   for spec in openbot_runtime:30 openbot_audit:90; do
     curl -fsS -u "$oo_auth" -X PUT -H 'content-type: application/json' \
       -d "{\"data_retention\":${spec#*:},\"store_original_data\":false,\"index_original_data\":false}" \
       "$oo/api/default/streams/${spec%:*}/settings?type=logs"
   done
   curl -fsS -u "$oo_auth" "$oo/api/default/streams" | jq '.list[] | {name,settings}'
   pg "insert into audit_events(event_type,target_type,target_id,payload,created_at)
       values ('release.fixture_old','fixture','release85-retention','{}',now() - interval '8 days')"
   TEST_DATABASE_URL="$pg_url" bun --no-env-file -e \
     'import {sweepAuditTrail} from "./server/src/audit-retention"; console.log(await sweepAuditTrail(process.env.TEST_DATABASE_URL,7))'
   pg "select count(*) from audit_events where target_id='release85-retention'"
   audit_copy "$audit_id" | jq -e '.hits | length > 0'
   ```

2. For lineage and Bot continuity, copy the #83 fixture temporarily beside the original. Change its deployment ID from `audit-integration` to `acceptance85`. In the request handlers for the approval lineage and Bot tests, keep the captured request and forward the same JSON bytes to `$collector/v1/logs` with `Content-Type: application/json`. Check the forwarded response is 2xx. In both the complete-lineage and analytics-disabled cases, read `approvalRequests.runId` by `decidedId` before cleanup and compare it to the fixture run ID. Print the audit UUID from `events[0].id`. Run the temporary test with `TEST_DATABASE_URL="$pg_url"` and `--test-name-pattern 'saved approval continuation with (complete|analytics disabled)|produces Activity and audit with export (enabled|paused)$'`. Use `audit_copy` with the printed UUID and compare its stored lineage to the fixture. The fixture uses LLMock and a loopback tool. [Business integration fixture](../server/tests/audit-otlp.integration.test.ts)
3. Stop `openbot85-oo` while Collector and OpenBot stay up. Call health and `write_audit true`. Query the resulting UUID in PostgreSQL and rerun the enabled and paused Bot cases from step 2. Let the Collector's 30-second retry window expire and inspect `docker logs openbot85-col` for dropped audit batches. Start OpenObserve, refresh its published port, and wait for `/config` to return 200. Write a fresh audit event and poll `audit_copy` for it. Verify the outage UUID remains absent.
4. Recreate the Collector from the setup command with `OPENBOT_OTEL_EXPORT=off`. Refresh `collector` from its published port and wait for `Started watching file` in the Collector logs. Restart OpenBot with that endpoint and `OPENBOT_OTEL_EXPORT=off`. Write another audit event. Verify its PostgreSQL row and confirm zero OpenObserve hits after the export interval. Find the new `api_listening` record and `audit_export_paused` in `$fixture/api.cri`. Query `openbot_runtime` by the startup record's exact `occurred_at` and deployment ID. Expect zero hits.

   To check endpoint removal, stop the Collector and start OpenBot without either OTLP endpoint. Write an audit event, verify its PostgreSQL row, and confirm zero OpenObserve hits. Verify startup output in `$fixture/api.cri`. The isolated Collector fixture also checks that both pipelines emit zero records without an OpenObserve destination.
5. For rollback, save the migration ledger before stopping the API. Extract `git archive 414f5777` to a disposable directory and install that revision's dependencies with `bun install --frozen-lockfile`. Stop the Collector and start the extracted API using `start_api` with no exporter variables. Skip the migration command. Run health, `write_audit`, and the PostgreSQL audit query against the same database. Compare the before and after ledger using the following query.

   ```sql
   SELECT md5(string_agg(hash, ',' ORDER BY id)), count(*)
   FROM drizzle.__drizzle_migrations;
   ```

6. To repeat the local query boundary check, run nginx 1.28 on `openbot85` with a loopback-published port. Apply `auth_basic` to the whole server, use an `openssl passwd -apr1` entry for `platform-admin` as the sole user, override upstream `Authorization` with `Basic $oo_header`, and proxy to `http://openbot85-oo:5080`. Check `GET /web/` and `POST /api/default/_search?type=logs` with the admin, the two other usernames, and no credentials. Restart nginx if OpenObserve's internal IP changes.
7. Stop the fixture API, remove the temporary test, and remove the fixture containers and network.

## Original repository checks

- `bun run lint`, `bun run format:check`, and `bun run typecheck` passed. `bun run typecheck:tests` passed against its checked-in baseline of 223 known diagnostics.
- `TEST_DATABASE_URL="$pg_url" bun test --timeout 30000 server/tests/{audit-otlp.integration,audit-retention.integration,audit-approval-outcomes.integration,activity-plumbing-rows.integration,audit-export,otel-export-scrubbing,runtime-log,openobserve-link}.test.ts` passed 74 tests.
- `helm dependency build charts/openbot` and `bun test tests/chart-openobserve.test.ts` passed all six Helm cases using Helm 3.19.0.
- `OTELCOL_CONTRIB=/path/to/otelcol-contrib python3 docs/examples/check-openobserve-collector.py` passed with Collector Contrib 0.139.0. It observed six runtime and two audit records and excluded the private sentinel.

## Final review repository checks

- The targeted Bun suite passed 306 tests across 24 files. It covered audit, Activity, approval, Recorder, app access, admin controls, runtime logs, and product telemetry. The tests used an isolated PostgreSQL 17 database.
- Helm 3.19.0 rendered all six OpenObserve chart cases. The workspace typecheck, test typecheck against the 223-diagnostic baseline, lint, and format checks passed.
- The real Collector Contrib 0.139.0 fixture received seven runtime records and six audit records. Both output files stayed empty with a missing deployment ID, an invalid deployment ID, a pause, or a missing endpoint.
- The PostgreSQL retirement regression forced the second audit write to fail. The rollback left both links active, left no audit rows, and sent no OTLP request. The successful retry exported both committed audit IDs.
- The OTLP fixtures exercised both the generic endpoint and the logs-specific endpoint. Final HTTP failures appeared in the local runtime diagnostics without upstream response text.

## Staging checks

Use the actual workload log selectors and container log driver. The local API stdout was wrapped in CRI framing on the host. The nginx fixture exercised query route authorization with a single Basic-auth allowlist. Staging must confirm the platform IdP group, workload network isolation, authenticated ingestion with separate stream scopes, and direct-upstream denial from user and ingest networks. Use the Collector receiver outage and recovery procedure with the deployed workload. Confirm live Opik lookup where configured, plus backup, restore, and retention on the platform storage topology. [Platform handoff](openobserve-platform-handoff.md)
