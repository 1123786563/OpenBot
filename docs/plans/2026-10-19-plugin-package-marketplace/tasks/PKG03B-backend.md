# Task Brief — PKG03 Slice B (#462): Run pins + runtime Skill read

## Context

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, branch `feat/plugin-package-market-v1`, uncommitted; latest checkpoint cp06 (source SHA `49dc5cdc…e0d2`). No commit/push. Slice A (enterprise package grants: table PKG03 MT task applied, `grants.ts` service, PUT/DELETE routes, install-detail surfacing) is acceptance-reviewed PASS/PASS — read `docs/plans/2026-10-19-plugin-package-marketplace/ledger.md` first, then spec §8 (install transaction & resources), §9 (runtime & revocation semantics — THIS slice's core), §14 (A04/A05/A06).

## Goal (slice B)

A Run that uses a Bot with active package grants gets **package pins written atomically in the same run-creation transaction**; the runtime Skill read path serves **only pin-constrained, still-valid** package skills; revocation/disabling narrows what a live run can read; no client input decides the pin.

## Deliverables (priority order — if you approach your turn limit, keep the tree compiling and all existing tests green at each completed step, then report exact remaining state)

1. **MT task PKG03B step** (append to the existing `PKG03` task in `server/scripts/multitenancy/migrate-test.ts` as a new step, or a new task id if steps must stay immutable — read the journal semantics first and choose correctly): table `enterprise_run_package_pins` per spec §6: PK `(tenant_id, run_id, attempt_generation, install_id)`; columns `workspace_id`, `revision`, `release_digest` (or resource hashes per spec), `grant_revision`, `allowed_resource_ids jsonb`; compound FK `(tenant_id, run_id)` → enterprise_runs; FK `(tenant_id, workspace_id, install_id)` → installs; RLS identical shape to installs (data read arm, no writes to data role; operator insert only); applied to the test DB via the MT recipe.
2. **`prepareWithin`** in `server/src/enterprise/plugin-packages/runtime.ts`: signature per spec §9 (`prepareWithin(runWriteTx, scope, { botId, runId, attemptGeneration })`); reads the Bot's **active** package grants inside the caller's run-write transaction (RunWriteTx = the restricted run-writer channel — read `server/src/enterprise/runs/store.ts` createRunInTransaction to see which tx handle it passes and whether a package read via the data channel is reachable inside it; if the run tx handle cannot read grant tables under RLS, design the minimal compliant bridge: e.g. read grants via the data channel BEFORE the run tx and pass a snapshot in, with the tx writing pin rows from that snapshot — document the choice and its TOCTOU window vs spec, and prefer spec §9's "same transaction" if achievable); writes one pin row per install with: install's current revision+digest, grant revision, allowed skill resource ids; retries with the same (runId, attemptGeneration) return the same pin (idempotent upsert); refuses if install disabled/uninstalled or grant revoked mid-flight (revocation narrows: allowed = current active grants ∩ existing pin resources).
3. **Runtime Skill read**: extend the package runtime so `grantedSkills`-shaped skill summaries for enterprise package skills are served ONLY from pins: given (runId, attemptGeneration, botId), read the pin, verify install enabled + revision still current + grant still active (re-read at read time per spec "后续调用仍重验"), and return skill summaries parsed from the immutable artifact of that revision (use slice A/PKG01 `loadArtifact` + resource links; titles/summaries from the manifest). Revoked/disabled/withdrawn → that skill disappears from the served set (A05/A06 narrowing).
4. **Entry wiring (chat path only)**: at the point where enterprise runs are created (`server/src/enterprise/runs/service.ts` `start` — the production runner composition in `index.ts`), invoke `prepareWithin` so enterprise runs with package-granted Bots get pins; and at `server/src/index.ts` `loadSkills`/skill loading for enterprise runs, serve package skills through the pinned read. Legacy (non-enterprise) paths remain untouched. The other entrypoints (approvals resume, schedules, memory ingestion) are LATER tickets' wiring — leave them untouched but add a one-line code comment map in `runtime.ts` listing the unwired entries (support matrix seed).
5. **Tests** (driven real roles, `server/tests/multitenancy/package-runtime.test.ts`, new explicit group `server/tests/multitenancy pkg03b` registered like pkg03; plus native additions where pure):
   - pin rows are written atomically: a worker simulating the runner CANNOT observe a ready run without pins (adapt PKG02's concurrency pattern);
   - retry same attempt → same pin (no duplicate rows);
   - disable install after pin → runtime read returns empty for that package; re-enable → returns again;
   - revoke grant after pin → that skill disappears from runtime read (A05 narrowing), while other grants on the same install remain;
   - upgrade simulation (new revision row via slice A revision writer if present, else direct row) → old run keeps old revision pin, runtime read still serves old-revision content and refuses to serve new-revision skills not in the pin (A06);
   - cross-tenant run read refused (RLS).
   Keep each test independent; no 10-minute deadlock patterns (learnings in ledger).

## Constraints

- No new npm deps; no production migration; expand-only DDL.
- `enterprise_run_package_pins` writes go through the run writer channel authorization (verify which role the run writer uses in tests — mirror `package-storage.test.ts`).
- Never serve connector tools in this slice; never read the global skills slug table for package skills; client input never picks the pin.
- Typecheck: only the 3 pre-existing bootstrap errors; Biome clean; targeted `bun test` for RED/GREEN, official evidence via `E2E_BUN_ONLY="server/tests/multitenancy pkg03b" E2E_UNIT_OUTPUT=.e2e/pkg03b-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` (also re-run the pkg03 group to prove no regression).

## Report

Files, MT task/step choice + journal evidence, the RunWriteTx bridge decision and its TOCTOU analysis, test counts, typecheck/biome, deviations, remaining state if capped. ≤450 words. No commit.
