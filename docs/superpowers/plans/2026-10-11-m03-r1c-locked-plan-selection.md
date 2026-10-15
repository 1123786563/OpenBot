# M03-R1C: Enforce route-locked PlanModel selection

**Goal:** Close M03-R1B-Q01 by making explicit PlanModel selection come only from persisted RuntimeModelRoute; retain R1A/R1B estimator immutability and stream regressions.

**Sources:** Approved Mastra migration design §6; M03-R1 Global Constraints; M03-R1B independent review `.superpowers/sdd/2026-10-11-m03-r1b-plan-url-freeze/reports/review.md` SHA256 `b9daa8cc1b15dc987fd3adf6ef22082504f21707fbc3cbf2913521406ec7f823`; frozen M03-R1B package SHA256 `e0d5fe9c326f3655a6ecc8bb8848b2006fa05c40e4bd0a1f1aca3c154c9ab657`. Workspace `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, BASE `e15cef8ec3c3c223aaf0935a0ea81f8c5e370737`, uncommitted.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Explicit PlanModel choice, provider, token and endpoint come only from the retained immutable locked route. An adapter/runtime result cannot add PlanModel to a native route or replace selected plan identity.
- Preserve native OpenAI/Anthropic dispatch, one-use budget capability, key resolution order, error redaction, immutable estimator view with endpoint string, and all R1A stream tests.
- No DB service startup, migrations, provider calls/credentials, commit/stash/reset, or out-of-scope edits. Preserve M02/user work.

## Review Focus

1. A runtime adapter cannot switch selected native route to PlanModel. Assert PlanModel factory and PlanModel credential resolution are never called; native route remains unchanged or mismatch fails closed.
2. A selected PlanModel route continues to use its locked provider/token/endpoint and passes tools and abort signal.
3. Estimator view remains immutable including primitive endpoint; binary stream and finish-stop tests remain.

## Task 1: Lock PlanModel construction to persisted route

**Depends on:** M03-R1B failed independent review Q01. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Owned files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** retained immutable selected `RuntimeModelRoute`; immutable estimator view; PlanModel factory and credential resolution contract; R1B review.

**Produces:** route-bound PlanModel branch; explicit PlanModel route tool/abort regression; negative adapter-injected plan switch regression.

- [ ] **RED:** Add a test with a selected native route and an adapter runtime result attempting to inject a PlanModel; assert no PlanModel credential or factory call and selected native model remains selected (or generic fail-closed route mismatch). Change the existing desktop PlanModel tool/abort test to provide explicit PlanModel in the selected route and assert the locked plan configuration is used. Demonstrate red against current code.
- [ ] **Implement:** Choose branch solely from retained selected route plan. Never use runtime.plan as an alternate selector or endpoint/provider/token. If adapter runtime plan identity mismatches selected route, fail closed. Preserve fresh URL creation from retained endpoint string only at native PlanModel factory boundary.
- [ ] **Verify:** Run focused model/integration/gateway suite, owned Biome, server typecheck with only assigned M17 diagnostic classified; guarded database only if exact service and all reserved URLs already exist. No database startup.
- [ ] **Checkpoint:** Verify before snapshot SHA `d7541ad36935eff87036aa9aed76c7c916e57ed47dc8657e97ef5f9689c46cf2`; freeze after snapshot and full two-path increment; report TDD and verification evidence.

**Acceptance / failure handling:** closes R1B-Q01 only if runtime cannot alter PlanModel explicit selection or its provider/token/endpoint, and the positive PlanModel path still forwards tools and abort signals.

## Interface consistency scan

| Producer / consumer | Boundary | Requirement |
|---|---|---|
| persisted model route / governed adapter | explicit plan selection | Route alone chooses native vs PlanModel. |
| runtime adapter / PlanModel factory | route payload | Runtime response must match selection; construction uses selected provider, token and URL. |

| Task | Internal consistency |
|---|---|
| Task 1 | Selection logic and both positive/negative tests share the same governed model boundary. |

No cycles or acceptance gaps.
