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
- R1 delta: PRE-R1 test hash `50c612d3450bf0864d09283439fea60ff6bf11af82b03fd02008ca06eeda0391` → POST-R1 test hash `d12f7640e9607692538d44e63bf9b370c254bfa3d51824e060a8591be5f719f9`. R1 POST SHA-256 `docs/plans/reports/T03-skills-draft-lifecycle-impl.md`: `eb4e6a23cdc3c34f79ccf7743579d44539e256f24bd15182dc1d7fc4dec7011f`.
- HEAD remains `203d0f0244b2f898218fa12027089c631e8448d9`; no commit.
