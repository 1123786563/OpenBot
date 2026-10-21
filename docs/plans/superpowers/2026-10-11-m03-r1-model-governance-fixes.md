# M03-R1 Model Governance Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Backend implementation is serial; controller dispatches independent validator and reviewer only after freezing the package.

**Goal:** Close all five valid findings from M03 Task 3 review so every native Mastra model request is bound to the trusted Run route, reserves a defensible total-token upper bound, preserves AI SDK values, settles usage before stream completion, and supports every stored RuntimeModel provider.

**Architecture:** Preserve the existing one-use capability service and tenant DB fencing. Before a capability is issued, resolve only the server-owned immutable route and compute a mandatory provider-aware input-token upper bound through a trusted server dependency. Unsupported content or unavailable bounds fail closed. Reserve input upper bound plus output cap as the invocation's maximumTokens; the existing DB transaction atomically checks this against both the locked per-route maximum and the remaining Run ceiling. Only after capability consumption may the adapter resolve credentials and construct the provider model. Route provider/model/PlanModel selection comes only from RuntimeModelRoute.model; deployment base URLs may remain operator configuration. Anthropic uses the AI SDK's V3 provider directly. Binary and other non-plain SDK values pass through redaction unchanged. A stream is settled before its finish part is made public.

**Tech Stack:** Existing AI SDK 6.0.264 and OpenAI provider 3.0.99; add exact direct @ai-sdk/anthropic 3.0.111 (already present transitively in the repository lockfile), Bun, TypeScript, PostgreSQL synthetic integration fixture. Official provider reference: [AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic).

**Source:** Approved Mastra migration spec §6, original Task 3, and valid findings M03-R1 through M03-R5 in .superpowers/sdd/2026-10-10-mastra-intelligence-migration/m03-model-governance/reports/m03-review.md SHA-256 8ba36180b1520de9c458667555c9b9886e34e2c64518f0b325e647a84f3dbf41. The original implementation checkpoint remains unverified pending this repair.

## Global Constraints

- Every governed generate/stream invocation reserves a **total** input-plus-output upper bound under the existing one-use capability before dispatch; aggregate claims remain per business Run.
- Input-token upper bounds are produced by a mandatory trusted server-side estimator that understands the selected provider/model and all accepted prompt/tool/media structures. It must throw for unsupported or unbounded input. Do not use raw byte/character length as a universal token estimate and do not allow callers/client options to inject the estimator or its result.
- Capability issuance remains the database serialization point; consumption must retain active attempt/generation and DB-time lease fencing. Resolve credentials only after capability consumption.
- Provider, model, and explicit PlanModel choice come from the immutable DB-locked RuntimeModelRoute.model. BOT_PROVIDER, BOT_MODEL, ambient PlanModel detection, or a client request cannot override it. Preserve deployment-owned endpoint configuration without changing the locked provider/model.
- Resolve keys per invocation; never expose keys, capabilities, or provider diagnostics through Agent state, events, errors, stream parts, or logs.
- Unknown dispatched calls retain their full reserved bound; only unused, unconsumed capabilities may be released.
- Keep native AI SDK V3 support; the HTTP gateway stays a separately tested compatibility route.
- Preserve Uint8Array, ArrayBuffer, typed SDK values, and non-plain objects while redacting strings in arrays/plain records.
- Confirm complete usage before exposing the stream finish; on uncertain usage/settlement, emit a generic failure and retain the conservative claim.
- No real credentials/providers, cloud, migrations, commit, stash, reset, push, deployment, or changes outside the listed ownership. PostgreSQL checks use only the loopback synthetic test database and existing guarded fixture.
- Preserve all unrelated M02 and user edits.

## Review Focus

1. A prompt whose input upper bound exceeds the output cap is charged for both; concurrent nested calls cannot reserve more than the Run ceiling.
2. Ambient provider/model/plan environment values cannot alter the DB-locked route; forged or stale calls do not resolve credentials.
3. Anthropic and OpenAI route models are native LanguageModelV3 instances constructed from the locked route and the per-call resolved key.
4. Redaction preserves binary file/image data and typed SDK parts.
5. Stream consumers never observe finish until settlement succeeds; cancellation or settlement failure remains unknown/charged and public errors are generic.

## Task 1: Repair M03 governed model and route adapters

**Depends on:** Failed-gate M03 implementation checkpoint at HEAD e15cef8ec3c3c223aaf0935a0ea81f8c5e370737; it is the repair baseline, not an accepted downstream dependency. **Roles:** backend_implementer → backend_validator → reviewer.

**Files / ownership:** Modify server/src/enterprise/models/runtime-adapter.ts, server/src/mastra/model.ts, server/package.json, bun.lock, server/tests/enterprise/mastra-model.test.ts, and server/tests/enterprise/mastra-model.integration.test.ts. Do not change other files without a recorded scope ruling.

**Consumes:** Existing RunService capability API and active-attempt generation lookup; frozen RuntimeModelRoute, RuntimeModel, and PlanModel contracts; Task 3 package and all five findings.
**Produces:** Required server-side estimateInputTokenUpperBound(route, options) seam with fail-closed behavior; total-token capability reservation; locked native route for OpenAI/Anthropic/explicit PlanModel; complete settlement and SDK-safe redaction.

- [ ] **Step 1 — RED:** Add behavior tests for each finding before production edits: estimated input plus output is the issued maximum; unsupported/unbounded prompt is rejected before key resolution/provider dispatch; a competing Run claim over the remaining ceiling is rejected; ambient conflicting provider/model/plan values cannot change the selected route; both native OpenAI and Anthropic factories honor route model and test endpoint; binary result and stream parts preserve exact bytes; finish is withheld until usage settlement succeeds, and generic stream error is returned on failed settlement.
- [ ] **Step 2 — Reproduce:** Run the focused model suite and record each expected failing assertion separately from environment failures. Run the existing guarded runs.integration.test.ts against the reserved synthetic DB, serially, to validate real DB cumulative-ceiling behavior; do not run migrations.
- [ ] **Step 3 — Implement:** Introduce a mandatory trusted provider/model-aware upper-bound estimator and reject unsupported structures. Select immutable route before estimating but do not resolve secrets until after one-use capability consumption. Add exact direct dependency @ai-sdk/anthropic 3.0.111 to server/package.json and update the root bun.lock; implement its native V3 factory and a synthetic loopback Messages API test. Keep gateway environment behavior only in its explicit compatibility adapter. Fix binary redaction and settle before finish.
- [ ] **Step 4 — GREEN/self-review:** Run cd server && bun --no-env-file test tests/enterprise/mastra-model.test.ts tests/enterprise/mastra-model.integration.test.ts tests/enterprise/model-gateway.test.ts; separately run cd server && bun --no-env-file test tests/enterprise/runs.integration.test.ts with the reserved synthetic TEST_DATABASE_URL. Run Biome on all six owned source/test files and server typecheck; classify only the already assigned M17 probe diagnostic separately. No skipped acceptance tests.
- [ ] **Step 5 — Checkpoint and gates:** Freeze a full before/after snapshot and package for these six repair paths, including all content and hashes; report exact TDD evidence, synthetic DB identity without credential values, package-lock changes, and concerns. Independent validator and reviewer inspect the same frozen package. The findings close only when both return PASS.

**Acceptance / failure handling:** Closes M03-R1, M03-R2, M03-R3, M03-R4, M03-R5; realizes approved spec §6 and original Task 3 AC-02/05/07/12. If a supported provider cannot supply a defensible upper bound for a prompt structure, fail closed and report it rather than weakening accounting.

## Interface consistency scan

| Producer / consumer | Shared paths or interface | Finding |
|---|---|---|
| Original Task 3 / this repair | runtime-adapter.ts, mastra/model.ts, two model tests | One implementation boundary. Repair consumes the frozen failed checkpoint and changes only the five reviewed behaviors. |
| This repair / Task 4 | Governed model, trusted route, model call options | Task 4 must consume the required input-token upper-bound seam and cannot call the governed model without a trusted estimator. Its brief will cite this verified output. |
| This repair / Task 6+ | Native model registration and deployment endpoint config | Provider/model identity stays route-bound; endpoint config remains deployment-owned and cannot choose a provider/model. |

| Task | Internal consistency |
|---|---|
| Task 1 | Production files align with the required RED cases, provider dependency, synthetic protocol test, serial guarded DB check, and PASS gates; estimator is mandatory and fails closed when it cannot bound input. |

No cycles or unresolved acceptance omissions exist in this one-task repair DAG. No user approval is needed for a finding-scoped repair within the previously authorized end-to-end implementation.
