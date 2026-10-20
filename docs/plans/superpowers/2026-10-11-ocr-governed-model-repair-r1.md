# OCR Governed Model Repair B-R1: Redact stream metadata and complete explicit-bound evidence

**Goal:** Close B review's medium metadata leak and remaining documentation/test gaps without changing reservation policy.

**Sources:** `.superpowers/sdd/2026-10-11-ocr-governed-model-repair/reports/review.md` SHA256 `f0a7784c8bb18be174b1bb0c5f54f16d2bd27a352382a5b7517dc1ac02ec0416`; implementation `task-1-implementation.md`; approved spec §6; user ruling callers must explicitly provide positive maxOutputTokens.

## Global Constraints

- Own only `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts`.
- Apply the same selected key/Plan token/endpoint secret set to stream result metadata as to stream parts. Preserve stream object and typed/binary parts.
- Add caller-facing JSDoc and direct tests for missing, zero, negative and noninteger caps. Keep fail-closed behavior before all side effects; introduce no default.
- No provider/network/DB/commit/stash/reset or other file changes.

## Review Focus

1. Stream `request.body` and `response.headers` containing any selected secret are sanitized in the returned result metadata.
2. Stream itself remains functional and binary parts remain byte-exact.
3. All invalid/missing explicit caps reject before Run lookup, capability issue, credentials or model creation.
4. API caller contract is documented at the governed model boundary.

## Task 1: Metadata redaction and explicit bound contract

**Roles:** backend_implementer → backend_validator → reviewer. **Owned files:** `model.ts`, `mastra-model.test.ts`.

- [ ] **RED:** Add stream test with selected PlanModel secret/endpoint placed in `request.body` and `response.headers`; assert returned metadata does not contain them and does not leak Error objects. Parameterize pre-side-effect invalid-cap test over missing, zero, negative and fractional values; ensure all side-effect counters remain zero. Record RED for the metadata path.
- [ ] **Implement:** Reuse complete invocation secret set for `doStream` result metadata before attaching the returned stream. Add JSDoc stating every caller must set positive `maxOutputTokens`, with no automatic fallback. Keep parts and binary values intact.
- [ ] **Verify:** Run focused model/integration/gateway tests, Biome, typecheck (only M17), diff check.
- [ ] **Checkpoint:** before snapshot SHA `5a66820f82d62906e89bfc5ac64c18a807ffe005297148f08e6ad108d98e64b0`; create after snapshot/package/report with exact TDD evidence.

**Acceptance:** no selected key, Plan token or endpoint appears in `doStream` result metadata or stream parts; invalid caps are directly tested and fail before side effects.

## Interface consistency

| Surface | Secret/bound policy |
|---|---|
| Governed caller | positive output cap required explicitly |
| doGenerate/doStream metadata and parts | all selected credentials/endpoints are redacted |

No new dependencies or schema changes.
