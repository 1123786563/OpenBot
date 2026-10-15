# M03-R1D: Bind native credentials to locked model provider

**Goal:** Close M03-R1C-Q01: provider credentials are selected only from the immutable locked route, and mismatching runtime adapter metadata fails before secret resolution.

**Sources:** Approved Mastra migration design §6; M03-R1 Global Constraints; review `.superpowers/sdd/2026-10-11-m03-r1c-locked-plan-selection/reports/review.md` SHA256 `83a874e67588c05e0a4e7f9118b5f1eed9cc376f8443a355ce525828e16e93fb`; R1C package SHA256 `cbf4a58e41da86504d02f183e53a7316aa3dedfc619dd6518308f63482ce135d`. Worktree `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`, BASE `e15cef8ec3c3c223aaf0935a0ea81f8c5e370737`, uncommitted.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Native provider and credential provider come from the same retained locked route. Validate runtime provider and default model identity before any secret resolution; on mismatch fail closed generically.
- Preserve explicit locked PlanModel route selection and its provider/token/endpoint matching behavior, estimator primitive immutable route, one-use budget/capability order, generic errors, and R1A stream regressions.
- No credentials, external providers, DB startup/migrations, commit/stash/reset, or out-of-scope edits.

## Review Focus

1. Selected OpenAI route plus runtime adapter claiming Anthropic is rejected before credential secret resolver is called.
2. Matching native runtime uses selected provider for key resolution and selected provider/model for construction.
3. Anthropic selected route analogously cannot consume OpenAI credential. Existing native injection tests are extended to mismatch.
4. PlanModel and stream behaviors remain intact.

## Task 1: Validate runtime identity before native key resolution

**Depends on:** M03-R1C failed review finding. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Owned files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** retained route model/provider, RuntimeModel adapter result, provider-aware secret resolver, R1C review.

**Produces:** pre-key runtime identity mismatch guard; direct route-bound native credential provider; regression tests for provider/model substitution and no secret read.

- [ ] **RED:** Add OpenAI-selected/Anthropic-runtime and Anthropic-selected/OpenAI-runtime tests (or a table). Assert generic failure, zero calls to resolver, and zero native model construction. Add matching-route assertion that resolver receives exactly locked provider. Run tests before implementation.
- [ ] **Implement:** In native branch compare runtime provider and defaultModel to route.model provider/defaultModel; mismatch throws into existing generic failure boundary before resolver. Call `resolveApiKey` with `route.model.provider`, never adapter runtime provider. Keep provider factory bound to same selected route.
- [ ] **Verify:** focused model/integration/gateway tests; owned Biome; server typecheck with only M17 TS2345 classified; database only if exact reserved setup is already present, no startup.
- [ ] **Checkpoint:** Verify before snapshot SHA `622d2013010ee09fce85033f2c3d83cfc17284625b73e3782983e261f650a5f2`, produce complete after snapshot/package, and report RED/GREEN, exact commands/results and hashes.

**Acceptance:** No runtime adapter divergence can select another provider's secret or pair a selected model with a different provider key. PlanModel and all prior M03 acceptance remains green.

## Interface consistency scan

| Consumer | Provider identity |
|---|---|
| Secret resolver | retained selected route provider |
| Native model factory | same retained selected route provider/model |
| Runtime adapter result | must match selection before secret read |

| Task | Internal consistency |
|---|---|
| Task 1 | Validation, resolver argument and tests use the same route boundary. |

No cycles or omitted review acceptance.
