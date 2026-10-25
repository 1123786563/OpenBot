# Compose stacks

The repository's Compose files: what each one is, how to run it, and the rationale that used to
sit inline in `docker-compose.yml`. This page is the single index; the files themselves carry the
operational one-liners. `archive/notes/kb-migration-2026-10-11.md` records the split out of the old single
file, and the 2026-10-14 move of the optional stacks under `docker/compose/`.

## The files

| File | Services | When you need it |
| --- | --- | --- |
| `docker-compose.yml` (repo root) | `postgres`, `migrate`, `agent-computer`, `agent-sandbox`, `openbot-redis`, `spire-init` / `spire-server` / `spire-agent`, `supervisor`, `agent-bot`, `agent-harness` (profile `harness`), `agent-langgraph`, `agent-trpc`, `go-runtime` (profile `go-runtime`) | Always, first. `scripts/start.sh` drives this file. |
| `docker/compose/services.yml` | `casdoor`, `open-connector` | When `CASDOOR_OAUTH_*` is configured, or the self-hosted OpenConnector broker should run. |
| `docker/compose/lago.yml` | `lago-redis`, `lago-pdf`, `lago-migrate`, `lago-api`, `lago-front`, `lago-worker`, `lago-clock` | When billing talks to Lago (`LAGO_API_URL`). |
| `docker/compose/observability.yml` | `loki`, `tempo`, `prometheus`, `alloy`, `grafana`, `glitchtip` (+ its own postgres and redis) | When local telemetry is wanted — [observability.md](observability.md) is the guide. |
| `docker/compose/certs.yml` | `openbot-tls` | When the preview origin runs on a public wildcard host (`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`) — [tls-certs.md](tls-certs.md) is the guide. |

## Running them

Run from the repository root, and pass `--project-directory .` for every file under
`docker/compose/`:

```sh
docker compose up -d                                                     # the main stack
docker compose --project-directory . -f docker/compose/services.yml up -d
docker compose --project-directory . -f docker/compose/lago.yml up -d
docker compose --project-directory . -f docker/compose/observability.yml up -d
docker compose --project-directory . -f docker/compose/certs.yml up -d
```

**Why `--project-directory .` is not optional.** Compose derives the project directory from the
first `-f` file's location, and the project directory is what decides two things: which
interpolation `.env` is read (the repo root's), and what the `./docker/...` and `./casdoor/...`
mount sources inside these files point at. With the flag, a file under `docker/compose/` resolves
exactly as it did when it lived at the root — same mounts, same `.env`. Without it, the root `.env`
is not read at all: Lago fails loudly on its missing `env_file`, GlitchTip loudly on its required
`GLITCHTIP_SECRET_KEY`.

**Start the main stack first.** These files share the main project's `data` network and reach
`postgres` by service name; cross-file `depends_on` is not a thing Compose resolves, so the restart
policies absorb a postgres that is not up yet (a container that starts early crash-loops briefly
and then comes up). `lago-migrate` is the one-shot exception — it exits on a dead database rather
than retrying, so run it against a healthy main stack.

**The optional files are outside default discovery on purpose.** A plain `docker compose up -d` on
the main file never starts any of them; each is brought up by its own `-f` invocation. They all
carry `name: openbot`, the main file's project name, so volumes keep their `openbot_*` names and a
stack that ran under the old single file keeps its data (`qdrant-data`, `lago-redis-data`,
`open-connector-data`, `loki-data`, …) without a migration step.

## Ports

Every published port binds loopback only (`127.0.0.1` and `[::1]`), and every one has a `*_PORT`
override named in `.env.example` (the craft dev range is the `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_[START|END]` pair).

| Stack | Loopback ports |
| --- | --- |
| main | postgres 5432, agent-computer 4100, supervisor 4500→4300, agent-bot 4200, agent-langgraph 4201, agent-harness 4202 (picked), agent-trpc 4204, go-runtime 4203, agent-sandbox 4300 + craft dev range 3011-3098, openbot-redis 6379 |
| services | casdoor 8000, open-connector 3100 |
| lago | lago-api 48889, lago-front 48890 |
| observability | grafana 3003, loki 3102, tempo 3200 (+ OTLP 4318/4317), prometheus 9090, alloy 12345, glitchtip 8001 |

## Rationale

### The postgres image

Plain PostgreSQL plus pg_partman, built from `docker/postgres-partman.Dockerfile`. The pgvector
base image is gone — embeddings moved to Qdrant and migration 0010 dropped the last Postgres-side
vector column — but a deployment starting from nothing still replays migration 0000, which creates
`chunks.embedding` and fails on a stock image with `extension "vector" is not available`. So
`vector` stays, installed from the PGDG apt repo the base image already carries. `partman` is for
Lago: it installs from `db/structure.sql` and unconditionally drops and recreates pg_partman, so
the binary has to be present in the server or that load fails. The data volume this stack already
runs on is unaffected by the image swap.

### The network split

Three networks. `data` carries the database and the services that reach it by name — `postgres`,
`migrate`, `openbot-redis`, plus the optional stacks' services. `default` carries everything else:
the Bots, their computers, the supervisor, SPIRE. `openbot_sandbox` is the sandbox's own bridge.
The point of the split: with no `networks:` anywhere, Compose puts every service on one network
with DNS by service name, so `agent-computer` — the one container whose whole job is to run what a
Bot asks for, shell included — could open `postgres:5432` with the credentials in this file. The
published loopback port remains the host-side contract; taking postgres off the Bots' network
removes the name, not the localhost address. A deployment that runs the API server inside Compose
puts that service on both `data` and `default`, which is the one place the two are meant to meet.

### Loopback on both families

Every published port binds `127.0.0.1` and `[::1]`, not just one. `localhost` resolves to ::1 or
127.0.0.1 in an order the platform decides, and Bun and Node both fail the connection outright
rather than trying the other family — publishing on one makes `localhost` work on some machines
and not others, for a reason nothing in the error mentions. Publishing on both is still loopback.

### Image names and pull policy

Each built service has an explicit image name (`openbot-postgres`, `openbot-server`,
`openbot-agent-computer`, …) and `pull_policy: ${IMAGE_PULL_POLICY:-build}`. A release publishes
those images, and a machine that can name one does not need a toolchain to build it; a service
carrying `build:` builds by default however its image is named, so the policy is what picks
between the two. `IMAGE_PULL_POLICY=missing` makes a deployment pull instead. A failed pull still
falls back to building, silently — right for a developer, wrong for an installed OpenBot with no
toolchain, so installers override the `build` section away rather than relying on the variable.

### The databases on this postgres

Three init scripts mount into the postgres entrypoint — `casdoor/init-db.sql`, `docker/lago/init-db.sql`,
`docker/openconnector/init-db.sql` — one login role and one database
each, so none of these tenants shares a schema with OpenBot's own tables. They are read-only and
run once, on the first boot of a fresh data volume only; the volume this stack already runs on had
them applied by hand, because init scripts never re-run against existing data.

### Per-Bot egress

`agent-computer` and `supervisor` read `egress.env` (`env_file: ./egress.env`, `required: false`).
The names are per-Bot (`EGRESS_PROXY_<BOT>` is derived from the Bot's id, plus `EGRESS_PROXY_DEFAULT`),
so there is no fixed list to write into the file; and it is not `.env` because that one holds the
deployment's secrets and the browser container is deliberately not given them. The supervisor does
not read the values itself: it forwards every `EGRESS_PROXY` key out of its own environment into
each computer it creates, so it has to be given them first. Optional, because a proxy-less
deployment is the ordinary case and must still start.

### The supervisor and the engine socket

The supervisor holds the Docker socket — root-equivalent — so only it gets the socket, its port is
loopback-only, and `SUPERVISOR_TOKEN` is a shared secret rather than a network boundary. The mount
is read-only because the service only ever needs to ask. `ENGINE_SOCKET` is a setting because the
default path is wrong on rootless Podman on Linux: the path is either absent or, with podman-docker
installed, a symlink to the rootful socket, and the supervisor then holds a dead socket and reports
that it cannot reach Docker. Point `ENGINE_SOCKET` at `$XDG_RUNTIME_DIR/podman/podman.sock` there.
`security_opt: label=disable` because the engine socket carries an SELinux label the container is
not allowed to read.

### The picked harness

`agent-harness` is ONE service rather than twelve: a picked harness is a choice, and the image and
port come from `.env`, which the setup shell writes from the pick — each harness fixes its own port
in its own Dockerfile. It sits behind the `harness` profile so a deployment that has picked nothing
does not try to start it; without that, an unset `PICKED_HARNESS_IMAGE` becomes a request to pull
the empty string, which fails the whole `compose up` rather than the one service nobody asked for.
No `build:` section, so `pull_policy` is `missing` here: this image is only ever published, never
built from this tree.

### SPIRE

Optional workload identity. SPIRE issues each computer an SVID based on the container labels the
supervisor sets, so a computer cannot claim another Bot's identity and an unregistered container
receives no identity. The agent runs with `pid: host` because its attestor reads the peer cgroup
from the host pid namespace, and it mounts the Docker socket read-only only so the workload
attestor can see which container is asking. `spire-init` chowns the fresh named volumes (they
arrive owned by root) so neither the CA nor the agent runs as root. Without these services the
product runs without workload identity and reports that state explicitly.

### The Go runtime

The Go runtime candidate is off by default behind the `go-runtime` profile:
`docker compose --profile go-runtime up go-runtime`. It serves the enterprise wire
(three-header authenticated execution/cancel), validates identity against the enterprise entry's
`/internal/enterprise/v1/runtime/validate`, and calls governed tools back through
`/internal/enterprise/v1/tool-invocations`. The host-run enterprise entry is its only caller, so
the port is loopback-only. Nothing here touches the legacy deployment's bot registry.

### The Redis instances

Three Redis instances, named to stay unmistakable: `openbot-redis` (this stack — workshop turn locks
and event fan-out, pure memory on purpose: persisting it would resurrect locks whose owner process
is long gone), `lago-redis` and `glitchtip-redis` (each owned by the stack that names it).

### The sandbox port range

`agent-sandbox` publishes `SANDBOX_PORT` and the Craft webapp dev range. Craft's per-session dev
servers bind `OPENBOT_CRAFT_SANDBOX_NEXTJS_PORT_[START|END]` inside the container, and the API
server on the host probes/previews them through the gateway base, so the range publishes to
loopback exactly like the gateway port.

The range has one source: the two `.env` keys. `docker-compose.yml` publishes `START-END` on
the host and the container side from the same interpolation — defaults 3010/3100, matching the
server's own defaults in `server/src/craft/config.ts` — so even with no `.env` at all the
published range equals the range the server allocates from. `.env.example` ships 3011/3098
instead, because 3010 collides with the vite dev server and a fresh checkout copies the example.
To change the range, edit the two keys in `.env` and run `docker compose up -d agent-sandbox`
again (the container is recreated with the new publish; restart a host-run API too — it reads
the keys at startup). A port already taken makes the publish fail —
`lsof -nP -iTCP:<port> -sTCP:LISTEN` and `docker ps --filter publish=<port>` name the holder;
free it or move the range.

Production never publishes this range to a host: the orchestrator assigns sandbox ports there,
and the loopback publish is a dev-stack concern only.

### Casdoor and OpenConnector

`casdoor` is the identity provider OpenBot signs in through when `CASDOOR_OAUTH_*` is configured:
stateless (everything it owns lives in postgres, through its own database and login role),
reached by browsers at the loopback address the sign-in page is served on, plus the `app.conf`
mount. `open-connector` is the self-hosted broker behind the deployment's own app catalogue: the
credentials people type stay in its volume, encrypted with `OPENCONNECTOR_ENCRYPTION_KEY`, and the
two tokens are the boundary against everything else on the machine. Its database default
(`OOMOL_CONNECT_DATABASE_URL`) points at the `openconnector` database on the shared postgres; a
fresh database needs an explicit migrate before first start:
`docker compose --project-directory . -f docker/compose/services.yml run --rm open-connector npm run runtime:migrate`.
The image is `latest` today and gets pinned to a digest when cutting a release.

### Lago

Digest-pinned to getlago/lago v1.53.0, the release OpenBot's client and webhook verifier were
integration-tested against. Secrets never live in the compose file: they come from
`docker/lago/.env` (generated once by `docker/lago/init-env.sh`) through each service's `env_file`,
and the database is the shared postgres through the dedicated `lago` database and login role.
Partman-less on purpose — `docker/lago/init-db.sql` has what that trades away and why.
`lago-migrate` runs Lago's migrations and, on the very first boot, mints the operator account and
organization API key from the `LAGO_ORG_*` seed values.

### The observability stack

The LGTM five (Loki, Tempo, Prometheus, Alloy, Grafana) plus GlitchTip with its own postgres and
redis, split out of the main file the same way Lago was — a plain `docker compose up -d` never
starts any of it. `observability.md` is the guide (URLs, queries, DSNs, the protocol test); the
compose-level facts: Alloy runs as root so the read-only `docker.sock` is openable whatever gid it
carries and tails every container plus the host's `.logs/`; Grafana's datasources and starter
dashboard are provisioned from `docker/observability/`; GlitchTip owns its data and wipes it on
upgrade, which is why it runs beside — not on — the shared postgres; `GLITCHTIP_SECRET_KEY` is
forced because Django signs sessions with it; everything keeps seven days.

## Validating a change

```sh
bunx e2e run --config e2e.unit.config.ts tests/compose.test.ts
docker compose config --quiet                                              # main
docker compose --project-directory . -f docker/compose/services.yml config --quiet  # and the other three
```
