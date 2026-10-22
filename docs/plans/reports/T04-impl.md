# T04 Implementation Report — Bots Roster and Work Detail

## Scope and outcome

Implemented the P06/P07 presentation slice within T04 ownership. The roster algorithm and its `needsYou → pinned → yours → shared → hidden` precedence remain unchanged. Roster rows now have a 64px minimum presentation height, allow long names and summaries to wrap across two lines, and keep the trailing count/navigation affordance from shrinking. Bot detail identity now presents a 32px avatar, Bot name, role, and description. General management and the dangerous Delete action render in separate expanded sections; Delete remains permission-gated and keeps its existing confirmation dialog and mutation.

No API, query shape, route/search, permission, event, or business logic contract was changed. Hidden roster contents still start folded. No browser/runtime acceptance was performed; per brief, rendered browser acceptance remains deferred to the user. Loading/empty/error states and existing owner/shared/read-only affordances were retained.

## Changed source and test files

- `app/src/components/bots/bot-roster.tsx`
- `app/src/components/bot-profile/profile.tsx`
- `app/src/components/bot-profile/manage.tsx`
- `app/tests/bot-manage.test.tsx`

The test verifies that destructive deletion is a distinct section after everyday management. TDD evidence: with reconstructed PRE `manage.tsx`, the new test failed (1 failed / 6 passed, exit 1); restored POST `manage.tsx` passed (7/7 in the final native test run).

## Verification evidence

All commands ran in the T04 worktree, without dependency installation. Final source hash binding is POST manifest SHA-256 `435d38656d38714cb235b5a2a0909111075813c339d18eec9b88a6f30de349c1`; HEAD remained `203d0f0244b2f898218fa12027089c631e8448d9`.

1. Native targeted suites, ADR0008 e2e runner:

   `E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t04/native-final bunx e2e run --config e2e.unit.config.ts app/tests/bot-manage.test.tsx app/tests/bot-needs-you.test.tsx app/tests/bot-profile-active.test.tsx app/tests/bot-profile-notice.test.tsx app/tests/bot-roster-groups.test.ts app/tests/bot-roster.test.tsx app/tests/bot-settings-rows.test.tsx`

   Exit 0. 12 selected / 12 passed / 0 failed / 0 skipped across the native files (`bot-manage` 7 tests; `bot-roster-groups` 5 tests). The other five applicable files are assigned to the Bun-driven `app/tests part 1` partition and are excluded from native collection.

2. Required Bun-driven partition:

   `E2E_BUN_ONLY='app/tests part 1' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t04/driven-final bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`

   Exit 0. e2e wrapper 1/1 passed, no skips. The driver reported four unrelated partition files that fail only when sharing a Bun process and reran them individually; the group passed after those isolated reruns. Report: `docs/verification/workspace-redesign/t04/driven-final/report.json`.

3. Scoped Biome:

   `bunx biome check app/src/components/bots/bot-roster.tsx app/src/components/bot-profile/profile.tsx app/src/components/bot-profile/manage.tsx app/tests/bot-manage.test.tsx`

   Exit 0, 4 files checked, no diagnostics. `biome check --write` was used once on these same owned paths to format the touched JSX and the pre-existing formatting in `manage.tsx`; the final check above is clean.

## Checkpoint and reversible delta

PRE covered 22 owned source/test paths. The supplied PRE manifest SHA-256 is `178345393ac279c3341fb4397d13d67cb031f6f9ede2a0d158ed16c89b9551d3`. PRE source files were reconstructed from captured HEAD plus the captured staged/unstaged patches; all 22 reconstructed file hashes matched the supplied PRE manifest (0 mismatches).

POST includes source snapshots and hashes for all 22 paths, HEAD, full workspace status, and staged/unstaged patches under `docs/verification/workspace-redesign/execution/checkpoints/t04/POST/`. POST manifest SHA-256 is `435d38656d38714cb235b5a2a0909111075813c339d18eec9b88a6f30de349c1`.

The PRE→POST delta is `docs/verification/workspace-redesign/execution/checkpoints/t04/delta.patch`, SHA-256 `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`. It changes exactly the four paths listed above. Applying the delta to PRE snapshots succeeded and reproduced every POST hash (0 mismatches); all current live hashes match POST (0 mismatches).

## Remaining evidence / limits

- Browser matrix, 390px overflow, 200% zoom, actual long-content fixtures, focus and computed-style checks remain deferred to user browser acceptance. No fixtures were written to a live business environment.
- The driven partition emits an existing warning about four sibling suites that are isolated and individually rerun by the ADR0008 harness; the wrapper result is passing and this warning is preserved in the run output.
- No commit was created.
