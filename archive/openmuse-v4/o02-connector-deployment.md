# O02 — OpenConnector and OAuth callback: deployment evidence

Ticket: GitHub issue #89 (catalog O02). Plan: `docs/superpowers/plans/tickets/O02-connector-deployment.md` (openmuse worktree).
Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base` (branch `v4/openbot-exec`). No commits made.

All timestamps UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`); local machine time is UTC+8.
Generated secrets are referenced by path only, never by value: `/tmp/openmuse-v4-baseline/connector.key`
(OOMOL_CONNECT_ENCRYPTION_KEY, mode 600), `key-encryption-key`, `o02-dummy-client-id`, `o02-dummy-client-secret` (both 600).

## 1. Task 0 — official distribution (citation)

The OpenConnector runtime's official distribution is a **prebuilt Docker image on GitHub Packages (GHCR)**, not Docker Hub:

- Image: `ghcr.io/oomol-lab/open-connector` — repo `oomol-lab/open-connector` README §"Docker Image (GHCR)": "Run OpenConnector from a prebuilt image on GitHub Packages (GHCR): `ghcr.io/oomol-lab/open-connector`. Use `latest` for the newest release, a pinned released version for production, or `tip` for the latest `main` build."
- `docs/docker-ghcr.md` (fetched 2026-10-13): "The image is: `ghcr.io/oomol-lab/open-connector`", public, multi-arch (`linux/amd64` + `linux/arm64`), listens on 3000, binds `0.0.0.0`, data in `/app/data`; canonical `docker run` uses `OOMOL_CONNECT_ORIGIN`, `OOMOL_CONNECT_ENCRYPTION_KEY`, `OOMOL_CONNECT_ADMIN_TOKEN`.
- `docs/configuration.md` (fetched 2026-10-13): env reference — `PORT`, `HOST`, `OOMOL_CONNECT_ORIGIN` ("Public origin used for OAuth redirect URLs"), `OOMOL_CONNECT_DATA_DIR` (Docker: `/app/data`), `OOMOL_CONNECT_ENCRYPTION_KEY` ("Encrypts credentials, … OAuth config, pending OAuth state"), `OOMOL_CONNECT_ADMIN_TOKEN`.
- **Docker Hub has no `oomol/open-connector`** (registry API `hub.docker.com/v2/repositories/oomol/open-connector` → `object not found`, checked 2026-10-13). The plan's "docker hub oomol/open-connector" hint is superseded by the GHCR image, so the **failure-handling fallback path was NOT needed**: the official image exists and ran.

Chosen path: run `ghcr.io/oomol-lab/open-connector:latest` (pulled 2026-10-13, digest
`sha256:61e5e29a9ae7d8e817e8050d062ed57134e069cea3e7eef7cb15349c11b7a76d`, arm64 native on this Apple-Silicon host).
The script also supports the plan-required `CONNECTOR_IMAGE` override (e.g. a self-built `docker build` of the public repo) without editing the script.

## 2. Ports

| Port | Role | Status |
|---|---|---|
| 5432 / 8787 / 55433 | other projects (OrbStack forwards / node) | occupied — untouched |
| 55432 | plan default postgres — OCCUPIED by an OrbStack-forwarded container (same as O01) | `OPENMUSE_V4_PGPORT=55434` used |
| 55434 | postgres for this baseline (verified free) | used |
| 18787 | API (plan default; verified free) | used |
| 55441 | connector (plan default; verified free before the cycle) | used |

## 3. Deviations from the plan (both discovered live, both recorded per plan §Failure handling spirit)

1. **Redirect URI path: `/api/public/openmuse-google/callback`, not the plan's `/api/mobile/openmuse-google/callback`.** The code truth composes the callback from `OPENBOT_PUBLIC_ORIGIN` + `/api/public/openmuse-google/callback` (server/src/index.ts:3966; mounted at `app.route("/api/public/openmuse-google", …)` in server/src/app.ts:1981 — `/api/mobile/openmuse-google` is the session-guarded connect/status sub-app, app.ts:1980). Registering the plan's literal path would have registered a redirect no seam ever uses; the code-true path is what any future boot-time `pushGmailClientConfig` also sends. §5.4 shows the live connector echoing both `redirectUri` and `expectedRedirectUri` equal to the code-true value.
2. **`GOOGLE_OAUTH_CLIENT_ID/SECRET` is NOT set in the baseline API env — so the boot-time `pushGmailClientConfig` path does not fire here.** config.ts reads `GOOGLE_OAUTH_*` as the sign-in identity provider (`authConfig`), which switches `singleUserEnabled` off (`if (hasProvider) return false`) and demands `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` (observed live: boot refused with "Sign-in requires BETTER_AUTH_SECRET" on the first attempt, `/ready` 000 within 30 s). A local baseline is the documented single-user no-sign-in mode, so the OAuth client is registered against the live connector by the evidence PUT (§5.4) — the exact operation the plan names — and the same registration would flow through the server seam in a provider-mode deployment.
3. **No `OOMOL_CONNECT_ADMIN_TOKEN`** (conforms to the plan naming only `OOMOL_CONNECT_ORIGIN` + `OOMOL_CONNECT_ENCRYPTION_KEY`, recorded here because docker-ghcr.md recommends one): the OpenBot dial (`server/src/openmuse-connectors/client.ts`) sends no bearer, so a token would 401 the tokenless requests this deployment's seams send. The backend restriction for this baseline is the `127.0.0.1` docker publish (§5.3).

Also fixed while integrating `status`: `docker inspect` prints a bare newline to stdout for an absent container, which folded `absent` onto a second line (pre-existing for the postgres line too).

## 4. What `up` starts (O02 additions to the O01 baseline)

- `openbot-v4-connector` from `${CONNECTOR_IMAGE:-ghcr.io/oomol-lab/open-connector:latest}`, published `-p 127.0.0.1:55441:3000`, data bind-mounted at `/tmp/openmuse-v4-baseline/connector-data` (SQLite, auto-migrating on open; no PostgreSQL URL set → no explicit migrate step, per configuration.md "Runtime database").
- Env on the container: `OOMOL_CONNECT_ORIGIN=http://127.0.0.1:55441` (derived from the port), `OOMOL_CONNECT_ENCRYPTION_KEY=$(cat /tmp/openmuse-v4-baseline/connector.key)` (generated once, 0600, never echoed).
- API env additions (connector mode): `OPENCONNECTOR_URL=http://127.0.0.1:55441` (the env name config.ts:2311 and index.ts already read — no client.ts change needed), `OPENBOT_PUBLIC_ORIGIN=http://127.0.0.1:18787` (default `http://127.0.0.1:${APIPORT}`, overridable `OPENMUSE_V4_PUBLIC_ORIGIN`).
- `OPENMUSE_V4_CONNECTOR=0` restores the exact O01 API-only stack (no connector container, no `OPENCONNECTOR_URL`).
- Readiness: `wait_for` polls `GET /api/providers` (200 unauthenticated when no admin token is set; verified) before the API starts.

## 5. Full cycle — outputs (`scripts/openmuse-v4-baseline.sh`; PGPORT=55434 as in O01)

Raw captures under `/tmp/openmuse-v4-baseline/o02-*.txt`. Migration NOTICE noise (identifier truncation) omitted here; identical to O01's benign set.

### 5.1 `up` (fresh, final script; 00:01:45Z–00:01:51Z)

```
[2026-10-13T00:01:45Z] running new container openbot-v4-postgres on 127.0.0.1:55434
[2026-10-13T00:01:47Z] postgres is ready
[2026-10-13T00:01:47Z] creating enterprise capability roles (server/ops/enterprise/roles.sql)
[2026-10-13T00:01:47Z] applying migrations (bun run db:migrate)
[✓] migrations applied successfully!
[2026-10-13T00:01:49Z] applied migrations in database: 95
[2026-10-13T00:01:49Z] migration journal at HEAD of worktree: 95 files, latest 0094_tearful_blue_shield.sql
[2026-10-13T00:01:49Z] running new container openbot-v4-connector from ghcr.io/oomol-lab/open-connector:latest on 127.0.0.1:55441
[2026-10-13T00:01:50Z] connector is ready
[2026-10-13T00:01:50Z] starting API on port 18787 (log: /tmp/openmuse-v4-baseline/api.log)
[2026-10-13T00:01:51Z] /ready is 200: {"status":"ok","database":"up"}
```

`/ready` 200 with `OPENCONNECTOR_URL` set in the API env. (95 migrations: the worktree HEAD moved past O01's 77 — concurrent tickets' uncommitted migrations; not this ticket's change.) `api.log` contains no connector errors and none of the generated secret values (grep for each: 0 matches).

### 5.2 `status` (00:01:51Z)

```
[2026-10-13T00:01:51Z] container: running
[2026-10-13T00:01:51Z] connector container: running
[2026-10-13T00:01:51Z] api: pid 17463 alive
[2026-10-13T00:01:51Z] /health: {"status":"ok"}
[2026-10-13T00:01:51Z] /ready:  {"status":"ok","database":"up"} [http 200]
[2026-10-13T00:01:51Z] connector /api/providers: [http 200]
```

### 5.3 Backend restriction — loopback binding (`o02-bind-check.txt`)

```
LANIP=192.168.3.39
--- loopback (expect 200):
http 200                                    ← GET 127.0.0.1:55441/api/providers
--- non-loopback 192.168.3.39:55441 (expect failure):
http 000
non-loopback curl exit code: 7 (7=connection refused)
--- docker publish (expect 127.0.0.1:55441->3000):
3000/tcp -> 127.0.0.1:55441
{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"55441"}]}
```

The connector's runtime/admin interfaces answer on loopback only; a non-loopback attempt is refused at the publish (`HostIp` 127.0.0.1, curl exit 7).

### 5.4 OAuth client config PUT against the live connector (clientId dummy, redirectUri = OPENBOT_PUBLIC_ORIGIN + code-true callback)

Dummy credentials generated at cycle time into 0600 files (`o02-dummy-client-id` = `openmuse-v4-baseline-<12-byte hex>`, `o02-dummy-client-secret` = `openssl rand -base64 32`); values never echoed — the PUT body was composed in-shell from the files.

```
PUT /api/oauth/configs/gmail -> http 200
{"service":"gmail","configured":true,"clientId":"openmuse-v4-baseline-dc002bc85909e9e9d0c86568",
 "expectedRedirectUri":"http://127.0.0.1:18787/api/public/openmuse-google/callback",
 "redirectUri":"http://127.0.0.1:18787/api/public/openmuse-google/callback","missingFields":[], …}
PUT /api/oauth/configs/googlecalendar -> http 200
{"service":"googlecalendar","configured":true, … same redirectUri/expectedRedirectUri …}
```

(The response never echoes `clientSecret`; the stored scopes are the vendor's documented gmail/calendar sets. Both services registered, mirroring `pushGmailClientConfig`'s loop over `OPENMUSE_GOOGLE_PROVIDERS`.)

**Live end-to-end smoke through the OpenBot API's own G01 seam** (single-user dev actor; server dials the connector over `OPENCONNECTOR_URL`):

```
POST /api/mobile/openmuse-google/connect  {"returnUri":"openmuse://baseline-smoke"}  → 200
authorizationUrl = https://accounts.google.com/o/oauth2/v2/auth?…&client_id=openmuse-v4-baseline-…
redirect_uri (decoded) = http://127.0.0.1:18787/api/public/openmuse-google/callback
```

The connector composed Google's authorization URL with the registered callback: the configured public origin reached the vendor boundary end-to-end through the deployment's own route.

### 5.5 Secret scan of the mobile bundle (`apps/openmuse/apps/mobile/dist/web`, 6.3 MB static export)

```
rg -c '<dummy-client-id value>' dist/web      -> 0 matches
rg -c '<dummy-client-secret value>' dist/web  -> 0 matches
rg -c '<connector-encryption-key value>' dist/web -> 0 matches
rg -c '<api-key-encryption-key value>' dist/web   -> 0 matches
rg -c 'GOOGLE_OAUTH_CLIENT_SECRET|OOMOL_CONNECT_ENCRYPTION_KEY|OPENCONNECTOR_URL' dist/web -> 0 matches
```

No secret value and no secret-bearing env name enters the mobile bundle.

### 5.6 `down` (00:02:06Z) — clean teardown

```
[2026-10-13T00:02:06Z] stopping API (pid 17463)
[2026-10-13T00:02:07Z] removed container openbot-v4-postgres
[2026-10-13T00:02:07Z] removed container openbot-v4-connector
[2026-10-13T00:02:07Z] down complete
```

Post-down: ports 55434/18787/55441 all free; no `openbot-v4-*` containers; nothing on 5432/8787/55433/55432 touched at any point. Machine left clean.

## 6. Regression — API-only cycle still green (`OPENMUSE_V4_CONNECTOR=0`)

```
up:      … 95 migrations … starting API on port 18787 … /ready is 200: {"status":"ok","database":"up"}
status:  container: running | connector container: absent | api: pid 16570 alive | /health 200 | /ready 200
         connector /api/providers: [http 000]unreachable
docker:  no connector container exists (correct)
api.log: 0 lines matching "openmuse-google" (correct — no connector wiring in API-only mode)
down:    removed both attempts' containers cleanly (o02-api-only-down.txt)
```

The O01 contract (postgres + API only) is unchanged by the O02 additions.

## 7. S15 note — real Google consent stays gate-level

Everything above runs on generated dummy credentials. A real consent still requires a real Google OAuth client (real `GOOGLE_OAUTH_CLIENT_ID/SECRET` in a provider-mode deployment with `BETTER_AUTH_*`), a public https `OPENBOT_PUBLIC_ORIGIN`, and a human click-through on Google's consent screen — the S15 gate. O02 evidences the deployment plumbing up to that gate: the callback origin, the vendor registration, the loopback boundary, and the secret-free bundle.

## 8. Files

| File | Change |
|---|---|
| `scripts/openmuse-v4-baseline.sh` | O02 additions: connector service (up/down/status), generated `connector.key` (0600) + bind-mounted data dir, `CONNECTOR_IMAGE`/`OPENMUSE_V4_CONNECTOR_PORT`/`OPENMUSE_V4_CONNECTOR`/`OPENMUSE_V4_PUBLIC_ORIGIN` knobs, `OPENCONNECTOR_URL`+`OPENBOT_PUBLIC_ORIGIN` in the API env; absent-container status fix. sha256 `dcaa4282318352a26e048ab8781a508e94079f8b2a1abb8c4ea78b0dbf265ddf` |
| `server/src/openmuse-connectors/client.ts` | NOT modified — `OPENCONNECTOR_URL` (config.ts:2311, index.ts) already matches the env the script sets; no alignment needed |
| `docs/openmuse-v4/o02-connector-deployment.md` | this file |

Verification: `bash -n` clean; shellcheck 0.11.0 clean; no TypeScript source touched, so no typecheck/biome run applies (the plan requires them only for touched source). No commits.
