# MT131 — 验收 harness 与独立测试环境（Issue #174）

Status: **implemented and verified** by the dispatched MT131 worker. No commit made; work sits as untracked owned files in this task's Orca child worktree, checkpointed with SHA-256 under `checkpoints/MT131/`. Prerequisite hashes from `checkpoints/MT131/before.json` (17 files incl. MT001 inventory generator/test and MT002 fixture/scenarios/fixtures-test) were re-verified unchanged immediately before and after implementation; HEAD stays at BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`.

## 1. Where the work lives

- Worktree: `/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt131`, HEAD = BASE `f0520524` (no commits, per controls).
- Created (owned paths only, all new files):
  - `server/scripts/multitenancy/acceptance-harness.ts` — the harness module + CLI.
  - `server/tests/multitenancy/acceptance-harness.test.ts` — 14 tests covering every Issue #174 criterion.
  - `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT131-harness.md` (this file) and `checkpoints/MT131/**`.
- Modified tracked files: **none**. Shared MT001/MT002 files and `server/tests/support/enterprise-database.ts` were consumed read-only; `git status` shows only the pre-existing untracked prerequisite trees plus the owned paths above.

## 2. What was built

A directly runnable acceptance harness that consumes the MT001 `CoverageInventory` (schemaVersion 1) and the exact MT002 seams — `createIsolationFixture(domain, options?)`, `registerIsolationDomain(domain, adapter)`, `runIsolationScenario(domain, scenarioId)`, `registeredIsolationDomains()`, `ISOLATION_DOMAINS` — with no parallel substitute signatures:

1. **Isolation resolution (`resolveHarnessIsolation`)** resolves every URL up front through the shared enterprise validators: `ENTERPRISE_TEST_SETUP_DATABASE_URL`/`TEST_DATABASE_URL` must name a loopback `openbot_enterprise_*` database and all three `ENTERPRISE_TEST_*_DATABASE_URL` restricted-role logins must exist and point at the same instance/database. `DATABASE_URL` is never consulted; a development database name, a non-loopback host, or a missing/mispointed role URL is an explicit failure before any socket opens. The resolved config pins the dedicated loopback HTTP port 45435, the external namespace `issue6_mt131_<run-id>`, and the task-specific temp dir `${TMPDIR}/openbot-mt131-harness/<run-id>`.
2. **Loopback port ownership (`startHarnessHttpStatus`)** binds `127.0.0.1:45435` exclusively and serves a JSON status endpoint (`{harness, runId, httpPort}`). A second exclusive bind while held fails with `HARNESS_PORT_UNAVAILABLE`; closing releases the port.
3. **Self-proof before evidence (`runPositiveControl`)** — the harness owns the `full-coverage` isolation domain and, through the real scenario registry, runs four controls before any entrance evidence is evaluated: (a) the **seeded unauthorized observation** `harness.poison.unauthorized-success` — `{positiveControlPassed: true, denied: false, leakedRecords: [seed]}` — which the harness's own detector (`evaluateObservationSide`) must classify as **fail on both sides** (detected); (b) a clean observation that must pass both sides; (c)/(d) **real environment checks through the real MT002 fixture**: `createIsolationFixture("full-coverage")` provisions the Spec §11 matrix on the dedicated database, a legitimate team read must return 200 (positive control) and an A2-member cross-team read of team A1's resource must be denied (401/403/404) with no leaked record. Any failure aborts with `HARNESS_SELF_CHECK_FAILED` and **no evidence is collected**; a foreign adapter squatting on `full-coverage` is refused with `HARNESS_CONTROL_DOMAIN_OCCUPIED` via an identity probe.
4. **Per-entrance coverage evaluation** over the current inventory: only enumerated `entrances` are route surfaces; an entrance is `covered` only when both its positive and denial evidence pass (`positiveControlPassed` + no leaks + no forbidden effects, resp. `denied` + no leaks + no forbidden effects). A side absent from the evidence plan is `missing`; an unregistered domain, absent scenario, adapter failure, or skip-shaped observation is `scenario-error`; an absent provider credential (`requiresConfig`) is `environment-gap`; all leave the entrance **`uncovered` — never a synthetic pass**. A newly added inventory entrance (drift) appears as uncovered automatically. Evidence plans name exact entrance ids; an id absent from the current inventory is refused (`HARNESS_EVIDENCE_PLAN_ENTRANCE_UNKNOWN`) so stale plans cannot quietly pass.
5. **Service surfaces stay honest**: every `serviceSurfaces` entry is reported with `countsAsRouteCoverage: false` and `status: "uncovered"` (reason `route-enumeration:not_enumerated` / `assembly:unassembled`); `summary.serviceSurfacesCountingAsRouteCoverage` is structurally `0`. MT001's additive `serviceSurfaces` never inflate route coverage.
6. **Machine-readable report** (schema below) with `overall: "acceptance-passed"` only when every enumerated entrance is covered and no environment gaps exist.

## 3. Acceptance criteria mapping (Issue #174)

| Criterion | Evidence |
| --- | --- |
| 独立端口、PostgreSQL 数据库与外部命名空间不污染开发环境 | `resolveHarnessIsolation` refuses missing env / dev `DATABASE_URL` fallback / dev db name / non-loopback / missing or mispointed role URLs (test 1); isolation config pins port 45435 + `issue6_mt131_<run-id>` namespace + task temp dir (test 2); port double-bind refused (test 3); the run report records `databaseName: openbot_enterprise_mt131_test`, host 127.0.0.1, port 55434 — no development URL exists anywhere in the path. |
| harness 通过检出故意注入的未授权结果自证，之后才允许产出证据 | Seeded poison `harness.poison.unauthorized-success` detected on both sides in every run (`positiveControl.seedPoison.detected: true`, tests 4/8); injected broken detector aborts with `HARNESS_SELF_CHECK_FAILED` and the evidence adapter is provably never invoked (test 7); a poisoned business-side denial observation surfaces as `fail` + `leaked-records:1` and the entrance stays uncovered (test 8). |
| 缺少测试环境显式失败，skipped 不是 pass | `runAcceptanceHarness({environment: {}})` rejects `HARNESS_ENVIRONMENT_FAILED` (test 5); CLI with empty env exits 1 with `HARNESS_RUN_FAILED` naming the missing variable (test 14). No skip flag exists; registry skip-shaped observations are refused by MT002 semantics. |
| 为其他 agent 提供调用方式与机器可读输出 | This document §4/§5; JSON report schema + example below; stable exit-code contract (0 = honest run, 1 = harness failure); `--evidence` plan format for business tickets. |

Out of scope by design: the identity-matrix business cases (MT132+) — the harness provides the seam they will plug into; no business evidence plan exists yet, so an honest bare run reports 0/539 covered.

## 4. Setup, invocation, cleanup

### Setup (exact)

```sh
# Dedicated ephemeral PostgreSQL (already running for this task):
#   container openbot-i6-mt131-test-pg on 127.0.0.1:55434,
#   database openbot_enterprise_mt131_test, prepared only with the test
#   schema + restricted ent_mt131 roles via `enterprise-test-db.ts migrate`.
set +x
source /tmp/mt131-env.sh   # sets TEST_DATABASE_URL, ENTERPRISE_TEST_SETUP_DATABASE_URL,
                           # and the three restricted ENTERPRISE_TEST_*_DATABASE_URL.
                           # Task-private generated passwords: never print or copy.
```

### Invocation (exact, from the repository root)

```sh
bun test server/tests/multitenancy/acceptance-harness.test.ts          # the ticket's suite

bun server/scripts/multitenancy/acceptance-harness.ts [--pretty] \
     [--out <report.json>] [--evidence <plan.json>] [--run-id <id>]    # the harness CLI
```

Exit codes: **0** = the harness ran honestly and the report is trustworthy — read `overall` for the acceptance verdict (`acceptance-passed` requires every enumerated entrance covered and zero environment gaps); **1** = the harness could not run or could not trust itself (`HARNESS_RUN_FAILED:…` on stderr: missing environment, unavailable port, occupied control domain, failed self-check, invalid/unreadable evidence plan). Uncovered entrances do **not** fail the run — they are honestly reported for acceptance gating.

Business tickets supply evidence via `--evidence plan.json` plus adapters registered beside their own tests through `registerIsolationDomain` (see `EvidencePlan` in the module). Plan shape:

```json
{
  "GET /api/agents": {
    "positive": { "domain": "bots", "scenarioId": "list-positive" },
    "denial":   { "domain": "bots", "scenarioId": "list-cross-tenant-denied",
                  "requiresConfig": ["EXAMPLE_PROVIDER_TOKEN"] }
  }
}
```

### Cleanup

The harness provisions nothing persistent: the `full-coverage` control fixture is disposed after every run (rows deleted by id prefix, connections closed), port 45435 is released on exit, and the report/temp dir `${TMPDIR}/openbot-mt131-harness/<run-id>` holds no secrets and can be removed at any time. `/tmp/mt131-env.sh` stays until independent review finishes, then is deleted (task policy). The dedicated container is task-ephemeral and holds no persistent volume.

## 5. Machine-readable output (schema v1)

Report top-level fields: `schemaVersion` (1), `harness` ("mt131-acceptance"), `generatedAt`, `runId`, `isolation` (database/host/port/role names, httpPort, externalNamespace, tempDir, loopbackOnly — **never URLs or credentials**), `inventory` (schemaVersion, digest, generatedAt, stage statuses, entrance counts by kind), `positiveControl` (`status`, per-check results, `seedPoison`), `entrances[]` (id/method/path/kind/type/businessClosure/ownerTicket + `positive`/`denial` side objects `{status: pass|fail|missing|scenario-error|environment-gap, domain?, scenarioId?, reasons[]}` + `status: covered|uncovered`), `serviceSurfaces[]` (`countsAsRouteCoverage: false`), `environmentGaps[]`, `summary`, `overall`.

Example (abridged; from the verification run with `--run-id demo0001`):

```json
{
  "schemaVersion": 1,
  "harness": "mt131-acceptance",
  "runId": "demo0001",
  "isolation": { "databaseName": "openbot_enterprise_mt131_test", "databaseHost": "127.0.0.1",
                 "databasePort": 55434, "httpPort": 45435,
                 "externalNamespace": "issue6_mt131_demo0001", "loopbackOnly": true },
  "inventory": { "digest": "2f5093ef…26e93", "totalEntrances": 539, "routeEntrances": 484,
                 "catchallEntrances": 53, "serveUpgradeEntrances": 2 },
  "positiveControl": { "status": "passed",
    "checks": [ { "id": "poison-unauthorized-success", "actual": "detected", "status": "pass" }, … ],
    "seedPoison": { "scenarioId": "harness.poison.unauthorized-success", "detected": true,
                    "reasons": ["leaked-records:1", "denied:false"] } },
  "entrances": [ { "id": "ALL /*", "kind": "catchall",
      "positive": { "status": "missing" }, "denial": { "status": "missing" },
      "status": "uncovered" }, … ],
  "serviceSurfaces": [ { "id": "agent-computer", "assemblyStatus": "unassembled",
      "routeEnumeration": "not_enumerated", "status": "uncovered",
      "countsAsRouteCoverage": false } ],
  "environmentGaps": [],
  "summary": { "totalEntrances": 539, "coveredEntrances": 0, "uncoveredEntrances": 539, …,
               "serviceSurfacesCountingAsRouteCoverage": 0 },
  "overall": "acceptance-not-passed"
}
```

Digest provenance: with the dedicated environment fully sourced, both MT001 DB stages run and the consumed inventory digest is `2f5093ef127a5fd463c00a370fe67d4bfadec48f2ba9356aa1fe83abfb326e93`; the recorded MT001 package digest `0965ecfa…30c9` corresponds to both DB stages skipped (no env). The report's `inventory.stages` records which stages ran for the digest it carries.

## 6. Verification

Exact commands and captured outputs live in `checkpoints/MT131/verification-output.txt`:

```
set +x; source /tmp/mt131-env.sh
bun test server/tests/multitenancy/acceptance-harness.test.ts   # 14 pass, 0 fail, 1713 expect()
bun test server/tests/multitenancy/                            # 64 pass, 0 fail (all 3 suites)
cd server && bun run typecheck                                 # exit 0
bunx biome check server/scripts/multitenancy/ server/tests/multitenancy/  # exit 0
bun server/scripts/multitenancy/acceptance-harness.ts --out … --run-id demo0001  # exit 0
```

TDD: the test file was written first and watched failing (module-missing RED), then implementation until GREEN; a later regression introduced during lint cleanup (flag-value consumption) was caught by the CLI test and fixed — evidence the suite protects behavior. No test is conditionally skipped; without the environment the suite fails loudly.

## 7. Limitations

- The harness consumes the inventory as built at run time; entrance-level evidence quality is bounded by the adapters business tickets register — the harness guarantees no synthetic pass, not that future adapters are semantically perfect.
- `environment-gap` records absence of a *declared* provider credential; it cannot discover undeclared external dependencies (those surface via MT001 `externalDependencies`).
- The harness binds exactly one port (45435) and one database; parallel harness runs on one machine must serialize (the port is exclusive by design).
- No live third-party provider is ever called; provider-dependent evidence is only an environment gap until credentials exist.
- The `evaluator` option is a self-verification seam; production invocations must omit it (documented in the module).
