# R10 Independent Validation

- Status: **DONE**
- Validation time: 2026-10-11 (Asia/Shanghai)
- Worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`
- Revision (HEAD): `2054397cd9c4fb1b161086c9f991c15a11f6d4fe`
- Working tree: four tracked files modified before validation; this report is the only file created by validation.

## Snapshot identity

| File | SHA-256 | Assigned expected hash | Result |
|---|---|---|---|
| `server/src/mastra/model.ts` | `67789acd260c0ee163e30da12cc57572db8c1cb7250df1f31a10a69556a69ff0` | same | Match |
| `server/tests/enterprise/mastra-model.test.ts` | `7b79d6593e7dde9049ced29e81f09acab521e95883533ca820f3b42ea36ecb69` | same | Match |
| `server/src/enterprise/models/runtime-adapter.ts` | `d0801593c47f7945b07ffd4be7f0ec77d2b94539d85d1cf00a42b2eb0087240c` | not supplied | Recorded current snapshot |
| `server/tests/enterprise/mastra-model.integration.test.ts` | `4087dbd250496629761dd0f85dd855c107add42ea9b317870aaf8f5b7b33945a` | not supplied | Recorded current snapshot |

## Commands and results

Commands were run from the worktree above.

| Command | Result |
|---|---|
| `git rev-parse HEAD` | `2054397cd9c4fb1b161086c9f991c15a11f6d4fe` |
| `sha256sum server/src/enterprise/models/runtime-adapter.ts server/src/mastra/model.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/mastra-model.test.ts` | Hashes shown above; assigned model and unit-test hashes match. |
| `bun test server/tests/enterprise/mastra-model.test.ts` | Pass: 55 tests, 0 failures. |
| `bun test server/tests/enterprise/mastra-model.integration.test.ts` | Pass: 3 tests, 0 failures. |
| `bun test server/tests/enterprise/model-gateway.test.ts` | Pass: 29 tests, 0 failures. |
| `bunx biome check server/src/enterprise/models/runtime-adapter.ts server/src/mastra/model.ts server/tests/enterprise/mastra-model.integration.test.ts server/tests/enterprise/mastra-model.test.ts` | Pass: 4 files checked, no fixes applied. |
| `git diff --check` | Pass: no whitespace errors. |

## Acceptance evidence

- **Throwing usage getter on generate:** the unit test verifies no exception escapes, exactly one unknown settlement occurs, and usage confirmation does not occur. Passed.
- **Throwing usage getter on stream finish:** the unit test verifies the finish event is delivered, the stream ends, exactly one unknown settlement occurs, and usage confirmation does not occur. Passed.
- **Unknown usage behavior:** absent, null, and invalid usage paths have focused tests; generate settles unknown without throwing, while stream finish is delivered and settles unknown. Passed.
- **Prior redaction behavior:** focused tests cover native API key removal from stream metadata keys and values, PlanModel token/endpoint redaction, secret matches split across source text deltas, metadata-key collision preservation, binary byte preservation, and generic failures. Model suite passed. Gateway suite also passed split-secret streaming, tool-argument redaction, malformed input handling, and generic upstream error cases.
- **Cancellation and settlement consistency:** tests cover cancellation before finish and redaction failure cancellation; claims settle unknown once. The implementation memoizes settlement and withholds finish until confirmation succeeds. Relevant model and gateway cases passed.
- **Authentication/authorization and migrations:** this change is in the governed model adapter and does not alter an HTTP route, authentication middleware, authorization policy, or database schema. No migration applies to the inspected diff. The model contract still resolves the locked route and credentials through injected governed dependencies; tests verify route substitution is rejected before credential lookup.

## Gaps and risks

No acceptance gap was observed in the assigned throwing-getter, unknown-usage, prior-redaction, cancellation, or settlement behaviors. Validation is limited to the assigned worktree and focused suites; no full repository suite or live database/provider check was run. The worktree contains broader existing changes in the four listed tracked files, and the two unspecified hashes are recorded to bind this report to the observed snapshot.
