# Preview-origin TLS certificates (ACME DNS-01 wildcard)

Production craft previews live on per-session subdomains `<hash>.<preview-host>` (spec
`craft-preview-origin`, D3/D7), so the preview origin needs exactly one wildcard
certificate: `*.<preview-host>` — one label deep, matching `<hash>.<preview-host>` and
nothing deeper. This page is the deployment guide for the pipeline that issues and
renews it: `docker/compose/certs.yml`, the `openbot-tls` sidecar (acme.sh), and the
renewal guard that makes failures loud.

The dev form needs none of this: an empty `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`
means `127.0.0.1:<port>` previews (D5), and the sidecar exits 0 without issuing
anything.

## Quick start

> **Compose floor:** `certs.yml` uses the `env_file` long syntax (`path:` +
> `required:`), which docker compose v2 has supported only since **2.24** — older
> releases fail with an unknown-key error that reads like a broken repository, so
> pin the floor before the first `up` (fix-ocr22 #9).

```bash
# 1. The TLS directory (bind-mounted at /etc/openbot/tls inside the sidecar).
mkdir -p tls && chown 1000:1000 tls        # match OPENBOT_TLS_UID/GID below

# 2. DNS provider credentials — copy the template, fill ONE provider block, lock it down.
cp docker/compose/certs/dns.env.example dns.env && chmod 600 dns.env

# 3. Configure (.env or the environment):
#    OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE=https://{session}.preview.example.com
#    ACME_ACCOUNT_EMAIL=ops@example.com
#    ACME_CA=letsencrypt_test          # staging first: dry-run end to end, then switch
#    OPENBOT_TLS_UID=1000              # the uid that owns ./tls (and reads the key)
#    OPENBOT_TLS_GID=1000

# 4. Start beside the main stack (same project name: Alloy tails these logs too).
docker compose --project-directory . -f docker/compose/certs.yml up -d

# 5. Watch the first issuance.
docker logs -f openbot-tls
```

When it succeeds, `tls/` holds `cert.pem`, `key.pem` (0600), `renewal-status.json`,
`reload.stamp`, and the sidecar's whole acme state under `acme-home/` (0700:
account key, issued certificates, `acme.sh.log`). Everything the sidecar writes
lives under this one bind mount.

**Who reads `cert.pem`/`key.pem`** (corrected 2026-10-18, #419): the process that
terminates TLS for `*.<preview-host>`. In this repository that is **not** the OpenBot
server — `server/src` never opens these files and the server listens plain HTTP; the
adopted topology (#403 R2) puts a reverse proxy in front of the preview origin, and
that proxy is the certificate consumer. Point its `ssl_certificate` / `ssl_certificate_key`
at this same directory (host `tls/`, `/etc/openbot/tls` inside containers) and wire its
reload to the hooks below. A deployment that terminates TLS some other way — a managed
load balancer, for example — can leave this sidecar out entirely and let the platform
own the certificate.

## What the pipeline does

- **Issues** `*.<preview-host>` via ACME DNS-01 (`acme.sh --issue --dns <plugin>`).
  DNS-01 needs **no inbound reachability**: Let's Encrypt queries the public DNS TXT
  record, so the preview origin can stay on an internal network.
- **Installs** the certificate with `--install-cert` into `tls/cert.pem` +
  `tls/key.pem`, registering `reload.sh` as the reload hook.
- **Renews** on a loop (`acme.sh --cron` every `OPENBOT_TLS_RENEW_INTERVAL_SECONDS`,
  default 6h; acme.sh itself renews 60 days before the 90-day expiry).
- **Observes**: every issue/renewal outcome lands in `tls/renewal-status.json`;
  `renewal-guard.sh` turns that plus the certificate's remaining days into health
  (`starting` / `ok` / `warn` / `critical`), alerts on degradation, and re-pages at
  most once per cooldown while a failure persists. The same evaluation is the
  container healthcheck, so a red `docker ps` is the zero-config signal.

### The preview host is derived, never configured twice

The certificate name comes from the same `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` the
server reads (#361): `https://{session}.preview.example.com` → base
`preview.example.com` → certificate `*.preview.example.com`. `{session}` must be the
hostname's leading label, exactly once, no path/query — mirroring
`server/src/craft/preview-origin.ts`. An `http://` template is invalid on both
sides (fix-ocr18 #9, aligned with the server's fix-ocr4 #9: the SameSite=None;
Secure pass cookie can never plant on a plain-http origin, so the server closes
admission and the sidecar refuses the same template), an invalid template fails
the sidecar loudly. A base of exactly `localhost` is the recorded divergence:
the server explicitly supports the local testing form, but no public CA can
issue for the reserved domain, so the pipeline records a skip. Wildcards cover
one label only (`*.<base>` does not match `a.b.<base>`),
which is exactly the one-label-per-session shape the design chose.

## DNS providers and credentials

Credentials live in `./dns.env` (git-ignored; `chmod 600`), injected as the sidecar's
environment via `env_file`. The pipeline checks credential NAMES (never values) at
startup and fails with a precise message when one is missing.

| Provider | `ACME_DNS` | Variables | Notes |
|---|---|---|---|
| Cloudflare (recommended) | `dns_cf` | `CF_Token` (+ optional `CF_Account_ID`, `CF_Zone_ID`) or legacy `CF_Email`+`CF_Key` | Free; create an API token scoped to the preview zone only (`Zone → DNS → Edit`) |
| Aliyun DNS | `dns_ali` | `Ali_Key`, `Ali_Secret` | RAM user, grant only the preview zone |
| DNSPod (Tencent) | `dns_dp` | `DP_Id`, `DP_Key` | |
| Huawei Cloud | `dns_huaweicloud` | `HUAWEICLOUD_Username`, `HUAWEICLOUD_Password` | |
| deSEC | `dns_desec` | `DESEC_TOKEN` | Free, open source, API-first |

Any other acme.sh plugin works too: set `ACME_DNS` to its name and provide its
variables in `dns.env` (the startup check just skips the table above).

### Recommended: subdomain delegation (least privilege)

Do not hand the pipeline credentials for your main zone. Delegate the preview
subdomain's NS to an API-friendly provider and scope the credential to that zone
only:

```dns
;; in the parent zone (example.com)
preview.example.com.   IN NS   chad.ns.cloudflare.com.
preview.example.com.   IN NS   lia.ns.cloudflare.com.
```

Then `preview.example.com` is its own zone at Cloudflare (free), the API token can
only read/write it, and a leaked token exposes nothing but the preview TXT records.
deSEC is the fully-free alternative (delegation + token in one place).

### Resolution checklist (browsers must reach `<hash>.<preview-host>`)

- [ ] `*.<preview-host>` (or at least the hash labels in use) resolves publicly —
      Let's Encrypt's DNS-01 validation queries public DNS regardless of where the
      server actually runs.
- [ ] Browsers resolve it too: an internet-facing deployment points the wildcard at
      the server's public IP; a purely internal deployment needs split-horizon DNS
      (internal resolvers answer `<hash>.<preview-host>` with the internal IP while
      the public zone still answers the ACME TXT queries), or a public A record
      pointing at the internal IP (accepting the exposure that implies).
- [ ] The preview template's scheme is `https`. The server enforces this on both sides
      (it closes admission on an `http://` template) — but it describes the scheme
      browsers see, **not** a listener the server owns. Something in front of the server
      must actually terminate TLS for `*.<preview-host>` and forward plaintext HTTP.

## Renewal failure observability (AC8)

`tls/renewal-status.json` is the durable signal (scalar fields, written by the
guard): `health`, `healthReason`, `daysLeft`, `lastAttemptOk/At/Kind/Error/Digest`,
`lastSuccessAt`, `lastAlertAt/Severity`, `previewHost`, `certificate`. Consumers are
the container healthcheck, the alert channels below, a dashboard reading the file
directly — and, since #411, the OpenBot **server**: the preview origin's HOST-form
admission reads it (default `/etc/openbot/tls/renewal-status.json`, overridable with
`OPENBOT_TLS_STATUS_FILE`; the main compose mounts `./tls` there read-only) and closes
while the certificate is missing, expired, failing to renew, or mid-first-issuance
(`starting`), surfacing the guard's own `healthReason` as the closed-origin sentence —
and re-judging on the next request the moment the sidecar rewrites the file, no
restart. The DEV form never reads it (no certificate in its path). A certificate that
goes bad is therefore a closed origin with a readable reason, not addresses that fail
in the browser. #359's `Produces` contract is this file plus the alert channels
below.

`renewal-guard.sh` turns the certificate's remaining days plus the last attempt
into health (`starting` / `ok` / `warn` / `critical`). `starting` is a fresh
deployment's first issuance still in flight — no certificate and no attempt record
yet, which is minutes of DNS-01 propagation, not a failure; the first recorded
attempt (or an installed certificate) resolves it to a real state.

Alerts fire when: a renewal attempt fails, the certificate is missing/expired, or
days-left crosses the warn band (30d) then the critical band (14d) — a healthy
renewal lands ~60 days before expiry, so warn already means "something is stuck".
Delivery:

1. **Always a log line** — `openbot-tls-alert severity=… reason=… days_left=…` in the
   container logs. With the observability stack up (Alloy tails the whole `openbot`
   project), a Loki alert rule on `{container="openbot-tls"} |= "openbot-tls-alert"`
   is the zero-config paging path.
2. **`OPENBOT_TLS_ALERT_WEBHOOK=http(s)://…`** — one JSON POST per alert
   (`{"source":"openbot-tls","severity":…,"message":…,…}`); point it at GlitchTip, a
   Slack/DingTalk bridge, or anything that accepts JSON.
3. **`file:/path`** — appends the same JSON as JSONL; what the drill and CI observe.

Re-pages are deduped by `OPENBOT_TLS_ALERT_COOLDOWN_SECONDS` (default 24h); a
warn→critical escalation fires immediately; recovery emits exactly one `ok` event.

## Certificate reload (new cert → live, no restart)

`reload.sh` runs inside the sidecar after every install/renewal:

1. Permission floor: `key.pem` 0600, `cert.pem` 0644, optional
   `OPENBOT_TLS_OWNER=uid:gid` chown when the sidecar runs as root.
2. `touch tls/reload.stamp` — the polling seam: a mtime bump for whoever terminates
   TLS and can watch the directory (an nginx-style proxy re-reading on `SIGHUP` does
   not need this; a process that can only poll does).
3. `OPENBOT_TLS_RELOAD_URL=http://…` — an HTTP POST to the reload endpoint of
   **whatever is terminated the TLS**. Use it when the proxy exposes one (Traefik,
   Caddy, an API-driven managed balancer); leave it unset for a proxy reloaded by
   signal, and do not point it at the OpenBot server, which has no such endpoint.

A reload, never a restart: the listener, in-flight requests and websocket upgrades
survive; the next accept already uses the new certificate. This pipeline guarantees only
that the files are in place and the signals fire — the reload itself belongs to the TLS
terminator, and as of `bbea87ba` no deployment evidence in this repo shows that handoff
running in production (see #419: AC8 is `partial` — pipeline implemented, production run
not yet proven).

## Reference TLS termination topology (#412)

The consumer side now ships as a runnable reference: `docker/compose/preview-tls.yml`
(its own compose project, `openbot-preview-tls`) runs `nginx:1.27-alpine` as the TLS
terminator for `*.<preview-host>` — one catch-all 443 server presenting the wildcard,
SNI-aware, forwarding plaintext HTTP (websocket-upgrade aware) to the OpenBot server.
What is in `docker/compose/preview-tls/`:

- `nginx.conf.template` — rendered at container start by the image's envsubst
  (`OPENBOT_PREVIEW_UPSTREAM`, default `http://host.docker.internal:3000` — point it
  at a compose service name when the terminator shares the server's network;
  `OPENBOT_PREVIEW_TLS_SERVER_NAME`, default `_` = the only 443 server =
  default_server). It also serves a loopback-only `:8080/healthz` so the container
  healthcheck never depends on the certificate or the upstream.
- `reload-watcher.sh` — the **reload.stamp consumer**: polls the stamp's mtime (default
  every 15s, `OPENBOT_PREVIEW_TLS_RELOAD_POLL_SECONDS`) and turns a bump into
  `nginx -t && nginx -s reload` (a SIGHUP: listeners, in-flight requests and websocket
  upgrades survive; the next TLS accept uses the new certificate). A failed
  `nginx -t` — e.g. a half-written cert pair — logs a WARN and leaves the OLD
  certificate serving; the next bump retries. This is the AC8 "old cert keeps
  serving" behavior on the terminator side.
- `start.sh` — the container command: watcher in the background, `nginx` foreground.

**Reload hooks are alternatives — pick one.** This watcher consumes mechanism 1
directly: it watches `reload.stamp`. `OPENBOT_TLS_RELOAD_URL` (mechanism 2) is for
terminators with an HTTP reload endpoint (Traefik/Caddy admin
APIs, managed balancers) — nginx has none, so leave it **unset** in this topology;
otherwise the sidecar logs a harmless WARN per renewal. Never configure both.

**Permissions note (deliberate tradeoff):** `key.pem` stays 0600 owned by
`OPENBOT_TLS_UID:GID`; the stock nginx image's **master** process runs as root and
reads the key exactly once per load, and the nginx-user workers never open it — the
standard official-image posture. The non-root alternative: `user:
"<OPENBOT_TLS_UID>:<OPENBOT_TLS_GID>"` on the service plus `cap_add:
[NET_BIND_SERVICE]` (443 is privileged) and a key owned by that same uid — workable,
but depends on the deployment's uid matching and on the capability being granted, so
it is not the default.

### Startup order and verification

```bash
# 1. Certificates first — the terminator is fail-closed: nginx refuses to start
#    without tls/cert.pem + key.pem, so a certificate-less preview origin never
#    serves anything (not even a wrong-cert handshake).
docker compose --project-directory . -f docker/compose/certs.yml up -d
docker logs -f openbot-tls        # wait for the first issuance

# 2. Terminator beside the main stack (its own project, not the shared one).
docker compose --project-directory . -f docker/compose/preview-tls.yml up -d

# 3. Verify the wildcard is what TLS clients see (AC8 form):
openssl s_client -connect 127.0.0.1:443 -servername abc123.preview.example.com \
  </dev/null 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName
# expect: CN = *.preview.example.com covering DNS:*.preview.example.com
```

### Hot-reload verification (new cert → live, no restart)

```bash
# Baseline: the serial of the certificate currently served.
S1=$(openssl s_client -connect 127.0.0.1:443 -servername abc123.preview.example.com \
  </dev/null 2>/dev/null | openssl x509 -noout -serial | cut -d= -f2)

# Simulate a renewal: replace the pair and bump the stamp exactly like
# docker/compose/certs/reload.sh does (cert 0644, key 0600, touch).
cp tls/cert.pem /tmp/backup-cert.pem; cp tls/key.pem /tmp/backup-key.pem
# ... swap in the renewed cert.pem/key.pem from your issuance/renewal run ...
touch tls/reload.stamp

# Within one poll interval (15s default) the watcher reloads nginx — check the log:
docker logs openbot-preview-tls --since 1m   # "[openbot-preview-tls] nginx reloaded ..."

# Next TLS connection already serves the new serial; the container never restarted.
S2=$(openssl s_client -connect 127.0.0.1:443 -servername abc123.preview.example.com \
  </dev/null 2>/dev/null | openssl x509 -noout -serial | cut -d= -f2)
[ "$S1" != "$S2" ] && echo "hot reload OK" || echo "still old cert — check watcher log"
```

### Interplay with #411 admission closure

The terminator and the server close independently, and the combination fails safe:
when the certificate is missing/expired/renewal-failing, `renewal-status.json` goes
red and the **server** closes preview-origin admission (#411, reads the same `./tls`
mount) with the guard's `healthReason` as the sentence — while the terminator either
keeps serving the still-valid old certificate (renewal failing, cert fine) or, if the
files themselves are gone, fails closed too (nginx will not start / workers stop on a
bad reload). There is no window where a closed origin serves traffic through the
terminator. A `critical` guard page plus a still-serving old certificate is exactly
the drilled AC8 outcome (`docker/compose/certs/drill-renewal-failure.sh`); the
live-staging evidence remains deployment-side (see Known gaps below).

## Private-key and credential hygiene

- `key.pem` is 0600, owned by `OPENBOT_TLS_UID:GID` — the uid that needs to read the
  private key, i.e. the sidecar and whatever process terminates TLS for the preview
  origin; the sidecar itself runs as that uid (`user:` in the compose file), not root.
- `dns.env` is git-ignored, 0600, read via `env_file` into the sidecar only — no
  other service sees it, no value is ever logged (startup checks name variables).
- `tls/` is git-ignored: `git status` after a drill or issuance must stay clean.

## Failure drill (AC8: inject one renewal failure)

```bash
# Deterministic, offline, no docker/network — what CI runs:
bash docker/compose/certs/drill-renewal-failure.sh --offline

# The true path: Let's Encrypt STAGING + deliberately invalid DNS credentials.
# The order is really created, the TXT challenge is really generated, and the
# Cloudflare API really rejects the token — the exact code path a revoked
# production token takes (needs docker + outbound network):
bash docker/compose/certs/drill-renewal-failure.sh --live-staging
```

Both assert the two AC claims: the failure ALERTS (critical) and the installed
certificate is byte-for-byte untouched while valid (the service keeps serving).
The offline drill also proves the cooldown, the re-page, and the recovery event.
`KEEP=1` preserves the scratch directory for inspection. The live drill runs the
sidecar via `docker compose run` in a throwaway project (`openbot-tls-drill`),
binds its own scratch dir as the TLS directory, and cleans the project up after.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` | (empty) | The same template the server reads; empty = dev = no pipeline |
| `ACME_CA` | `letsencrypt` | `letsencrypt_test` for staging (dry runs, no rate limits) |
| `ACME_ACCOUNT_EMAIL` | — | Required; expiry notices go there |
| `ACME_DNS` (dns.env) | — | The acme.sh DNS plugin, e.g. `dns_cf` |
| `OPENBOT_TLS_HOST_DIR` | `./tls` | Host directory bind-mounted at `/etc/openbot/tls`. Resolved against `--project-directory` — omit it and the default lands at `docker/compose/tls/` (git-ignored as a fallback, fix-ocr22 #8). Any OTHER in-repo directory you point this at holds secrets and must be added to `.gitignore` by the deployment itself — the repo only covers `./tls` and `docker/compose/tls/` |
| `OPENBOT_TLS_UID` / `OPENBOT_TLS_GID` | `1000` / `1000` | The sidecar's user; own `tls/` accordingly |
| `OPENBOT_TLS_WARN_DAYS` / `OPENBOT_TLS_CRIT_DAYS` | `30` / `14` | Health bands |
| `OPENBOT_TLS_ALERT_WEBHOOK` | — | `https://…` POST or `file:/path` JSONL |
| `OPENBOT_TLS_ALERT_COOLDOWN_SECONDS` | `86400` | Re-page interval while degraded |
| `OPENBOT_TLS_RELOAD_URL` | — | Optional reload POST to the **TLS terminator** (not the OpenBot server, which exposes no such endpoint) |
| `OPENBOT_TLS_RENEW_INTERVAL_SECONDS` | `21600` | Renewal loop cadence (min 600) |
| `OPENBOT_TLS_RENEW_CMD` | — | **Test seam — do not set in production.** Replaces the renewal command (`sh -c`); the failure drill (`drill-renewal-failure.sh`) and `scripts/tls-pipeline.test.ts` drive failure/recovery through it |
| `OPENBOT_TLS_STATUS_SET_HOOK` | — | **Test seam — do not set in production.** A `sh -c` command status_set runs between the status-file read and the publish, so a test can hold a second writer inside the write window (the concurrency suite's race seam) |
| `OPENBOT_TLS_RECYCLE_HOOK` | — | **Test seam — do not set in production.** A `sh -c` command status_set runs inside the stale-lock recycle window, so a test can replay the recycle TOCTOU deterministically |

## Known gaps without real credentials

A real issuance needs a real DNS zone and API token, which only the deployment has.
Everything up to the provider API call is exercised: template derivation, the
acme.sh command surface, install/reload, failure detection, alerting, and the
failure path itself (staging + invalid token). The first production issuance and a
real renewal-around-day-60 remain deployment-side acceptance evidence — record them
in the deployment's own runbook when they happen.

## #358 修复期验证快照（2026-10-17，SHA 8797d2d9）

- `bun test scripts/tls-pipeline.test.ts`：99/99 通过（模板派生、acme.sh 命令面、
  install/reload、失败检测与告警、续期失败注入恢复、并发窗口）。
- `docker compose config`：合法。
- 准入关闭演练（真实栈，`OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED=false`）：
  `webapp-info.previewOriginClosedReason` 给出可展示原因；`webapp_url` 为
  null（不存在可绕行地址）；preview host 不回退同源（dev 形态 label 未注册
  落回主站路由 404；host 形态 503 由准入关闭套件钉住）；主站 API 不受影响。
- **AC8 首签/续期/告警的运行证据：仍然 blocked** —— 无 staging DNS zone 与
  专用凭据。上节"Known gaps"的边界不变；不得把测试面结果标为签发证据。
