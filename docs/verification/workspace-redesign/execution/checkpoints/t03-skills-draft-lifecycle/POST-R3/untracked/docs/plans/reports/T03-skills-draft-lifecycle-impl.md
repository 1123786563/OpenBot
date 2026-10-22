# T03 Skills draft lifecycle — implementation report

## Scope

Implemented Task 1 only: a native E2E regression test for the production Skills route. No production source or other test files were changed. The test seeds `pluginKeys.page()` and `authKeys.currentUser()` in a `QueryClient`, mounts the exported `SkillsRoute` under an in-memory router at `/skills?new=true`, enters the title using `userEvent.type` (React Aria's supported real-keystroke path), and drives the real DetailPanel `ResizeObserver` through 880 → 879 → 880. It asserts the title and `data-dirty="true"` survive and URL search remains `{ new: true }`.

## Verification

- `bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx` — exit 0; 1 test file passed, 1 test collected and passed. Runner emitted its known unrelated skip for `server/tests/billing-period-fulfillment.integration.test.ts` because its `bun:` protocol is unsupported in the Node collector. Happy DOM emitted two React Aria PressResponder warnings; test passed.
- `bunx biome check app/tests/skills-draft-lifecycle.test.tsx` — exit 0; checked 1 file, no fixes applied.
- `git diff --check` — exit 0, no whitespace errors.

## Evidence

- HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (unchanged; no commit).
- SHA-256 `app/tests/skills-draft-lifecycle.test.tsx`: `50c612d3450bf0864d09283439fea60ff6bf11af82b03fd02008ca06eeda0391`.
- Test file is new/untracked relative to HEAD; no production files were modified by this task.
- An initial test attempt using `fireEvent.change` failed at the dirty-state assertion because the React Aria controlled input did not process that synthetic event. The coordinator identified repository precedent at `app/tests/bot-setup.test.tsx:166-171`; switching to `userEvent.type` made the production-route regression pass. This was a test-event-path limitation, not a production defect.

## Limits

This verifies the production route and ResizeObserver-driven branch transition in Happy DOM. It does not establish browser layout geometry or rendered browser behavior.

## Review repair R1

Added assertions immediately after the production DetailPanel dialog appears at width 879: the title input inside that dialog contains `A retained skill`, its form has `data-dirty="true"`, and the memory router remains at `/skills` with `{ new: true }`. The existing assertions after returning to width 880 continue to verify the same draft and route state.

- Focused E2E: `bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx` — exit 0; 1 file passed, 1 test collected and passed. The runner emitted the unrelated `bun:` protocol collection skip for `server/tests/billing-period-fulfillment.integration.test.ts`; Happy DOM emitted two PressResponder warnings.
- Biome: `bunx biome check app/tests/skills-draft-lifecycle.test.tsx` — exit 0; checked 1 file, no fixes applied.
- Diff check: `git diff --check` — exit 0.
- R1 POST SHA-256 `app/tests/skills-draft-lifecycle.test.tsx`: `d12f7640e9607692538d44e63bf9b370c254bfa3d51824e060a8591be5f719f9`.
- HEAD remains `203d0f0244b2f898218fa12027089c631e8448d9`; no commit.

## Review repair R2

After the initial `/skills?new=true` route resolves, the test subscribes to the memory history and counts public history notifications during the 880 → 879 → 880 ResizeObserver sequence. It asserts the count remains zero, in addition to the existing title, dirty-state, open dialog at 879, and route state assertions at 879 and 880.

- Focused E2E: `bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx` — exit 0; 1 file passed, 1 test collected and passed. The runner emitted the unrelated `bun:` protocol collection skip for `server/tests/billing-period-fulfillment.integration.test.ts`; Happy DOM emitted two PressResponder warnings.
- Biome: `bunx biome check app/tests/skills-draft-lifecycle.test.tsx` — exit 0; checked 1 file, no fixes applied.
- Diff check: `git diff --check` — exit 0.
- R2 POST SHA-256 `app/tests/skills-draft-lifecycle.test.tsx`: `0532d91ed21f36d9ff48fa26396c4a19394b3337c12f9af1ff42bd5fa6f27b20`.
- R2 delta: PRE-R2 test hash `d12f7640e9607692538d44e63bf9b370c254bfa3d51824e060a8591be5f719f9` → POST-R2 test hash `0532d91ed21f36d9ff48fa26396c4a19394b3337c12f9af1ff42bd5fa6f27b20`.
- HEAD remains `203d0f0244b2f898218fa12027089c631e8448d9`; no commit.

## Review repair R3

Kept the public memory-history subscription active through the complete 880 → 879 → 880 sequence and all post-transition assertions. `navigationEvents` is asserted to remain zero at 879 and again after returning to 880. The subscription is now removed in `finally`, including assertion or resize failures.

- Focused E2E: `bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx` — exit 0; 1 file passed, 1 test collected and passed. The runner emitted the unrelated `bun:` protocol collection skip for `server/tests/billing-period-fulfillment.integration.test.ts`; Happy DOM emitted two PressResponder warnings.
- Biome: `bunx biome check app/tests/skills-draft-lifecycle.test.tsx` — exit 0; checked 1 file, no fixes applied.
- Diff check: `git diff --check` — exit 0.
- R3 POST SHA-256 `app/tests/skills-draft-lifecycle.test.tsx`: `4ca41cfe0f822eeebe1bcfd7a87ddd7357a51e23901c75a29741c8319a400c2c`.
- R3 delta: PRE-R3 test hash is the R2 POST `0532d91ed21f36d9ff48fa26396c4a19394b3337c12f9af1ff42bd5fa6f27b20` → POST-R3 `4ca41cfe0f822eeebe1bcfd7a87ddd7357a51e23901c75a29741c8319a400c2c`.
- HEAD remains `203d0f0244b2f898218fa12027089c631e8448d9`; no commit.
- R3 POST SHA-256 `docs/plans/reports/T03-skills-draft-lifecycle-impl.md`: `aa26710716d1495cbd2261e047f19f22590af5a31f75d906497949c4d179c602`.
