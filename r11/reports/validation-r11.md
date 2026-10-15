# R11 Independent Validation

- Status: **DONE**
- Validation date: 2026-10-11 (Asia/Shanghai)
- Revision: `2054397cd9c4fb1b161086c9f991c15a11f6d4fe`
- Worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`
- Before validation: four assigned tracked files were modified and `r10/` existed untracked. Validation added only this report under `r11/reports/`.
- Prior same-revision evidence: `r10/reports/validation-r10.md` records the same HEAD, but predates R11’s changes. R11 checks below were run against current snapshot.

## Snapshot identity

| File | SHA-256 | Expected | Result |
|---|---|---|---|
| `server/src/mastra/model.ts` | `49fdb38410f6f5cc962a33401bd8aa62be55639282fd097de8e9ef266cccd4d5` | same | Match |
| `server/tests/enterprise/mastra-model.test.ts` | `b6a34d6e10dfddb97ac7482dba8c186b63394a327b5123980e61cbc9b63c324d` | same | Match |
| `server/src/enterprise/models/runtime-adapter.ts` | `d0801593c47f7945b07ffd4be7f0ec77d2b94539d85d1cf00a42b2eb0087240c` | not supplied | Recorded |
| `server/tests/enterprise/mastra-model.integration.test.ts` | `4087dbd250496629761dd0f85dd855c107add42ea9b317870aaf8f5b7b33945a` | not supplied | Recorded |

## Commands and status

All commands ran from the worktree above.

| Exact command | Result |
|---|---|
| `git rev-parse HEAD` | `2054397cd9c4fb1b161086c9f991c15a11f6d4fe` |
| `sha256sum server/src/mastra/model.ts server/tests/enterprise/mastra-model.test.ts server/src/enterprise/models/runtime-adapter.ts server/tests/enterprise/mastra-model.integration.test.ts` | Assigned model and test hashes match; other hashes recorded above. |
| `git diff --check` | Pass; no whitespace errors. |
| `bun test server/tests/enterprise/mastra-model.test.ts` | Pass: 58 tests, 0 failures. |
| `bun test server/tests/enterprise/mastra-model.integration.test.ts` | Pass: 3 tests, 0 failures. |
| `bun test server/tests/enterprise/model-gateway.test.ts` | Pass: 29 tests, 0 failures. |
| `bunx biome check server/src/enterprise/models/runtime-adapter.ts server/src/mastra/model.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/mastra-model.test.ts` | Pass: 4 files checked; no fixes applied. |

## Acceptance evidence

- Usage getter access is defensive: tests cover throwing nested usage getters on generate and stream finish, plus a throwing root `usage` getter. Generate resolves safely or stream delivers finish, settles unknown exactly once, and does not confirm usage. Pass.
- Opaque class metadata is serialized into sanitized plain data before exposure; a class instance carrying `private-key` is not exposed as its original instance and its secret is absent from the result. Pass.
- A throwing `getReader` acquisition rejects with generic `MODEL_INVOCATION_FAILED`, settles unknown once, and does not confirm usage. Pass.
- Binary `ArrayBuffer` views and streamed file bytes are preserved byte-for-byte by focused model tests. Pass.
- `Headers` metadata is reconstructed with safe unique redacted names; collision and secret-containing names/values are covered. Pass.
- Existing generic errors, cancellation, and settlement invariants are covered by model and gateway focused tests. The gateway suite passes split-chunk redaction, malformed/oversized SSE, tool arguments, abort, and generic upstream error cases.
- Integration confirms governed native v3 protocol behavior, persisted native route identity/local endpoints, and rejection of unsupported provider routing. No HTTP authentication/authorization path, persistence schema, or migration is changed by this assigned model adapter diff.

## Gaps and risks

No assigned acceptance gap observed. Validation is bounded to the listed focused suites and static checks; it does not establish behavior against a live provider/database or a full repository run. Authentication, authorization, and migration checks are not applicable to the inspected model-layer change. Existing broader worktree modifications were not altered.
