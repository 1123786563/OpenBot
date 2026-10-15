# M03-R1A: Freeze governed model routing and complete stream regressions

**Goal:** Close the two blocking findings from M03-R1 repair review while preserving the five repaired M03 behaviors.

**Source:** Approved Mastra migration design §6; original repair plan `docs/superpowers/plans/2026-10-11-m03-r1-model-governance-fixes.md`; repair review `.superpowers/sdd/2026-10-11-m03-r1-model-governance-fixes/reports/review.md` SHA256 `94fb92c12dbca64695e4dc7ea53b1202f461cb22ca9e8e92e86a222ad0844d08`; exact repair before checkpoint package SHA256 `00f2db99f4a528f35ec52b8fb1726e34a47db2b48ac116deb117479b6d0741aa`. Worktree `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, BASE `e15cef8ec3c3c223aaf0935a0ea81f8c5e370737`; changes remain uncommitted.

## Global Constraints

- Only edit `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Preserve existing route-selected provider/model/plan and the mandatory fail-closed estimator. Snapshot route identity before invoking injected estimator; estimator receives an isolated immutable copy and later capability, key resolution, and model construction use the untouched frozen snapshot.
- No credentials, external provider calls, migrations, DB services, commit, stash, reset, or modifications to other existing M02/user changes.
- Do not use bytes/characters as token estimate; preserve generic safe errors and unknown-usage reservation.
- DB cumulative-ceiling test remains unavailable due missing reserved DB service/role URLs; report this as environmental block, never as pass.

## Review Focus

1. An estimator that attempts to mutate provider, default model, and PlanModel cannot change downstream routing or credential provider; the regression proves dispatch uses the original selected route.
2. A binary stream file/data part retains exact bytes after redaction.
3. A consumer that reads through `finish` and immediately stops observes successful usage confirmation before finish is exposed; preserve failed-settlement behavior.
4. Existing focused model/gateway suite, Biome, and typecheck results remain valid for the exact final snapshot.

## Task 1: Immutable estimator input and stream-specific acceptance tests

**Depends on:** M03-R1 failed gate and its M03-R1A repair review; no independent execution dependency. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Owned files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts` only.

**Consumes:** the frozen route returned by RuntimeModelAdapter, required estimator contract, existing ModelInvocationContext and one-use capability API, review findings Q01/Q02.

**Produces:** an immutable selected-route snapshot for all post-estimation actions, with an isolated immutable estimator argument; a mutation-resistant route test; stream binary fidelity and finish-read-stop ordering tests.

- [ ] **RED:** Add tests first. The estimator attempts nested mutation of provider, defaultModel, and plan; then assert the selected route is still the only route used for capability, provider credential resolution and model creation (or fail closed before secret resolution). Add a custom native model stream yielding a typed binary file part and assert exact bytes. Add a stream test which reads until `finish`, immediately stops consuming, and asserts usage confirmation already completed before `finish` became visible. Capture expected red failures on the current checkpoint.
- [ ] **Implement:** Deep-copy and freeze only the route identity values needed by the contract, pass an isolated immutable route into the estimator, and retain the original immutable snapshot for all subsequent capability checks/provider-plan/key/model dispatch. Avoid freezing shared adapter/database objects. Keep unrelated call options untouched.
- [ ] **Verify:** Run `cd server && bun --no-env-file test tests/enterprise/mastra-model.test.ts tests/enterprise/mastra-model.integration.test.ts tests/enterprise/model-gateway.test.ts`; targeted Biome for both owned files; `cd server && bun run typecheck`. Run the guarded DB integration only if all four pre-existing reserved URLs and the exact synthetic DB identity are available; do not start or recreate a DB service. Record the known M17 diagnostic separately.
- [ ] **Checkpoint:** Verify exact before hashes from `.superpowers/sdd/2026-10-11-m03-r1a-route-stream-fixes/snapshots/before.json` SHA256 `c9eba6e27efa4ec54e2063c3351ca727c573ed101b7b835ca8b636e8e83eb2ea`; produce complete after snapshot and before/after package for both owned paths. Record TDD, commands, results and limitations in `reports/implementation.md`. Independent validation and code review must inspect that same frozen increment; no gate is inferred from another.

**Acceptance / failure handling:** closes M03-R1-Q01 and Q02 with meaningful behavior evidence. Any route identity that can still be changed after estimate, missing stream case, source scope drift, or non-environmental regression fails the task and returns to implementation with a scoped repair.

## Interface consistency scan

| Producer / consumer | Shared interface | Finding |
|---|---|---|
| `createGovernedMastraModel` / estimator | `RuntimeModelRoute` | Provide immutable copied route; downstream decisions use the same immutable selected identity. |
| governed stream / AI SDK consumer | finish and typed file parts | Confirm settlement before finish; preserve binary values through redaction. |

| Task | Internal consistency |
|---|---|
| Task 1 | Both source and regression tests are one tightly coupled boundary; no separate task can execute without editing shared paths or weakening exact route assertions. |

No dependency cycles or uncovered review findings.
