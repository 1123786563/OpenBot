# M03-R1B: Make estimator route view immutable for PlanModel endpoints

**Goal:** Close M03-R1A-Q01 by removing mutable URL state from the estimator-facing route view while preserving existing route dispatch and Q02 stream regressions.

**Sources:** Approved Mastra migration design §6; M03-R1A plan; independent review `.superpowers/sdd/2026-10-11-m03-r1a-route-stream-fixes/reports/review.md` SHA256 `040f5aaebda81969966625fa1e45db82de77aa7bc84be810056cf682983a8d70`; frozen M03-R1A package SHA256 `12a20d74e0e2bb9ca720627841aa23400862dea707ce095b58e397d31ba83cf4`. Workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, BASE `e15cef8ec3c3c223aaf0935a0ea81f8c5e370737`, uncommitted.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Estimator-facing route identity must contain no mutable URL/URLSearchParams or other mutable nested identity. Represent a PlanModel endpoint as an immutable canonical string in the estimator view; reconstruct `URL` only for native PlanModel construction.
- Retain separately frozen selected provider/model/PlanModel identity for capability checks, key resolution and dispatch. Estimator may not redirect any of them.
- Preserve existing M03-R1 and M03-R1A behavior, regression tests and generic failure semantics.
- No DB service startup, DB migrations, external providers/credentials, commit, stash, reset, or out-of-scope edits. The synthetic DB test remains blocked if reserved service/URLs are absent.

## Review Focus

1. A selected PlanModel endpoint is represented as a string in the estimator view and cannot be changed through URL setters or searchParams. Estimator mutation attempts leave subsequent PlanModel construction on the exact originally selected endpoint.
2. Provider/model/credential identity mutation assertions from R1A remain.
3. Existing binary stream and finish-stop tests remain green.

## Task 1: Use primitive estimator route identity and preserve selected dispatch

**Depends on:** M03-R1A failed independent review Q01. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Owned files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** RuntimeModelRoute and PlanModelConfig; estimator function contract; M03-R1A frozen checkpoint and Q01 review.

**Produces:** dedicated immutable estimator route view with PlanModel endpoint represented by string; selected route still used for capability, credential/provider/model and PlanModel dispatch; PlanModel endpoint mutation regression.

- [ ] **RED:** Add a selected PlanModel route test. Inside estimator, attempt ordinary property mutation and any available endpoint setters/searchParams mutation. Assert the estimator endpoint is a primitive string and mutation is rejected/ineffective; after estimate, assert the PlanModel factory receives the original endpoint. Demonstrate failure on current frozen-URL view before editing production code.
- [ ] **Implement:** Define an estimator-only immutable route type/view (can be a mapped type) that replaces nested URL with a primitive string. Create the view from a stable retained snapshot; keep native route separately. Recreate a fresh URL solely when passing PlanModelConfig to its factory. Ensure no mutable aliases cross the estimator boundary.
- [ ] **Verify:** Run focused model/integration/gateway suite, Biome on the two owned paths, server typecheck (classify only M17 TS2345), and the guarded synthetic DB test only if exact reserved service and all required URLs already exist. No DB service startup or substitute DB.
- [ ] **Checkpoint:** Verify the before snapshot SHA `d9391241a99a641545aa35b1f830e47e81cae40b6601c82c8e27be5cc7889812`; produce full after snapshot and before/after package, and implementation report with RED/GREEN, commands, results, limitations, and hashes.

**Acceptance / failure handling:** Closes R1A-Q01 only if the estimator-facing route contains no mutable URL state and the PlanModel regression proves endpoint identity survives attempted mutation. All prior Q01/Q02 model tests stay green.

## Interface consistency scan

| Producer / consumer | Shared boundary | Requirement |
|---|---|---|
| Runtime adapter / trusted estimator | estimator route view | Endpoint is primitive string; every nested identity field immutable. |
| retained selected route / PlanModel factory | runtime PlanModelConfig | Construct a fresh `URL` from retained endpoint only at the final construction boundary. |

| Task | Internal consistency |
|---|---|
| Task 1 | Type view, route conversion, and same-module regression share only the two owned paths; no independent task can avoid editing the same boundary. |

No cycles or uncovered acceptance items.
