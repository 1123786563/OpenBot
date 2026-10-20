# Self-hosted Hindsight (personal memory)

Deployment recipe for the private Hindsight instance that backs OpenBot's personal-memory
module. OpenBot remains the authority for review, permissions, corrections, and forgetting;
this service only indexes and retrieves already-approved content (spec:
`docs/specs/2026-10-15-hindsight-personal-memory-design.md`, ADR 0005).

## Privacy posture (normative)

| Control | Value | Where |
| --- | --- | --- |
| Image version | pinned `ghcr.io/vectorize-io/hindsight:1.0.0` (digest recorded below) | `docker-compose.yml` |
| Model calls | LLM **and** embeddings routed through the approved OpenAI-compatible gateway; reranker stays in-process | `hindsight.env` (`HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL`) |
| Content tracing | off | `HINDSIGHT_API_LLM_TRACE_ENABLED=false` |
| Terminal operation payloads | pruned after 1 day | `HINDSIGHT_API_OPERATION_RETENTION_DAYS=1` |
| Controlled backups | copies deleted at the first run once they reach 30 whole days of age; between runs up to one schedule interval more (daily cron worst case ~31 days) | `backup.sh` + `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS` |
| API exposure | `127.0.0.1:8888` only — the OpenBot server on this host is the sole client | `docker-compose.yml` `ports` |
| Control-plane UI (9999) | **not published at all** | `docker-compose.yml` (no entry) |
| API auth | required bearer key on every request | `HINDSIGHT_API_TENANT_EXTENSION` + `HINDSIGHT_API_TENANT_API_KEY` |

OpenBot's compliance validation (`server/src/hindsight/config.ts`) reads the mirrored
`HINDSIGHT_PRIVACY_*` block; a deployment that has not declared the privacy values
explicitly is reported noncompliant, never assumed fine.

## Layout

- `docker-compose.yml` — pinned single-container stack (embedded PostgreSQL in `hindsight-data`).
- `hindsight.env.example` — every runtime value, with the privacy rules called out. Copy to
  `hindsight.env` (git-ignored; contains secrets). Gateway URLs are `change-me-*` placeholders:
  fill in the approved gateway's OpenAI-compatible root **including `/v1`**. Because Hindsight
  runs in a container, where `127.0.0.1` is the container itself, a gateway on this host is only
  reachable via `host.docker.internal` — such host addresses are for **isolated local
  verification only** (e.g. the stand-in below) and must never be used in production.
- `backup.sh` — controlled `pg_dump` backup with the retention sweep: a copy is deleted at
  the first run once it has existed for `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS` whole days
  (`find -mtime +N` only matches at N+1 whole days, so the sweep passes N−1; measured boundary:
  29.0d/29.5d kept, exactly 30.0d deleted). The value resolves host environment → this
  directory's `hindsight.env` → default 30, and only 1..30 are accepted (0 "keep nothing" is
  not expressible by a scheduled sweep — rejected loudly; don't schedule the job instead).
  pg_dump receives the database password over stdin, never as an exec argv/env declaration;
  archives are written owner-only (umask 077), integrity-checked (`gzip -t`) before their
  final name appears, and partial files are removed by an EXIT trap.
- `test/gateway-standin.mjs` — OpenAI-compatible **stand-in** used only for isolated local
  verification while the approved gateway (Bifrost) endpoint config is not yet delivered.
  Binds loopback only by default; a non-loopback `--host` (e.g. `--host 0.0.0.0` for a local
  container to reach it via `host.docker.internal`) is refused unless `--allow-non-loopback`
  is also passed. Never point production at it.
- `extensions/openbot_tenant/` — OpenBot's custom tenant authentication and bank-scope
  validation (#381), mounted read-only into the container and selected via `hindsight.env`:
  `OpenBotTenantExtension` (the service identity is the PAIR of the shared API key and a
  short-lived HMAC-signed bank-scope assertion OpenBot mints per trusted identity; one
  PostgreSQL schema per company, provisioned on the company's first authenticated request)
  and `OpenBotOperationValidator` (every retain/recall/delete confined to the banks the
  assertion names; tags are classification and never widen the grant). The signing secret
  `HINDSIGHT_API_TENANT_ASSERTION_SECRET` here must equal OpenBot's
  `HINDSIGHT_BANK_ASSERTION_SECRET`; the OpenBot-side seam is
  `server/src/hindsight/bank-scope.ts`.
- `test/contract-instance.sh` — boots a throwaway instance of the same pinned image with the
  extensions selected, the stand-in as model gateway, and a reused HuggingFace cache, for
  the real-instance allow/deny matrix in `server/tests/hindsight-bank-isolation.contract.test.ts`
  (`start` / `stop` / `status`).

## Operating

```bash
cp hindsight.env.example hindsight.env   # fill in real gateway URL/key and API key
docker compose up -d
curl -s -H "Authorization: Bearer $HINDSIGHT_API_TOKEN" http://127.0.0.1:8888/health
./backup.sh            # daily via cron; prunes copies once they reach the 30-day window
```

**Linux hosts:** on Docker Engine ≥ 20.10 the compose file pins `host.docker.internal` to the
host-gateway address (`extra_hosts: host.docker.internal:host-gateway`), so the gateway URLs in
`hindsight.env` resolve to the host exactly as they do on Docker Desktop (macOS/Windows), where
the name is provided natively. On engines or network setups without that mapping, replace
`host.docker.internal` in `hindsight.env` with an address of the host reachable from the
container (e.g. the `docker0` bridge IP). The mapping takes effect when the container is
(re)created via `docker compose up -d`.

Three-state health check (OpenBot side):

```bash
bun test server/tests/hindsight-health.test.ts
```

`checkHindsightHealth(loadHindsightConfig())` reports `service_up`, `gateway_down`,
`config_noncompliant`, or `service_down` — states and rule names only, never memory
content, tokens, or endpoints.

## Verified image

- Tag `ghcr.io/vectorize-io/hindsight:1.0.0`
- Index digest `sha256:a88678c038b0e4340822b02a5efc566c56d8176b5bffa731bc433fd37f978e4c`
  (verification evidence and command log: `archive/plans/hindsight-personal-memory/reports/ticket-380.md`
  in the execution workspace).

## Explicit non-goals

- Service availability here does not mean personal-memory recall works end to end; that is
  later tickets (per the wave plan).
- Company/bank isolation is enforced by the extensions above, but wiring OpenBot's recall
  paths (which memories flow into which bank, review-gated) is later tickets' work; this
  recipe only guarantees that what reaches the service is confined to the granted banks.
