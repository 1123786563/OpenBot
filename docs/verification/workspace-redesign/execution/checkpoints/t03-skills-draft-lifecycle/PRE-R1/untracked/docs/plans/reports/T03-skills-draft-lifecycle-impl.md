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
