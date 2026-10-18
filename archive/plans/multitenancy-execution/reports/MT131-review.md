# MT131 独立审阅 — 验收 harness 与独立测试环境（Issue #174 / Task task_ec3b94bcc847）

- Reviewer: independent Pi reviewer (Orca child worktree `i6-review-mt131`, branch `1123786563/i6-review-mt131`, HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` — identical to MT131's execution base; no commits made).
- Scope reviewed: the frozen uncommitted snapshot only — `server/scripts/multitenancy/acceptance-harness.ts`, `server/tests/multitenancy/acceptance-harness.test.ts`, `reports/MT131-harness.md`, `checkpoints/MT131/**` (present at `checkpoints/` root in this snapshot), `review-packages/MT131.json` — against the approved Spec (`docs/specs/2026-10-14-company-team-multitenancy-design.md`), Issue #174 acceptance, the MT001 inventory contract (`reports/MT001.md` + MT001-fix round), and the MT002 isolation seams (`reports/MT002.md`).
- No production or test source files were modified; nothing was committed. This file and `checkpoints/MT131-review/` are the only artifacts written.

## Verdicts

| Verdict | Result |
| --- | --- |
| **Spec compliance (Issue #174 + approved Spec + MT001/MT002 contracts)** | **PASS** |
| **Code quality** | **PASS** |

Both PASSes carry findings below (2 Medium, 1 Low, 4 Info). None of them falsifies an acceptance criterion, manufactures a pass, or weakens an isolation guarantee; each is documented with evidence and acceptance impact.

## Snapshot integrity (hashes re-verified by this reviewer)

Owned files in this snapshot are byte-identical to `review-packages/MT131.json` and to the source worktree `i6-mt131`:

| File | SHA-256 |
| --- | --- |
| `server/scripts/multitenancy/acceptance-harness.ts` | `2b29aeb63be347883a997de765da75676e883b7219b8d09a5184ae75c3fa1390` |
| `server/tests/multitenancy/acceptance-harness.test.ts` | `df6f6f31dfa0e9b61e32ca55fee2f715917ab891281aec969b6d37eb8fd92a12` |
| `reports/MT131-harness.md` | `0d174527373663c514058cf562cb09428bc3e6efb1319710067b7794ee8554f7` |
| `checkpoints/MT131/before.json` (at `checkpoints/before.json` here) | `21b4a9f26df4e310a1b08cd8decd4b40dfbdc903f8c670ba3dced17104289701` |
| `checkpoints/MT131/after.json` (at `checkpoints/after.json` here) | `f57d3b616e9466e0c9872632416943c0d3aa0702995ed8d80dc07795f1a3a0b9` |
| `checkpoints/MT131/after-manifest-sha256.txt` / `verification-output.txt` | `ba702b99…3198` / `3e5f16f0…e80f` (content-identical; relocated) |

Prerequisite files in the source worktree (`inventory.ts` `e58bde59…`, `inventory.test.ts` `c718e8f9…`, `support/fixture.ts` `f1112f0f…`, `support/scenarios.ts` `cdca14ca…`, `fixtures.test.ts` `667dd64e…`, `server/tests/support/enterprise-database.ts` `d9e65279…`) all match MT131's `before.json` exactly — the frozen prerequisites are unchanged. Note (assembly artifact, not an MT131 defect): this review worktree contains only the MT131-owned subset; the MT001/MT002 prerequisite sources are absent here, and the MT131 checkpoint files sit at `checkpoints/` root instead of `checkpoints/MT131/` as listed in `MT131.json`. Executable verification therefore ran in the source worktree `i6-mt131` against hash-verified byte-identical files (environment available: `/tmp/mt131-env.sh` present, container `openbot-i6-mt131-test-pg` live on 127.0.0.1:55434). No environment capability was missing.

## Verification performed by this reviewer (all in `i6-mt131`, dedicated env sourced)

| Command | Result |
| --- | --- |
| `set +x; source /tmp/mt131-env.sh && bun test server/tests/multitenancy/acceptance-harness.test.ts` | **14 pass / 0 fail, 1713 expect()** — reproduces the worker's capture exactly |
| `set +x; source /tmp/mt131-env.sh && bun test server/tests/multitenancy/` | **64 pass / 0 fail, 6947 expect()** (all 3 suites; MT001/MT002 unaffected) |
| `cd server && bun run typecheck` | **exit 0** |
| `bunx biome check server/scripts/multitenancy/acceptance-harness.ts server/tests/multitenancy/acceptance-harness.test.ts` | **exit 0** |
| `bun server/scripts/multitenancy/acceptance-harness.ts --out /tmp/mt131-review-report.json --run-id reviewmt131` | **exit 0**; `overall: acceptance-not-passed`; self-check passed; seedPoison detected; covered 0/539; serviceSurfacesCountingAsRouteCoverage 0; digest `2f5093ef…26e93` (identical to documented) |
| CLI with empty environment (`env -i … bun … acceptance-harness.ts`) | **exit 1**, `HARNESS_RUN_FAILED:HARNESS_ENVIRONMENT_FAILED:ENTERPRISE_TEST_SETUP_DATABASE_URL or TEST_DATABASE_URL is required for enterprise tests.` |
| Two consecutive CLI runs (`--run-id deta` / `--run-id detb`) | exit 0 both; **entrance result vectors identical across 539 entrances; inventory digest identical**; only `runId`/`generatedAt` differ |
| Invalid run id `--run-id detC` | exit 1 `HARNESS_RUN_FAILED:…:HARNESS_RUN_ID_INVALID:detC` (charset guard works) |
| Port release after CLI exit | `curl http://127.0.0.1:45435/` fails after process exit — released |
| DB residue after CLI + suites | `enterprise_tenants|users|principals` with `mt002-%` = **0 rows** (prefix-scoped cleanup confirmed) |
| Repeated in-process run experiment (twice without registry reset) | leaked 2 tenant rows (run 2's fixture) — Finding 3; reviewer cleaned the leaked rows afterwards, re-verified 0 residue |
| Secret scan of the produced report (full JSON walk) | no URLs / credentials / passwords; the only `password`/`secret` substring hits are MT001 inventory route paths (e.g. `ALL /api/passwords/*`) |
| Test-file scan | 14 `test(`; zero `.skip` / `.todo` / `test.if` / conditional skips |

## Acceptance criteria mapping (Issue #174)

| Criterion | Reviewer assessment |
| --- | --- |
| 独立端口、测试数据库与外部命名空间，不污染开发环境 | **Met.** `resolveHarnessIsolation` resolves every URL through the shared MT002-lineage validators (`enterpriseTestDatabaseUrlFrom` + `enterpriseRuntimeDatabaseUrlFrom` for all three restricted roles): loopback-only, `openbot_enterprise_*` name, role URLs must match the setup instance/database; `DATABASE_URL` is never read anywhere in the harness or validators (verified by grep + tests + empty-env CLI). Port 45435 is bound exclusively on `127.0.0.1` (double-bind → `HARNESS_PORT_UNAVAILABLE`, verified); namespace `issue6_mt131_<run-id>` and `${TMPDIR}/openbot-mt131-harness/<run-id>` pinned in config/report (see Finding 7 for the enforcement caveat). Live run recorded `openbot_enterprise_mt131_test` @ 127.0.0.1:55434. |
| harness 先检出人为植入的越权，再产出证据 | **Met.** `runPositiveControl` runs before `collectEntranceCoverage` and throws `HARNESS_SELF_CHECK_FAILED` on any failed check — poison-detected-both-sides, clean-passes-both-sides, real `createIsolationFixture("full-coverage")` positive (a1-member read 200) and denial (a2-member cross-team read denied, no leak). Test 7 proves the evidence adapter is **never invoked** (`evidenceRuns === 0`) when the detector is broken; foreign squatters on the control domain are refused (`HARNESS_CONTROL_DOMAIN_OCCUPIED`). Live CLI run: `seedPoison.detected: true`. |
| 缺少测试环境显式失败，skipped 不是 pass | **Met.** Missing env → `HARNESS_ENVIRONMENT_FAILED` (unit + CLI reproduced, exit 1). No skip status exists in `SideStatus`; MT002's registry refuses skip-shaped observations; `environment-gap` keeps the entrance `uncovered`; `overall: acceptance-passed` requires every enumerated entrance covered **and** zero environment gaps. Inventory DB stages that did not run are recorded as `skipped` in `inventory.stages` with reasons — visible, never a pass. |
| 运行方式与输出格式文档化、可被其他 agent 直接使用 | **Met with one defect (Finding 1).** Module header + MT131-harness.md §4/§5 document invocation, exit codes (0 = honest run, 1 = harness failure), evidence-plan shape, and the full schema-v1 report. `--out` delivers a clean, valid, single-JSON document (verified). The default stdout mode carries a stray init-time log line before the report (Finding 1). |

Spec-level mapping: the harness is the A11 seam (per-entrance positive + denial evidence required for unified opening; drift entrance → uncovered; stale plan ids refused), with A1/A2/A6-style controls exercised through the real MT002 fixture (cross-team denial, restricted roles, no default fallback). Scope boundary respected: no identity-matrix business cases (out of scope per ticket; a bare run honestly reports 0/539).

## Contract-consumption checks

- **MT001 inventory contract**: consumed as-is — `schemaVersion`, `digest`, `entrances[]` (id/method/path/kind/type/businessClosure/ownerTicket), `serviceSurfaces[]`, `stages[]` all read from the real `buildInventory({ environment })`; no parallel substitute shapes. Counts derived from the inventory match (484 route / 53 catchall / 2 serve-upgrade / 539 total). Drift test adds a route via `mutateApp` and proves the new entrance lands `uncovered`; an evidence plan naming an absent entrance is refused (`HARNESS_EVIDENCE_PLAN_ENTRANCE_UNKNOWN`), so stale plans cannot quietly pass.
- **MT002 seams, exact**: `createIsolationFixture(domain, { environment })` (exact additive signature), `registerIsolationDomain(domain, adapter)`, `runIsolationScenario(domain, scenarioId)`, `registeredIsolationDomains()`, `ISOLATION_DOMAINS` — all imported from the real support modules (hashes match MT002's frozen manifest); `"full-coverage"`, `"bots"`, `"conversations"` all exist in the domain union; `RESTRICTED_ROLES` is a pre-existing fixture.ts export. No mock replaces any seam; the only test seams (`inventory`, `evaluator`, `now`) are explicitly documented as self-verification-only.
- **Route vs service surfaces**: every `serviceSurfaces` entry is emitted with `countsAsRouteCoverage: false` and `status: "uncovered"`; `summary.serviceSurfacesCountingAsRouteCoverage` is structurally `0`. Verified in the live report (4 surfaces, all false/uncovered).

## Findings

### F1 (Medium) — Default stdout mode is not a single JSON document

**Evidence.** `bun … acceptance-harness.ts --run-id deta > file` (exit 0) produces stdout of exactly 2 lines: line 1 is a 243-byte pino init log (`{"level":30,…,"type":"openmuse-mail-placeholder-action-ids",…}`), line 2 is the report JSON. The same line also precedes the failure message in the empty-env run (stdout file = 243 bytes). `withCleanStdout` patches `process.stdout.write` only for the duration of `runAcceptanceHarness`, but the app-assembly module tree statically imported via `inventory.ts` emits this line during module initialization, before `main()` and before any patch; `JSON.parse(stdout)` therefore fails ("Extra data").

**Impact on acceptance.** Criterion 4 (“可被其他 agent 直接使用”) is degraded for the default mode documented in the module header ("CLI … JSON→stdout"): an agent piping stdout per that contract must strip the prefix line or use `--out`. The documented primary path (`--out`, schema §5) is unaffected. Not a coverage/isolation defect — output *content* remains deterministic and honest (see determinism check).

### F2 (Medium) — MT131-harness.md §5 digest provenance misstates which MT001 stages ran

**Evidence.** The report claims “with the dedicated environment fully sourced, **both MT001 DB stages run** and the consumed inventory digest is `2f5093ef…26e93`”. This reviewer reproduced digest `2f5093ef127a5fd463c00a370fe67d4bfadec48f2ba9356aa1fe83abfb326e93` with exactly the documented env, and the report's own `inventory.stages` records `live-table-crosscheck: ok` but `enterprise-capability-assembly: skipped` (it requires `ENTERPRISE_DIRECTORY_DATABASE_URL + ENTERPRISE_DATA_DATABASE_URL + TENANT_STORAGE_RUNTIME_DATABASE_URL`, none of which `/tmp/mt131-env.sh` sets per `after.json`'s variable list). Since the digest hashes the full inventory **including `stages`**, the documented digest cannot correspond to a both-stages-ok run; the prose and the digest are mutually inconsistent.

**Impact on acceptance.** Documentation accuracy only (criterion 4): the machine-readable output is truthful (`stages` records what ran; a skipped stage never fabricates coverage — all 539 entrances remain uncovered regardless). Risk: a downstream agent believing both DB stages ran may skip provisioning the production-shaped variables needed to actually exercise `enterprise-capability-assembly`. The operative sentence in the same section (“The report's `inventory.stages` records which stages ran for the digest it carries”) is correct.

### F3 (Low) — Repeated in-process runs leak one fixture's rows and connections

**Evidence.** `runPositiveControl` reuses a still-registered previous-run adapter for `full-coverage` (`registeredIsolationDomains().includes(...)` short-circuits re-registration), whose `fixturePromise` was reset by the previous run's `dispose()`; the current run's fresh `control.dispose()` then disposes nothing (its own promise is `undefined`), and the fixture recreated by the *previous* adapter is never disposed. Empirically: two `runAcceptanceHarness` calls in one process → 2 leaked `mt002-full-coverage-%` tenant rows (plus children and 4 pooled connections). The CLI (one run per process) is unaffected — verified 0 residue after CLI and suite runs; the test suite resets the registry in `beforeEach`, also unaffected. Reviewer reproduced, then cleaned the leaked rows and re-verified 0 residue.

**Impact on acceptance.** None for the documented single-run contract; a cleanup flaw of the exported library API when called repeatedly in one process (plausible for agents grading multiple evidence plans in-process). Recommend: unregister/replace the control-domain adapter per run (or dispose via the adapter that actually holds the fixture).

### F4 (Info) — Value-less valued flags degrade silently

`parseFlags` consumes the next argv token for `--out/--evidence/--run-id`; a missing trailing value (or a following flag, e.g. `--out --pretty`) sets `undefined` and the run silently proceeds in stdout mode / without a plan / with a random run id (or writes the report to a file literally named `--pretty`) instead of failing loudly.

### F5 (Info) — `scenario-error` reasons lose the underlying cause

`runIsolationScenario` wraps adapter failures as `ISOLATION_SCENARIO_FAILED:domain:scenario` with the real error as `cause`; the harness records only the wrapper message in `reasons[]`, so the diagnostic detail (e.g. "scenario does not exist") never reaches the machine-readable report. Status semantics are unaffected (still `scenario-error` → uncovered).

### F6 (Info) — Vacuous pass on an empty inventory

`overall` becomes `acceptance-passed` when `entrances.length === 0` (0/0 covered, 0 gaps). MT001's contract currently guarantees 539 entrances from real assembly, so this is theoretical; a guard (e.g. refuse `totalEntrances === 0`) would make the A11 gate non-vacuous by construction.

### F7 (Info) — External namespace is pinned, not enforced

`issue6_mt131_<run-id>` is pinned in `HarnessIsolation` and the report, but the harness itself creates no external resources, so nothing verifies that business adapters actually name external objects within the namespace. Acceptable at this layer (nothing pollutes dev; the harness provisions nothing external), but downstream adapters are trusted on this convention.

## Checklist (review-task items → outcome)

| Item | Outcome |
| --- | --- |
| Isolation guarantees (port/DB/namespace/temp dir, loopback-only) | Verified in code, tests, and live runs ✔ |
| No `DATABASE_URL` fallback | Verified (grep, validators, unit tests 1/5, empty-env CLI exit 1) ✔ |
| Restricted roles (validated up-front, real roles in fixture) | Verified (`RESTRICTED_ROLES` × 3 validated in `resolveHarnessIsolation`; MT002 seam used for real) ✔ |
| Self-poison proof before evidence | Verified (ordering in `runAcceptanceHarness`; test 7: evidence adapter provably never invoked) ✔ |
| No skipped-as-pass | Verified (no skip status; registry refuses skip-shaped observations; gaps ≠ pass; stages visible) ✔ |
| Route/service-surface distinction | Verified (`countsAsRouteCoverage: false` structural, summary 0) ✔ |
| Deterministic machine output | Verified (identical entrance vectors + digest across runs; only runId/generatedAt vary; F1 affects the default stdout channel, not the content) ✔ |
| Exact MT002 interfaces | Verified (all five seams imported from real modules; hashes match; no substitutes) ✔ |
| Cleanup | Verified for CLI/suite paths (0 residue, port released); F3 for repeated in-process use ✔ |
| Secret leakage | Verified (report carries names/hosts/ports only; validator errors sanitize URLs; full-JSON scan clean) ✔ |
| Test evidence | Reproduced independently: 14/14 (1713 expects), 64/64, typecheck 0, biome 0, CLI exits 0/1 ✔ |

## Conclusion

MT131 delivers what Issue #174 asks: a self-proving, honestly-failing, machine-readable acceptance harness on a dedicated port/database/namespace that consumes the MT001 inventory and MT002 seams exactly, with no synthetic passes anywhere in its state space. The two Medium findings are an output-channel defect in the default stdout mode (F1) and a provenance misstatement in the report prose (F2); both are fixable without touching coverage semantics and neither justifies withholding acceptance. **Spec compliance: PASS. Code quality: PASS.** Recommended follow-ups, in order: F1 (capture init-time writes or document `--out` as the machine-readable contract), F2 (correct §5's provenance sentence), F3 (dispose the adapter that owns the fixture on repeated runs), then the Info items opportunistically.
