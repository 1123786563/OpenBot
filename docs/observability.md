# Observability

OpenBot logs one JSON line per record, so `docker logs`, `.logs/*.log` and a future log collector
all read the same shape. This page is the team's convention for what those lines contain and how to
read them; what it covers shipped with the P1 observability work, and the later phases are listed at
the end.

## Logging

**Every log line goes through the logger in `shared/logger`**, which is pino ^10.4.0 underneath.
Bare `console.*` calls are banned in new code: Biome enforces `noConsole` as an error across
`server/src` and `worker/src`, so the linter rather than a review checklist keeps the rule. Tests
are the deliberate exception. A process that needs a logger asks for one by service name and gets a
memoized instance, so there is exactly one per process.

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

## Later phases

What follows is sequenced and deliberately not started: `trace_id` propagation into Tempo (P2), the
Grafana and Loki stack (P3), a `/metrics` endpoint (P4), and client crash reporting (P5).

One serialization note worth keeping for that work: pino serializes an `err` key by default,
message and stack included, which is what error handlers rely on. Every other value belongs in a
structured field, never in string interpolation — interpolated lines are the ones a query cannot
find later.
