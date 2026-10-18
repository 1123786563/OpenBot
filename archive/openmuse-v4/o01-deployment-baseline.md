# O01 — OpenBot API + database baseline: deployment evidence

Ticket: GitHub issue #88 (catalog O01). Plan: `docs/superpowers/plans/tickets/O01-api-db-baseline.md` (openmuse worktree).
Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base` (branch `v4/openbot-exec`, uncommitted I02/B02 checkpoints present and untouched). No commits made.

All timestamps UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`); local machine time is UTC+8.

## 1. Ports

| Port | Role | Status at cycle start (15:12:12Z) |
|---|---|---|
| 5432 | other project (user's `openbot` compose stack, OrbStack forward) | occupied — untouched |
| 8787 | other project (node listener, pid 78299 OpenMuse dev server) | occupied — untouched |
| 55433 | other project (OrbStack forward) | occupied — untouched |
| 55432 | **plan default for postgres — found OCCUPIED by an OrbStack-forwarded container** | used `OPENMUSE_V4_PGPORT=55434` instead |
| 55434 | postgres for this baseline (chosen: verified free) | used |
| 18787 | API for this baseline (plan default; verified free) | used |

Port inventory before the cycle (`lsof -nP -iTCP:5432 -iTCP:8787 -iTCP:55433 -sTCP:LISTEN`):

```
OrbStack  11215 ... TCP 127.0.0.1:55433 (LISTEN)
OrbStack  11215 ... TCP 127.0.0.1:5432 (LISTEN)
OrbStack  11215 ... TCP [::1]:5432 (LISTEN)
node      78299 ... TCP 127.0.0.1:8787 (LISTEN)
```

The script's `require_free` check fired as designed when `up` was first attempted on the occupied default (`ERROR: port 55432 (postgres) is already in use. Set OPENMUSE_V4_PGPORT to a free port.`). All evidence below uses `OPENMUSE_V4_PGPORT=55434`, `OPENMUSE_V4_PORT=18787` (default).

## 2. Deviations from the plan (both forced by the migration chain, both recorded per plan §Failure handling)

1. **Image: `pgvector/pgvector:pg16`, not `postgres:16-alpine`.** Migration `0000_schema.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` (the collapsed schema still creates `chunks.embedding vector(1536)`; migration `0010` drops the column again, but a fresh database has to walk past 0000). Alpine postgres has no pgvector: first `up` attempt failed with `psql: ERROR: extension "vector" is not available`. The official `pgvector/pgvector:pg16` image is stock postgres 16 with the extension preinstalled — the smallest change that lets the chain run. Not a schema defect.
2. **Roles precondition: `server/ops/enterprise/roles.sql` is applied before migrations.** Migrations `0056`/`0058`/`0060` create RLS policies `TO ob_ent_directory`/`ob_ent_data`/`ob_ent_operator`/… and fail on a fresh database with `psql: ERROR: role "ob_ent_directory" does not exist` (observed in `docker logs`; drizzle-kit itself exits 1 with no message — its catch prints nothing useful). `roles.sql`'s own header states it is "Executed by the DBA on a dedicated instance BEFORE the migrations run", so the baseline script applies it (idempotently: on restart it verifies all five roles exist). Not a schema defect.

The script records both reasons in comments at the exact lines involved.

## 3. Environment variables the API needs to boot

`server/package.json` `dev` = `bun --env-file=../.env --watch src/index.ts`; no `.env` exists in the worktree, and Bun 1.4.2 tolerates the missing file (verified). `loadConfig` (server/src/config.ts) requires, beyond `PORT`:

| Variable | Value used | Source |
|---|---|---|
| `DATABASE_URL` | `postgres://openbot:openbot@127.0.0.1:55434/openbot` | script, from the port/db of the container it started |
| `PORT` | `18787` | script (`OPENMUSE_V4_PORT` default) |
| `KEY_ENCRYPTION_KEY` | random `openssl rand -base64 32`, generated once into `/tmp/openmuse-v4-baseline/key-encryption-key` (mode 600) | script |
| `OPENBOT_SINGLE_USER=true` | the documented no-provider mode (one administrator, no sign-in); without it boot refuses: "No identity provider is configured … Refusing to start" | script |
| `INTELLIGENCE_API_URL` | `http://127.0.0.1:7100` | script placeholder — required by the Intelligence contract, never contacted at boot |
| `INTELLIGENCE_GATEWAY_WS_URL` | `ws://127.0.0.1:7103` | script placeholder, same |
| `INTELLIGENCE_API_KEY` | `openmuse-v4-baseline` | script placeholder, same |

No other variables were needed; `COPILOTKIT_LICENSE_TOKEN` is optional (config.ts: "no longer one of them").

## 4. Migrations applied

`select count(*) from drizzle.__drizzle_migrations` = **77** after `up` (fresh container), equal to the 77 `.sql` files at HEAD of the worktree, latest `0076_amused_chat.sql` — the I02 migration present in the uncommitted checkpoint IS applied (0076 = `ALTER TABLE agent_profiles ADD COLUMN template_key` + unique index `agent_profiles_owner_template_uq`; verified applied).

Full journal tag list (`server/drizzle/meta/_journal.json`), all applied:

```
0000_schema 0001_swift_morph 0002_sign_in 0003_backfill_account_issuer 0004_identity_provider_outlives_its_registrar
0005_computer_snapshot 0006_audit_read_indexes 0007_audit_retention_window 0008_whole_retro_girl 0009_lumpy_sunfire
0010_drop_the_document_index 0011_drop_the_old_connector_tables 0012_truncate_is_not_a_way_around_append_only
0013_skill_tools 0014_snapshot_session 0015_credentials_one_live_key 0016_pin_and_soft_delete_channels
0017_durable_work 0018_page_frames 0019_channel_read_marker 0020_attention_resolutions 0021_routines
0022_drop_attention_resolutions 0023_routines_owner_index 0024_onboarding 0025_backfill_existing_users_have_onboarded
0026_channel_summary 0027_user_instructions 0028_audit_initiator 0029_mastra_agent_type 0030_daffy_nighthawk
0031_hesitant_squadron_sinister 0032_rainy_lake 0033_attachments_uploaded_by_index 0034_last_signed_in_at
0035_backfill_last_signed_in_at 0036_routine_sweeps 0037_composio 0038_composio_schemes 0039_composio_probe_action
0040_drop_orphaned_skill_grants 0041_drop_orphaned_mcp_grants 0042_user_preferences 0043_plugin_logos
0044_voice_sessions 0045_channel_activity_source 0046_automatic_learning 0047_agent_pinning 0048_coworker_parity
0049_coworker_parity_lanes 0050_review_fixes 0051_routine_enabled_at 0052_shared_brokered_accounts
0053_clean_stardust 0054_brokered_connections_open_connector 0055_steady_machine_man 0056_enterprise_tenancy_rls
0057_enterprise_identity_grants 0058_enterprise_conversations 0059_outgoing_lilandra 0060_enterprise_runs_rls
0061_narrow_vulture 0062_amused_fenris 0063_enterprise_channel_messages 0064_enterprise_runs_writer_catalog
0065_unknown_pride 0066_misty_toad_men 0067_workshop_rls 0068_workshop_rls_grant 0069_cool_gravity 0070_hot_eternals
0071_billing_idempotency 0072_abandoned_lady_vermin 0073_credit_ledger_idempotency 0074_anomaly_dedupe
0075_noisy_adam_destine 0076_amused_chat
```

## 5. `/ready` route — TDD evidence (RED → GREEN)

Test file `server/tests/ready.test.ts` (bun:test; injects the probe as `createApp`'s appended-last positional parameter, the same offset technique as `tests/self-host-banner.test.ts`).

**RED** (route not yet implemented), `cd server && bun test tests/ready.test.ts`:

```
error: expect(received).toBe(expected)
Expected: 200
Received: 404
    at <anonymous> (…/server/tests/ready.test.ts:25:26)
(fail) /ready > answers 200 with database up when the ping resolves [6.32ms]
error: expect(received).toBe(expected)
Expected: 503
Received: 404
    at <anonymous> (…/server/tests/ready.test.ts:34:26)
(fail) /ready > answers 503 with database down when the ping rejects [1.40ms]

 1 pass
 2 fail
 6 expect() calls
Ran 3 tests across 1 file. [1.83s]
```

**GREEN** (route added in `server/src/app.ts` — `app.get("/ready", …)` calling the injected probe, default a real `SELECT 1` on the deployment database with a 1500 ms race; `/health` untouched):

```
 3 pass
 0 fail
 8 expect() calls
Ran 3 tests across 1 file. [2.10s]
```

Regression and hygiene at the end of the cycle: `bun test tests/mobile-bff.test.ts` → 7 pass / 18 expect; `bun run typecheck` (tsc --noEmit) → clean; `bunx biome check server/src/app.ts server/tests/ready.test.ts` → clean (two safe organize-imports fixes applied, one of which sorted the I02-added import into position — content unchanged). `git diff --stat server/src/app.ts`: 78 insertions, 0 deletions.

## 6. Full cycle — exact outputs (`scripts/openmuse-v4-baseline.sh`)

### 6.1 `up` (fresh; 15:23:32Z–15:25:11Z, final script run at 15:25)

```
[2026-10-12T15:25:05Z] running new container openbot-v4-postgres on 127.0.0.1:55434
[2026-10-12T15:25:09Z] postgres is ready
[2026-10-12T15:25:09Z] creating enterprise capability roles (server/ops/enterprise/roles.sql)
[2026-10-12T15:25:09Z] applying migrations (bun run db:migrate)
[⣷] applying migrations… [✓] migrations applied successfully!
[2026-10-12T15:25:10Z] applied migrations in database: 77
[2026-10-12T15:25:10Z] migration journal at HEAD of worktree: 77 files, latest 0076_amused_chat.sql
[2026-10-12T15:25:10Z] starting API on port 18787 (log: /tmp/openmuse-v4-baseline/api.log)
[2026-10-12T15:25:11Z] /ready is 200: {"status":"ok","database":"up"}
```

API log head (`/tmp/openmuse-v4-baseline/api.log`):

```
$ bun --env-file=../.env --watch src/index.ts
{"level":30,…,"type":"computer-isolation","provider":"none","isolation":"off",…}
{"level":40,…,"msg":"No identity provider is configured, so every request is treated as the development actor (administrator). …"}
{"level":30,…,"port":18787,"msg":"OpenBot server listening on http://127.0.0.1"}
```

(Only benign NOTICEs during migrate: identifier truncation >63 chars, e.g. `connector_cursors_…_fk`; trigger `does not exist, skipping`.)

### 6.2 `status` (15:25:16Z)

```
[2026-10-12T15:25:16Z] container: running
[2026-10-12T15:25:16Z] api: pid 63995 alive
[2026-10-12T15:25:16Z] /health: {"status":"ok"}
[2026-10-12T15:25:16Z] /ready:  {"status":"ok","database":"up"} [http 200]
```

### 6.3 Process inventory — no old OpenMuse server/TaskWorker started by the baseline

Command: `ps aux | grep -Ei "openmuse|taskworker" | grep -v grep`. Every match pre-existed the baseline by ~13 hours (STARTED 5:52PM local = 09:52Z; the baseline cycle began 15:12Z) and belongs to the user's long-running OpenMuse dev checkout at `/Users/wuyongjun/trea/openmuse` (not this worktree, not started by the script):

```
78299 5:52PM node …/tsx/… apps/server/src/index.ts            ← pre-existing OpenMuse dev server (user's)
78293 5:52PM node …/tsx/dist/cli.mjs watch apps/server/src/index.ts
78356 5:52PM node …/apps/mobile/…expo/bin/cli start --web --port 8081
79017-79023 5:52PM node …/jest-worker/…                       ← expo's jest workers, not OpenMuse TaskWorker
78301 5:52PM …/esbuild/darwin-arm64/bin/esbuild --service
```

- No process matching a OpenMuse `apps/worker` / TaskWorker exists at all.
- No openmuse process was started by the baseline: the only processes it started are the `openbot-v4-postgres` container and the OpenBot API (`ps -o pid,lstart,command -p 63995` → `63995  Mon Oct 12 23:25:10 2026  bun run dev`), which contains neither "openmuse" nor "taskworker".
- The pre-existing processes were left untouched, as required.

### 6.4 `smoke-db-off` (15:25:21Z) — readiness fails when the database is absent

```
[2026-10-12T15:25:21Z] stopping container openbot-v4-postgres
[2026-10-12T15:25:25Z] /ready answered 503 within 10s
[2026-10-12T15:25:25Z] /ready body: {"status":"unavailable","database":"down"}
[2026-10-12T15:25:25Z] /health while db down: {"status":"ok"} [http 200]
```

`/ready` returned 503 within 4s of `docker stop`; `/health` stayed 200 (actual, recorded).

### 6.5 Restart path — `up` again (15:25:29Z)

```
[2026-10-12T15:25:29Z] container openbot-v4-postgres exists, starting it
[2026-10-12T15:25:31Z] postgres is ready
[2026-10-12T15:25:31Z] enterprise roles already present
[2026-10-12T15:25:31Z] applying migrations (bun run db:migrate)
[✓] migrations applied successfully!
[2026-10-12T15:25:32Z] applied migrations in database: 77          ← no-op, still 77
[2026-10-12T15:25:32Z] API already running (pid 63995), not starting another
[2026-10-12T15:25:32Z] /ready is 200: {"status":"ok","database":"up"}
```

### 6.6 `down` — clean teardown (15:25:37Z)

```
[2026-10-12T15:25:37Z] stopping API (pid 63995)
[2026-10-12T15:25:38Z] removed container openbot-v4-postgres
[2026-10-12T15:25:38Z] down complete
```

Post-down verification: ports 55434 and 18787 free; `docker ps -a` has no `openbot-v4-postgres`; `/tmp/openmuse-v4-baseline/api.pid` removed. Nothing on 5432/8787/55433 was touched at any point.

## 7. Files

| File | Change |
|---|---|
| `scripts/openmuse-v4-baseline.sh` | new, executable, `set -euo pipefail`, subcommands `up/status/smoke-db-off/down`; shellcheck clean (shellcheck 0.11.0 present) |
| `server/tests/ready.test.ts` | new, 3 tests, all pass |
| `server/src/app.ts` | `/ready` route + appended-last `readinessProbe` param + `defaultReadinessProbe` (`SELECT 1`, 1500 ms race); `/health` untouched; biome re-sorted imports only |
| `server/src/index.ts` | NOT modified (the default probe uses the database already passed as `attachmentDatabase` — the assembly's one and only database) |
| `docs/openmuse-v4/o01-deployment-baseline.md` | this file |

Raw cycle captures live under `/tmp/openmuse-v4-baseline/` (`up-final.txt`, `status-final.txt`, `smoke-db-off-final.txt`, `up-restart.txt`, `down-final.txt`, `process-inventory-final.txt`, `api.log`).
