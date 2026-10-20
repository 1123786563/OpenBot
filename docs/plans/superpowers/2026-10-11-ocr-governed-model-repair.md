# OCR repair B: Harden governed model call lifecycle and safe streaming

**Goal:** Resolve valid high/medium findings from the final OCR while preserving per-Run accounting, locked route identity, and safe public failures.

**Sources:** approved Mastra design §6 and original Task 3; user ruling “callers must explicitly provide `maxOutputTokens`”; OCR report `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/ocr-final-workspace.txt`; architecture audit (recorded in root progress); code review reports through M03-R1D. BASE `2054397cd9c4fb1b161086c9f991c15a11f6d4fe`.

## Global Constraints

- Only edit `server/src/mastra/model.ts` and `server/tests/enterprise/mastra-model.test.ts` in this repair task.
- Caller must explicitly provide a positive `maxOutputTokens`; no default or implicit reservation. Existing runtime rejection is intentional. Add a clear public contract comment and tests that missing/invalid bound fails before Run lookup, capability issue, credential resolution or provider call. Subsequent production Agent assembly tasks must pass the configured explicit bound on every model call; this is a required consumes/acceptance item for those task briefs.
- Preserve atomic per-Run shared ceiling: reservation remains estimated input upper bound + explicit output maximum; unsupported estimate fails closed. Unknown usage retains full reservation.
- PlanModel finish may legitimately report unknown usage: mark unknown and publish finish normally; do not call confirm with invented usage or fail a completed answer. If stream ends without a finish part, mark unknown and signal generic stream error (never silently close as successful truncation).
- Generation/lease lookup and all provider/model errors must cross a generic public error boundary. Plan tokens/endpoints/API keys are redaction secrets; provider Error/APICallError objects must be replaced with a safe error, not forwarded. Preserve binary SDK parts byte-for-byte.
- Remove only model wrapper's unreachable `release` branch; retain RunService.release API for other reserved-capability users.
- No credentials/providers/DB migrations/service startup, commit/stash/reset or edits outside ownership.

## Review Focus

1. Missing `maxOutputTokens` has a direct fail-closed regression; no capability/provider/secret operations happen. No unapproved default is introduced. Add a caller-facing documented contract.
2. PlanModel stream with unknown usage marks full claim unknown but delivers a normal finish; `doGenerate` and `doStream` semantics agree.
3. Stream done without finish marks unknown and errors with `MODEL_INVOCATION_FAILED`; it never reports successful truncation.
4. Generation lookup DB-like failure is sanitized before any capability issue.
5. Provider Error/APICallError stream parts and PlanModel token/endpoint-bearing text are redacted; binary stream bytes remain exact.
6. Capability consume ambiguity stays conservatively charged; remove dead `consumed`/release path only from wrapper.
7. Add direct same-provider/different-defaultModel route mismatch test (low R1D review gap).

## Task 1: Governed model lifecycle and stream boundary repair

**Depends on:** OCR full-workspace review; adapter endpoint Repair A is independent and under separate review. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Owned files:** `server/src/mastra/model.ts`, `server/tests/enterprise/mastra-model.test.ts`.

**Consumes:** RunService invocation capability, locked route/PlanModel decisions, explicit max-output caller rule, OCR issues for finish/usage/error/redaction and existing M03 regression suite.

**Produces:** safe fail-closed invocation boundary; unknown-usage success-finish semantics; truncation error; secret-aware safe event mapping; tests covering each item.

- [ ] **RED:** Add test cases for (a) omitted output bound produces generic error before Run lookup/issue/resolver/model calls; (b) valid PlanModel stream with unknown usage publishes finish successfully and marks unknown once, not confirmed; (c) missing finish errors after markUnknown; (d) `getAttemptGeneration` throws a DB-like secret-bearing error and caller receives only generic failure, before capability; (e) provider error object containing API secret/URL is replaced with generic safe error; (f) PlanModel token/endpoint strings are redacted in emitted values; (g) provider-matching/default-model-mismatching runtime fails before resolver/factory. Run RED and record assertions.
- [ ] **Implement:** Place generation lookup behind generic boundary before issuance. Represent redaction secrets as all nonempty selected provider key or selected plan token/endpoint. Preserve binary values; replace Error instances with a generic safe Error; recursively redact strings in arrays/plain records. On finish with unknown usage, await `markUnknown` then enqueue finish; on EOF without finish, await unknown settlement then error. Keep full maximum charged. Remove `consumed` and release branch from wrapper because any post-issue resolve response failure is ambiguous; always mark unknown after capability issuance. Retain required output-bound validation.
- [ ] **Verify:** `cd server && bun --no-env-file test tests/enterprise/mastra-model.test.ts tests/enterprise/mastra-model.integration.test.ts tests/enterprise/model-gateway.test.ts`; target Biome; `bun run typecheck` with only known M17 TS2345 classified; `git diff --check`. No DB test unless existing exact reserved DB+credentials are verified by repository guard without starting a service (currently unavailable).
- [ ] **Checkpoint:** Verify before snapshot SHA `392fbcd2fe292ed304445c6c7d3e554929ca388c95e039f530cf23340820323c`; produce full after snapshot/package for both files; report exact RED/GREEN and results.

**Acceptance / failure handling:** all seven review-focus behaviors have direct tests; no new defaults, raw errors, token leakage, false success on truncation, or accidental refund. Missing explicit bound test succeeds by rejection. Later Agent/Run assembly is blocked unless every invocation passes explicit output cap.

## Interface consistency scan

| Producer / consumer | Shared contract | Requirement |
|---|---|---|
| Mastra agent caller / governed model | AI SDK v3 call options | Caller explicitly sets positive `maxOutputTokens`; governed wrapper validates at runtime. |
| RunService / model wrapper | maximum claim = input bound + explicit output cap | Unknown usage retains claim; confirmed usage settles actual total. |
| PlanModel / stream adapter | finish can have unknown usage | mark unknown then deliver finish; missing finish is public failure. |
| Provider / event stream | unknown Error and string values | redact all selected secrets and replace provider errors with generic error. |

| Task | Internal consistency |
|---|---|
| Task 1 | All lifecycle and stream changes share `model.ts`; all regression fixtures in its paired test. No parallel writes. |

No DAG cycle. Existing unrelated M02 modifications remain outside this task.
