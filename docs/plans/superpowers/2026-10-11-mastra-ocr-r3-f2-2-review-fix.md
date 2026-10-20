# F2-2-R1 Wrong-Secret Regression Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove that a capability signed by one server secret is rejected by a service configured with another secret, without consuming the persisted capability.

**Architecture:** Keep the production HMAC verification unchanged. Add a behavior test using the same data database and authorized scope: issue through the existing Run service, resolve with a second capability service using a distinct valid-length secret, then resolve once with the original service and verify a second original resolve fails as already consumed.

**Tech Stack:** TypeScript, Bun, Drizzle, PostgreSQL, node:crypto.

**Spec:** `docs/plans/superpowers/2026-10-11-mastra-ocr-r3-fix2-outer-ocr.md` Task F2-2, acceptance item 5; independent review finding `F2-2-R1` in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix2-outer-ocr/reports/task-f2-2-review.md`.

## Global Constraints

- Preserve OpenBot ownership of capability authorization and usage settlement.
- Wrong-secret resolution must return exactly the existing `MODEL_CAPABILITY_INVALID` / 401 contract and must not consume or mutate the row.
- Keep the repair limited to `server/tests/enterprise/runs.integration.test.ts`; no production code change is indicated by the finding.
- Use only the dedicated isolated loopback:5434 test URLs. Never use `DATABASE_URL` as fallback.
- No commit, stash, reset, push, merge, deployment, or changes to unrelated pre-existing Run tests.

## Review Focus

1. Wrong-secret rejection must occur before the one-use state transition; the original service must still resolve the same token afterward.
2. The mismatch must use a second valid-length secret so the service constructor itself does not reject the fixture.
3. The final original-service resolve must preserve one-use semantics and prove consumption occurs exactly once.

---

## Task DAG and ownership

| ID | Acceptance | Depends on | Owner / validator | Owned files | Interface | Verification | Status |
|---|---|---|---|---|---|---|---|
| F2-2-R1 | Wrong-secret request returns fixed 401, does not consume the capability, and the original service resolves it exactly once | F2-2 checkpoint | backend_implementer / backend_validator | `server/tests/enterprise/runs.integration.test.ts` | Existing `createModelInvocationCapabilityService({ data, secret })` and Run service APIs; no production interface change | wrong-secret regression plus isolated Run suite, Biome, scoped diff | pending |

### Shared-interface preflight

The capability service factory is exported and already receives the shared `dataDatabase`; it creates no independent schema or connection ownership. The existing `runs` service was constructed with the accepted test secret in `beforeAll`. A second direct capability service using a distinct valid-length secret can resolve against the same database row. No shared-file overlap exists with other tasks.

## Task 1: Add wrong-secret regression coverage

**Files:** Modify and test only `server/tests/enterprise/runs.integration.test.ts`.

**Consumes:** Existing `runs` service, `dataDatabase`, `scope`, `createModelInvocationCapabilityService`, and a valid newly issued capability.

**Produces:** A focused regression test named `wrong capability service secret rejects without consuming the issued capability`.

- [x] **Step 1 — Add the regression test:** Issue a capability through `runs` for an active Run/attempt. Construct `createModelInvocationCapabilityService({ data: dataDatabase!, secret: "different-test-only-model-capability-secret-0000000000000000" })`. Assert `wrongSecret.resolve(scope, issued.capability)` rejects with `{ status: 401, code: "MODEL_CAPABILITY_INVALID" }`; then assert the original `runs.resolveModelInvocationCapability(scope, issued.capability)` succeeds once and a second call rejects with `{ status: 409 }`. Import the existing exported capability-service factory; no production file changes.
- [x] **Step 2 — Verify:** Run the exact focused regression and the full isolated Run integration against the existing F2-2 production implementation. Expected: the wrong-secret attempt gets fixed 401, original resolution succeeds once, second original resolution fails as consumed. Since this is a coverage-only repair and the production code already appears to enforce the secret, a failing production test is not expected. Do not mutate HMAC-signed row columns as part of this test.
- [x] **Step 3 — Lint and self-review:** Run the exact isolated Run integration with the dedicated setup, directory, data, and operator URLs recorded in `briefs/task-f2-2.md`; expected full suite passes. Also run Biome on the test and `git diff --check` for its scoped patch.

**Failure handling:** If the wrong-secret service cannot resolve the same scoped row due to fixture connection ownership, use the exported direct capability-service factory over the already verified shared `dataDatabase`; do not add a new connection, grant, schema, or test-only production hook.
