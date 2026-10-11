# R12 Independent Validation

- Status: **DONE_WITH_CONCERNS**
- Validation date: 2026-10-11 (Asia/Shanghai)
- Revision: `2054397cd9c4fb1b161086c9f991c15a11f6d4fe` (R12 files are uncommitted in this snapshot)
- Worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`
- R12 validation brief: `.superpowers/sdd/2026-10-11-ocr-governed-model-stream-boundary-r12-brief.md`
- Before validation, four tracked files were modified and `r10/`, `r11/` were untracked. This validator added only `r12/reports/validation-r12.md`.

## Snapshot identity

| File | SHA-256 | Expected | Result |
|---|---|---|---|
| `server/src/mastra/model.ts` | `ce045b2f0fe5e746ee918dc8c83b9adca30dc27b53648b0c37742d10451fa55d` | same | Match |
| `server/tests/enterprise/mastra-model.test.ts` | `6855b1af1a66093608ad35581db742c0edd7f37d167b15b17d507dd8c1752f77` | same | Match |
| `server/src/enterprise/models/runtime-adapter.ts` | `d0801593c47f7945b07ffd4be7f0ec77d2b94539d85d1cf00a42b2eb0087240c` | unchanged from R11 | Match |
| `server/tests/enterprise/mastra-model.integration.test.ts` | `4087dbd250496629761dd0f85dd855c107add42ea9b317870aaf8f5b7b33945a` | unchanged from R11 | Match |

## Exact commands and results

Run from the worktree above:

| Exact command | Result |
|---|---|
| `git rev-parse HEAD` | `2054397cd9c4fb1b161086c9f991c15a11f6d4fe` |
| `sha256sum server/src/mastra/model.ts server/tests/enterprise/mastra-model.test.ts` | Both expected R12 hashes match. |
| `sha256sum server/src/enterprise/models/runtime-adapter.ts server/tests/enterprise/mastra-model.integration.test.ts` | Both hashes match R11 snapshot. |
| `bun test server/tests/enterprise/mastra-model.test.ts` | Pass: 60 tests, 0 failures, 166 expectations. |
| `bun test server/tests/enterprise/mastra-model.integration.test.ts` | Pass: 3 tests, 0 failures, 19 expectations. |
| `bun test server/tests/enterprise/model-gateway.test.ts` | Pass: 29 tests, 0 failures, 134 expectations. |
| `bunx biome check server/src/enterprise/models/runtime-adapter.ts server/src/mastra/model.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/mastra-model.test.ts` | Pass: 4 files checked, no fixes. |
| `git diff --check` | Pass; no whitespace errors. |

The four requested test/static commands were run sequentially as one shell invocation joined with `&&`; the invocation exited 0.

## Acceptance evidence

- The `stream text delta sanitizes its id and all metadata before buffering` test injects the selected Plan token in both delta IDs and provider metadata; emitted delta values contain no token. Pass.
- Nested `ReadableStream` metadata is rejected with generic `MODEL_INVOCATION_FAILED`, settles unknown exactly once, and leaves the nested stream unlocked. Pass.
- The top-level provider `stream` is removed before metadata redaction and replaced by the governed stream wrapper. Pass by code inspection; integration/model suites pass.
- Ordering tests confirm text flushes before `text-end` and interleaved parts, and pending text flushes before finish. Pass.
- Binary parts and streamed file bytes remain byte-for-byte intact. Pass in focused model tests.
- Previous settlement behavior remains covered: cancellation, missing/invalid usage, failed redaction and reader acquisition settle unknown once; finish usage is confirmed before finish becomes observable; settlement failure withholds finish generically. Focused model and gateway suites pass.
- No HTTP authentication/authorization path, persistence schema, or migration is changed by this model-layer work; those checks are not applicable to the assigned diff.

## Acceptance concern

The R12 brief explicitly says to call `redact(next.value, secrets)` on the entire text-delta provider part before replacing the delta, and to use only sanitized fields in buffering/emission. Current code instead destructures `delta`, calls `redact(sourceFields, secrets)` for the remaining fields, and processes the raw `sourceDelta` through the specialized `redactStreamText` path. The tested secret-bearing ID/metadata and delta behaviors pass, but the implementation does not follow the requested whole-part redaction step. Treat this as an acceptance gap requiring disposition before marking R12 fully accepted.

## Scope and risks

Validation is bounded to the assigned snapshot and focused suites; it does not establish live provider or database behavior. Authentication, authorization, migrations, and API persistence are outside the changed model-layer scope. No source or test files were modified by validation.
