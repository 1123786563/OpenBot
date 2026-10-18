# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.3+, `lsof`, `openssl`, and `curl`. The
Intelligence provisioning below also needs `npx` (Node); `scripts/start.sh` uses `openssl` to mint
the generated secrets on a first run.

```sh
cp .env.example .env
bun install
```

Provision CopilotKit Intelligence after `.env` exists:

```sh
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
bun scripts/setup-learning.ts
```

For fresh managed setup, the helper provisions the selected project's key and creates or reuses
its `openbot` Learning container. It writes `INTELLIGENCE_API_KEY` and
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` to `.env` only after verifying the container. Existing
keys and custom targets are preserved. For fresh self-hosted setup, set `INTELLIGENCE_API_URL`
to the deployment's HTTPS API origin and run only `bun scripts/setup-learning.ts`. Install
Chrome or Edge first: the helper opens an isolated browser window for the deployment's usual
sign-in, lets you choose an accessible project, and creates or reuses `openbot` before minting
its runtime key. Local development may use a loopback HTTP origin. Existing key-only setups
use authenticated Intelligence administration to create a container and assign it in OpenBot Admin.
There is no managed licence step. Then add `OPENAI_API_KEY`.

Start the stack:

```sh
bash scripts/start.sh
```

The optional stacks — kb, casdoor/open-connector, lago, observability — live in separate files
under `docker/compose/`; [compose.md](compose.md) has the map, the ports and the invocations.

## Running services

Use `bash scripts/start.sh` for the full local stack. It starts Docker services, applies migrations, starts the API server, the app, and the routine worker, and verifies health routes.

Use `bash scripts/stop.sh` to take it down: the app, the routine worker, the API server, the Docker services, and each Bot's computer, which the supervisor makes rather than compose and which therefore outlives `docker compose down`. Pass `--keep-computers` to leave those browsers signed in. Nothing is deleted either way.

Use `bun run dev` only when you want the app and API server without starting the Docker Bots and computers.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-computer`  | 4100                       |
| `agent-bot`       | 4200                       |
| `agent-langgraph` | 4201                       |
| `supervisor`      | 4500 host / 4300 container |
| PostgreSQL        | 5432                       |

`start.sh` hands every selected Docker service to `docker compose up -d` on every run, so one whose configuration changed is recreated and an unchanged one is left as it is. It leaves an API server or app that already answers as OpenBot alone, restarts the API server when it refuses the worker's secret or has no routines route, and reports when a port is held by another process.

**Nothing here sweeps staged attachments.** A file dropped into the composer is stored before the
message is sent, and the only thing that reclaims the ones never sent is
`bun scripts/cull-staged-attachments.ts` from `server/`, which the Helm chart runs hourly and which
neither `docker-compose.yml` nor `start.sh` starts. It needs only `DATABASE_URL`, and takes a
retention window in hours as its one optional argument, defaulting to 24. On a laptop that is
usually nothing, because the rows are small and the database is yours. It stops being nothing at
thirty-two: one person may hold that many unsent files across every channel at once, the refusal on
the next one promises they are cleared within a day, and where nothing sweeps they are not, so a
long-lived local deployment can reach a state where attaching anything is refused. Removing a file
in the composer deletes it outright, so it takes abandoned drafts rather than ordinary use.
[deployment.md](deployment.md) says the same for a real deployment.

## Logs and troubleshooting

Server logs are one JSON line per record, with the level controlled by `LOG_LEVEL`; the field
conventions and how to read the lines are in [observability](observability.md). On the host, every
process `start.sh` starts appends to a file under `.logs/` — `server.log`, `worker.log`, `app.log`,
`migrate.log` — and nothing truncates them. In a container, `docker logs` shows the same lines.

## Migrations

`bash scripts/start.sh` starts the local Compose database before its migration service. That service
uses the guarded runtime migrator with the explicit local bootstrap option, so a fresh local cluster
creates the four `NOLOGIN` capability roles atomically before application migrations. No separate
role command is needed for this path.

The direct `bun run --filter server db:migrate` command uses the same preflight-bearing migrator but
does not enable automatic role creation. For a separately managed development database, point
`ENTERPRISE_SETUP_DATABASE_URL` at the target using a direct PostgreSQL superuser login, then run
this once from the repository root before migrating:

```sh
psql --dbname "$ENTERPRISE_SETUP_DATABASE_URL" --single-transaction --set=ON_ERROR_STOP=1 --file=server/ops/enterprise/roles.sql
```

The bootstrap creates only `NOLOGIN` capability roles; create application LOGIN roles and
credentials separately. It reads `pg_authid.rolpassword`, so `BYPASSRLS` alone cannot run it.
`scripts/migrate.ts` always checks that all four capability roles are present and safe before SQL.

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Review generated migration files before sharing them. `start.sh` applies existing migrations when it starts the stack.

**Do not hand-edit a generated migration.** It leaves a file that no longer matches what the
generator produced. If the generated SQL will not work — `ADD COLUMN ... NOT NULL` fails on a table
that already has rows — split it instead: generate the column nullable, add the data step, then
generate the constraint.

**A constraint that tightens an existing column belongs to a later release**, not to the release that
adds the column. A rolling deploy runs the migrations and then serves from old and new replicas at
once, and an old replica writes rows without the new column: under `NOT NULL` its writes start
failing, so the release that added the column breaks for everybody who lands on a replica that has
not been replaced yet. Ship the column nullable, let the fleet turn over, then tighten it. `issuer`
on `accounts` is the worked example: the column is nullable and no migration tightens it.

**A data step is its own migration**, created with the flag that exists for it:

```sh
bun run --filter server db:generate -- --custom --name=backfill_something
```

A generator diffs schema against schema, so a rule like "the rows whose provider is Google get
Google's issuer" can never come out of one: it is not in the schema. `--custom` writes an empty file
registered in the journal, and it is the only migration anybody should be writing by hand.

CI enforces two things about this: `drizzle-kit check` for collisions and gaps between migrations,
and a generate-and-fail-if-dirty probe that refuses a schema change with no migration written for it.

**If `drizzle-kit migrate` hangs and then exits non-zero with no error**, the journal names a
migration file that is not there. A rebase does this: `meta/_journal.json` is a checked-in file, so
restoring it can reinstate entries for migrations that were renamed. `drizzle-kit check` reports
"Everything's fine" in that state, because it compares schemas rather than checking that the journal
and the directory agree. Compare `meta/_journal.json` against `ls server/drizzle/*.sql`.

## Quality checks

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests expect a PostgreSQL database. Point `TEST_DATABASE_URL` at a dedicated database such as `postgres://openbot:openbot@localhost:5432/openbot_test` before running them.

They refuse to use the application `openbot` database. `DATABASE_URL` is still the application setting, and the database client removes it from the process environment after opening a connection to preserve the Windows Bun connection fix, so tests use `TEST_DATABASE_URL` as their immutable fixture address. Running them against a deployment you are using puts test Bots in its audit trail and its activity reports, so create a separate database and migrate that before running the integration suite.

CI uses `bun run test:ci` to verify the expected test count in addition to normal tests.

### 测试运行器：tester-army `e2e`

`bun run test` 就是 `e2e run --config e2e.unit.config.ts`。收集、钩子、断言、报告与退出码全部由
[e2e](https://github.com/tester-army/e2e) 负责；浏览器套件仍是 `bun run test:ui`（`e2e.config.ts` 的
web target），两者用 `--config` 分开选择。

```sh
bun run test                                        # 单元 + 集成（tools-only target，不开浏览器、不调用模型）
E2E_UNIT_SCOPE=app,server bun run test              # 只收集这两个目录：整套收集一次要几分钟
bunx e2e run --config e2e.unit.config.ts tests/compose.test.ts   # 只跑一个文件
node scripts/e2e-report-summary.mjs .e2e/unit/report.json        # 按失败原因分组看结果
```

套件文件从 `tests/support/e2e-compat` 取 `test`/`describe`/`expect`/`mock`/`spyOn`，不要直接
`import from "bun:test"`（那会把用例留在旧运行器里，`bun run test` 不再收集它们）。兼容层只补
`e2e` 文档明确不提供的部分：`toThrow`/`rejects`/`resolves`/`toBeInstanceOf`/类型断言/mock 调用断言、
`test.each`、`mock.module`、Bun 风格的 spy 与假时钟；能被 `e2e` 原生表达的绝不自己实现。

依赖 Bun 运行时本身的套件（server 的 SQL/HTTP 层、`bun:` 协议、Bun 加载器行为、可写的 ESM
namespace）继续以 `bun test` 执行，但由 e2e 调度与报告：清单在
`docs/verification/e2e-bun-suites.json`，它们从 `tests/support/bun-test-compat` 取同样的 API，
`tests/bun-suites.test.ts` 按组跑并把 bun 的用例数与失败文本折进一条 e2e 断言（用例数为 0 判失败）。
清单由逐文件收集审计生成，`scripts/e2e-partition-fix-loop.mjs` 负责在依赖变化后把它收敛回干净；
分区落定后用 `node scripts/e2e-apply-partition.mjs` 双向改写导入，可重复执行。

新增 matcher 或运行时能力时先看 `e2e` 的文档（`node_modules/e2e/docs`），再决定是补兼容层还是改清单，
不要静默地把本该原生跑的套件推到 Bun 侧藏问题。

`bun run test:smoke` is separate and needs a deployment that is up, and a session on it:

```sh
bash scripts/start.sh
export OPENBOT_SMOKE_COOKIE='better-auth.session_token=...'
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach: server to supervisor to computer, the gateway deciding before the browser acts,
and the audit row landing. Point it elsewhere with `OPENBOT_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

The session is not optional and not a convenience. Every route the journey proves is behind
`requireUser`, so without one the three tests that act on a computer answer 401 and the run reports
a broken deployment when nothing is broken. Take the cookie from a browser already signed in to the
deployment under test, from DevTools under Application, Cookies. It is a credential with that
person's reach: it belongs in the environment of the run, not in a file or a pull request comment.
Asked for without it, the run stops before the first test and names the variable.

`bun run test:ui` is the browser-level suite, driven by the [e2e](https://github.com/tester-army/e2e)
framework, and needs a deployment that is up, the same way `test:smoke` does:

```sh
bash scripts/start.sh
bun run test:ui
```

It drives a real Chromium against `localhost:3010` the way a person does: sign in through Casdoor,
manage Bot sessions and lifecycle, and exercise the admin, channels, plugins, routines and billing
surfaces. The agent steps that judge the screen run on the `OPENAI_API_KEY` in `.env`, and
`E2E_MODEL` picks a different model.
`bun run test:ui:headed` runs it with a visible browser.

Every run writes `.e2e/report.json` and, per test, a `trace.md` under `.e2e/results/` with the step
list, screen diffs, console errors and a screenshot at the point of failure; `.e2e/` is gitignored.
The suite runs one test at a time (`workers: 1`), because every test drives the same deployment and
its default Bot allows a single run at a time. The framework sends anonymous usage telemetry by
default; opt out with
`E2E_TELEMETRY_DISABLED=1`.

`bun run test:live-screen` is separate for a related reason and needs no deployment, only this
directory's own dependencies:

```sh
cd agent-computer && bun install
cd .. && bun run test:live-screen
```

It drives the live screen against the real computer process with a real Chromium: a socket closing
while the browser is still starting, a second connection taking the screen from the first, the wheel
refusing input from the socket that owns it, and a browser closing by request or by the idle sweep.
Those need `agent-computer/src/index.ts`, which imports Playwright at module scope, and `playwright`
is declared only in `agent-computer/package.json`, which `bun install` at the root does not reach. So
without `OPENBOT_LIVE_SCREEN=1` the files skip before importing anything, which is what keeps
`bun run test` and CI working where that dependency was never installed.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
