# Observability

OpenBot logs one JSON line per record, so `docker logs`, `.logs/*.log` and a future log collector
all read the same shape. This page is the team's convention for what those lines contain and how to
read them; what it covers is the P1 logging and request tracking plus the P2 distributed tracing,
and the later phases are listed at the end.

## Logging

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

The compose stack ships the sink these spans land in. Start it with
`docker compose --profile observability up -d` — a plain `docker compose up -d` never starts it,
the same arrangement as the `lago` profile — which brings up Tempo with its OTLP/HTTP receiver on
`127.0.0.1:4318` and the query API on `127.0.0.1:3200`. A host process points at it with
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` in the root `.env` — the generic endpoint gets
`/v1/traces` appended — plus a restart, because the endpoint is read once at boot; `start.sh`
hands the root `.env` to the server it launches. A server restarted without the line is the first
thing to check when search comes back empty: with no endpoint configured the spans stay
recording-only, which is silent by design.

Within a few seconds of a request — the batch exporter's interval — the API answers queries:

```sh
curl -s "http://127.0.0.1:3200/api/search" --data-urlencode "serviceName=server"
curl -s "http://127.0.0.1:3200/api/traces/<traceID>"  # OTLP JSON, spans under batches[].scopeSpans[].spans
```

In Grafana on port 3003: Explore → pick the Tempo data source → Search → service name `server` →
open a trace for its waterfall. Loki's log lines carry `trace_id` as a derived field, so a log
line in Explore links straight to the same trace.

## Later phases

What follows is sequenced and deliberately not started: a `/metrics` endpoint (P4) and client
crash reporting (P5). The Grafana, Loki and Tempo stack that gives the traces above somewhere to
land (P3) is in — see Local Tempo above.

One serialization note worth keeping for that work: pino serializes an `err` key by default,
message and stack included, which is what error handlers rely on. Every other value belongs in a
structured field, never in string interpolation — interpolated lines are the ones a query cannot
find later.
