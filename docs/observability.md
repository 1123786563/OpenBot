# Observability

OpenBot logs one JSON line per record, so `docker logs`, `.logs/*.log` and the local Loki all
read the same shape. This page is the team's convention for what those lines contain and how to
read them: the local stack that collects it all (P3) is described first, then the P1 logging and
request tracking, the P2 distributed tracing and the P3 crash-reporting sink; the later phases
are listed at the end.

## Observability stack

**One command starts the local stack:**

```sh
docker compose --project-directory . -f docker/compose/observability.yml up -d
```

It brings up eight containers — the LGTM five (Loki, Tempo, Prometheus, Alloy, Grafana) plus
GlitchTip with its own postgres and redis — split into a file of its own, the same way `lago` is.
A plain `docker compose up -d` never starts any of them, because a deployment that has configured
no telemetry has no need of them. Every port below is published on loopback only, and the `*_PORT`
variables in `.env` — the commented samples in `.env.example` name them — override the defaults:

| Service | URL | What it is |
| --- | --- | --- |
| Grafana | http://127.0.0.1:3003 | The front door: Explore for logs and traces, and the provisioned `OpenBot Starter` dashboard under the OpenBot folder. First login is `admin`/`admin`; the forced password change can be skipped on a laptop. |
| Loki | http://127.0.0.1:3102 | The log store. Read it through Grafana's Explore; the HTTP API is there for curl checks. |
| Tempo | http://127.0.0.1:3200 | The trace store, with its OTLP/HTTP receiver on `127.0.0.1:4318`. Tracing below has the queries. |
| Prometheus | http://127.0.0.1:9090 | The metrics store. Today it scrapes only itself; an application `/metrics` target is P4, sequenced in Later phases. |
| GlitchTip | http://127.0.0.1:8001 | The crash-reporting sink. Crash reporting below has initialization, the DSNs and the smoke test. |
| Alloy | http://127.0.0.1:12345 | The log collector's own debug UI, for watching the pipeline. Nothing depends on it. |

**Loki receives logs by two paths, and the stream labels say which.** Alloy watches the local
Docker socket and ships every container's stdout with `source="docker"` and the container's name
in `container`; it also tails the host's `.logs/*.log` — the files `start.sh` appends to,
described under Logging — under `job="host-process"` and `service="host"`. In Grafana's Explore,
`{source="docker"}` is the container view and `{service="host"}` the host view; the lines
themselves are the same JSON shapes the Logging section defines.

**Everything in the stack keeps seven days.** Loki's `retention_period: 168h` actually deletes —
its compactor has retention enabled, which is the switch the period alone is inert without — and
Tempo's `block_retention` and Prometheus's `--storage.tsdb.retention.time=7d` hold the same line.

**Stopping is safe; wiping is a fresh install.**
`docker compose --project-directory . -f docker/compose/observability.yml down`
stops the stack and keeps its data: Grafana's account and dashboards, the Loki indices, the Tempo
blocks and the GlitchTip projects all live in named volumes and survive, and a later `up -d`
continues where the stack left off. Add `-v` and those volumes are deleted — the Grafana account
resets to `admin`/`admin`, every GlitchTip project and DSN is gone, and the seven-day log and
trace history with them. A wipe means starting over, including re-minting the crash-report DSNs
(see Crash reporting).

**Config edits need a recreate.** These services take their configuration from bind-mounted
files under `docker/observability/`, and editing one is not enough: a plain `up -d` finds no
change to recreate (same image, same names) and the old configuration keeps running. After
touching a config file, name the service:

```sh
docker compose --project-directory . -f docker/compose/observability.yml up -d --force-recreate loki   # or tempo, prometheus, …
```

## Logging

The one-page diagram of this pipeline is [observability-architecture.html](observability-architecture.html).

**Every log line goes through the logger in `shared/logger`**, which is pino ^10.4.0 underneath.
Bare `console.*` calls are banned in new code: Biome enforces `noConsole` as an error across
`server/src` and `worker/src`, so the linter rather than a review checklist keeps the rule. Tests
are the deliberate exception, and so is one transitional carve-out, `server/src/billing/service.ts`,
pending a parallel workstream's cleanup. A process that needs a logger asks for one by service name
and gets a memoized instance, so there is exactly one per process.

**Level semantics.** `error` means a failure a person needs to look at. `warn` means something
failed and recovered on its own, which is worth knowing but not worth paging anyone for. `info`
covers requests and state changes. `debug` carries troubleshooting detail nobody sees by default.
The default level is `info`; set `LOG_LEVEL` — `OPENBOT_LOG_LEVEL` is an alias of the same
variable, for environments where the plain name collides — to `fatal`, `error`, `warn`, `info`,
`debug` or `trace` to change it. Anything unrecognised falls back to `info` rather than failing the
process.

**Fixed fields.** Every record carries `service`, the process name (`server`, `worker`, …),
because processes that interleave in a shared `docker logs` would otherwise produce
identical-shaped lines nobody can tell apart. Logs emitted while a request is in flight carry that
request's `request_id` automatically, through the request-scoped child logger rather than a
parameter threaded through every handler. Event-style failures keep the existing
`type: "xxx-…-error"` naming — `memory-sweep-error`, `approval-resume-error` — so a filter on
`type` still finds a class of failures as the code evolves.

**Redaction is a red line (TEN-22).** No raw database errors, no tokens, no keys, no encryption
material in a log line, ever. When a third-party call fails, the log keeps the failure's message and
the domain fields around it — which provider, which operation, which request — and not its payload,
because a payload that came from somebody else can carry anything.

**Reading them.** On the host, `start.sh` appends each process's output to a file under `.logs/`:
`server.log`, `worker.log`, `app.log`, `migrate.log`. pino numbers its levels, so error and above
is `level>=50`:

```sh
tail -f .logs/server.log | jq 'select(.level>=50)'
```

In a terminal attached to a TTY the logger switches to pino-pretty by itself, because a developer's
terminal is not a log sink; set `OPENBOT_LOG_FORMAT=json` to force JSON there too, which is what a
tool pointed at stdout wants.

## Request tracking

**Every response carries `x-request-id`.** A middleware registered ahead of every route mints one
per request, or reuses the inbound header when it is well-formed — `^[A-Za-z0-9._-]{8,128}$`.
The pattern is the point: a hostile header cannot smuggle junk past it and into a future Loki. The
enterprise error body's `request_id` is the same value as the response header on the same response,
so a client that quotes either one is correlating against the same request, and a bug report with a
screenshot of an error resolves to exactly one access-log line.

**Every `/api/*` request logs one access line** with `method`, `path`, `status` and `duration_ms`,
plus the `request_id` above. The line is written even when the handler throws, so a 5xx keeps its
access record instead of leaving the failure unmeasured.

## Tracing

**One span per request, named `METHOD path`.** The tracing helpers live in `shared/trace.ts` and
wrap the OpenTelemetry API so call sites never touch propagation or a tracer directly. Every
process that serves HTTP starts that span around its request handling — `server` through a Hono
middleware, `agent-bot`, `agent-computer` and `supervisor` through a `Bun.serve` fetch wrapper,
and the Go `runtime-go` through an outermost `TraceMiddleware` with the same env contract —
parented by the inbound W3C `traceparent` when one arrived and self-rooted when not. The span
records `http.response.status_code` and takes the ERROR status when the handler throws or
answers 5xx. Outbound is propagation by header only: the server injects the active trace's
`traceparent` into the headers of the calls it makes to the agent bot, the computer and the
supervisor, deliberately without a span of its own, so a server→bot→computer chain arrives as
one continuous trace rather than a span per hop.

**`trace_id` reaches the server's log lines.** While a span is active above the request store,
the request-scoped logger attaches its `trace_id` next to `request_id`, and the access line
carries both. A bug report and a trace query therefore resolve to the same request. Services
that do not scope their logs still span; only the stamping into lines is server-side.

**Off switch and endpoints.** `OPENBOT_TRACES=off` leaves a process entirely unregistered — no
tracer provider, no spans, no export, endpoints set or not. Otherwise spans are always recorded,
and exported over OTLP/HTTP when an endpoint is configured: the signal-level
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used verbatim, full path included, while the generic
`OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/traces` appended. With neither set the provider is
recording-only — spans exist in the process, nothing ships. Every exported span carries
`service.name` set to the process name it came from.

**A failed export is a quiet state, by design.** The exporter batches in the background, and a
failed export surfaces as an OpenTelemetry diagnostic error line and nothing else: no request
fails or waits on its trace's delivery.

### Local Tempo

The observability stack (see the top of this page) ships the sink these spans land in: Tempo with
its OTLP/HTTP receiver on `127.0.0.1:4318` and the query API on `127.0.0.1:3200`. A host process
points at it with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` in the root `.env` — the
generic endpoint gets `/v1/traces` appended — plus a restart, because the endpoint is read once
at boot; `start.sh` hands the root `.env` to the server it launches. A server restarted without
the line is the first thing to check when search comes back empty: with no endpoint configured
the spans stay recording-only, which is silent by design.

Within a few seconds of a request — the batch exporter's interval — the API answers queries:

```sh
# Pass an explicit start/end window (epoch seconds) — this is the reliable form. Bare, the
# search can come back empty even with traces sitting in the store.
curl -s "http://127.0.0.1:3200/api/search" --data-urlencode "serviceName=server" \
  --data-urlencode "start=<epoch-seconds>" --data-urlencode "end=<epoch-seconds>"
curl -s "http://127.0.0.1:3200/api/traces/<traceID>"  # OTLP JSON, spans under batches[].scopeSpans[].spans
```

The in-container services (`agent-bot`, `agent-computer`, `supervisor`, and every per-Bot
computer the supervisor creates) export through the compose network instead of your loopback:
uncomment `CONTAINER_OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318` in the root `.env` and
recreate them (`docker compose up -d agent-bot agent-computer supervisor`; the supervisor hands
the endpoint to each computer it creates). With the variable unset they run recording-only —
spans stay local, which is also silent by design.

In Grafana on port 3003: Explore → pick the Tempo data source → Search → service name `server` →
open a trace for its waterfall. Loki's log lines carry `trace_id` as a derived field, so a log
line in Explore links straight to the same trace.

## Crash reporting

**GlitchTip is the sink, the same file is the switch.** The same
`docker compose --project-directory . -f docker/compose/observability.yml up -d` that brings up
the LGTM stack brings up GlitchTip (plus its own postgres and redis) at
`http://127.0.0.1:8001` — a Sentry-protocol server the client SDKs point DSNs at.
It lives in the same file because it is the same story: a deployment that sends no telemetry has
no need of it, and a plain `docker compose up -d` never starts it. It is pinned to
`glitchtip/glitchtip:6.2.6`, the release the protocol test below was verified against; unlike the
LGTM five it owns its data (`glitchtip-db` volume) and wipes it on upgrade, which is why it runs
beside, not on, the stack's shared postgres — `docker/observability/glitchtip-init-db.sql` has
that argument.

**One process, not three.** The v6 image runs web (granian) and the background worker as a single
process when `GLITCHTIP_EMBED_WORKER=true` is set — compose sets it — and runs its own migrations
at boot. What compose does force is `SECRET_KEY` (`GLITCHTIP_SECRET_KEY` in the root `.env`,
generate once with `openssl rand -hex 32`): the stack refuses to start without it, because Django
signs sessions and password resets with it and a placeholder would look healthy while not being
one.

### Initialization and the DSN

The image has **no env-var bootstrap for an initial admin** (v6.2.6: verified — nothing like
`GLITCHTIP_INITIAL_ADMIN_EMAIL` exists; there is a `bootstrap_dev` command but it requires
`DEBUG=true` and mints hard-coded dev credentials, which is not a thing to leave enabled). The
instance supports either of these, once, on a fresh volume:

**By hand** — open `http://127.0.0.1:8001`, register the first user (registration is open for the
first user by default), create organization `openbot`, create a project per client (`web`,
`mobile`, `desktop`), copy each project's DSN.

**By script** — the same objects through the image's own management commands, no browser needed
(the password arrives through Django's standard `DJANGO_SUPERUSER_*` env contract):

```sh
docker compose --project-directory . -f docker/compose/observability.yml exec -T \
  -e DJANGO_SUPERUSER_EMAIL=admin@openbot.local \
  -e DJANGO_SUPERUSER_PASSWORD=<generated> \
  glitchtip python manage.py createsuperuser --noinput
```

then a one-off `python manage.py shell` block (mirroring what the UI onboarding creates) for the
verified-email flag, organization `openbot`, a project and an API token — `Project.save()`
creates the DSN key itself, and `key.get_dsn()` prints it against `GLITCHTIP_DOMAIN`. Keep the
admin email/password and the DSNs in the root `.env` (untracked): `GLITCHTIP_ADMIN_EMAIL` /
`GLITCHTIP_ADMIN_PASSWORD` — that pair is the login at `http://127.0.0.1:8001` — and
`SENTRY_DSN_WEB`, `SENTRY_DSN_MOBILE`, `SENTRY_DSN_DESKTOP`, one DSN per client against the same
GlitchTip; the commented samples in `.env.example` name them.

A DSN looks like `http://<key>@127.0.0.1:8001/<project-id>` — HTTP because the stack is
loopback-only, which is also why it is not a production secret in local development: the port is
published on loopback only, like every other port in these files.

### Protocol test event

The wire test that proves the sink accepts Sentry envelopes without any SDK involved. The
brief's one-liner mangles the DSN parse (`sentry_key` would carry `key@host:port`), so this is
the corrected form — split the DSN into key and project first:

```sh
DSN=$(grep '^SENTRY_DSN_WEB=' .env | cut -d= -f2)
KEY="${DSN#http://}"; KEY="${KEY%%@*}"; PROJ="${DSN##*/}"
EVENT_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')

printf '{"event_id":"%s","sent_at":"2026-10-10T00:00:00Z"}\n{"type":"event"}\n{"level":"error","platform":"other","logger":"smoke","message":"openbot P3 envelope smoke test"}' "$EVENT_ID" |
curl -s -X POST "http://127.0.0.1:8001/api/$PROJ/envelope/" \
  -H "Content-Type: application/x-sentry-envelope" \
  -H "X-Sentry-Auth: Sentry sentry_key=$KEY, sentry_version=7, sentry_client=openbot-test/1.0" \
  --data-binary @-
# → 200 {"id": "<event_id without dashes>"}
```

Verify it landed (needs an API token — mint one in the UI under Profile → Auth Tokens, or in the
shell block above). Note GlitchTip answers **`/issues/`, not Sentry's `/events/`** — the org
events endpoint 404s here:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8001/api/0/organizations/openbot/issues/
# → issue shortId WEB-1, title "openbot P3 envelope smoke test"
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8001/api/0/organizations/openbot/issues/1/events/latest/
# → the event itself, eventID matching the one sent
```

The embedded worker moves the envelope from redis into Postgres within a second or two of the
200; an empty issues list right after a 200 means the worker is not up.

## Later phases

What remains is sequenced and deliberately not started: a `/metrics` endpoint (P4) and the real
client SDK wiring for the crash reports above — web, mobile and desktop against the DSNs already
minted (P5). The Grafana, Loki and Tempo stack that gives the traces above somewhere to land
(P3) is in — see Observability stack at the top of this page — and so is the GlitchTip sink the
crash reports land in, as of this section.

One serialization note worth keeping for that work: pino serializes an `err` key by default,
message and stack included, which is what error handlers rely on. Every other value belongs in a
structured field, never in string interpolation — interpolated lines are the ones a query cannot
find later.
