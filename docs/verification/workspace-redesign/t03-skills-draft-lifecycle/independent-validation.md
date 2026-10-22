# T03 Skills draft lifecycle — independent validation

## Result

**DONE_WITH_CONCERNS** — Task 1's assigned test behavior is independently verified on final POST-R2. Real browser behavior remains unverified.

## Revision and checkpoint integrity

- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
- Live `git rev-parse HEAD`: `203d0f0244b2f898218fa12027089c631e8448d9`
- Final POST-R2 checkpoint `HEAD.txt`: `203d0f0244b2f898218fa12027089c631e8448d9` (matches live HEAD)
- Final POST-R2 manifest recorded `app/tests/skills-draft-lifecycle.test.tsx` SHA-256 `0532d91ed21f36d9ff48fa26396c4a19394b3337c12f9af1ff42bd5fa6f27b20`; live `shasum -a 256` matched.
- Final POST-R2 manifest recorded `docs/plans/reports/T03-skills-draft-lifecycle-impl.md` SHA-256 `aad0426674029483f10303bf00c03b01e6afe007405a93b2cd5665ea96baadf3`; live hash matched.

## Acceptance evidence

- The test imports the exported production `Route` from `@/routes/_authed/_app/skills`, registers it in an in-memory TanStack router at `/skills?new=true`, and mounts the actual route with cached query data and the real DetailPanel observer path.
- It types the title via public `userEvent.type`, not private component props or direct state mutation.
- It drives observer widths 880 → 879 → 880. At 879, while the Details dialog is open, it asserts the title is `A retained skill`, the form is `data-dirty="true"`, and the route is `/skills` with `{ new: true }` search. A history subscription established immediately before resizing records `navigationEvents === 0` across the 880 → 879 transition. After 880 it asserts the dialog closes and repeats the title, dirty-state, and route assertions.
- No source or test files were changed by validation.

## Commands and results

Commands run from the worktree root:

| Command | Exit | Result |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | `203d0f0244b2f898218fa12027089c631e8448d9` |
| `shasum -a 256 app/tests/skills-draft-lifecycle.test.tsx docs/plans/reports/T03-skills-draft-lifecycle-impl.md` | 0 | Both live hashes match final POST-R2 manifest. |
| `bunx e2e run --config e2e.unit.config.ts app/tests/skills-draft-lifecycle.test.tsx` | 0 | 1 test file passed; 1 test collected and passed. Duration 1.08s. |
| `bunx biome check app/tests/skills-draft-lifecycle.test.tsx` | 0 | Checked 1 file in 45ms; no fixes applied. |
| `git diff --check` | 0 | No whitespace errors. |

## Warnings and limits

- E2E logged an unrelated skipped collection for `server/tests/billing-period-fulfillment.integration.test.ts`, because the Node ESM collector does not support the `bun:` protocol. The selected test still collected and passed. This aligns with the known ADR0008 runner limitation and is not an acceptance failure for this focused command.
- Happy DOM emitted two React Aria `PressResponder` warnings; the test passed despite them.
- The observer widths are delivered to the production route in Happy DOM. This proves route state and branch behavior under the specified width notifications, but does not establish browser layout geometry, actual ResizeObserver delivery, or visual/accessibility behavior in a real browser. Browser tests were excluded by the assignment.
- Empty and error UI states are not part of this Task 1 acceptance brief and were not exercised.
