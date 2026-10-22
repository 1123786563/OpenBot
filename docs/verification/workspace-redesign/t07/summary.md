# T07 verification summary

- Task: T07, P01–P05 chat/home/direct/group chat layout scope only.
- PRE HEAD: `203d0f0244b2f898218fa12027089c631e8448d9`.
- POST HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (no commit).
- POST source/test paths: 84; all PRE hashes were independently reconstructed from HEAD plus PRE staged/unstaged patches and matched before delta generation.
- POST manifest SHA-256: `7fc8e4fa17006bda612785ee924226e2a7ff4c1f8e988858fcc9312acdccf435`.
- PRE→POST changed paths: `app/src/components/channels/chat-transcript.tsx`, `app/src/components/channels/conversation-view.tsx`, `app/src/components/channels/group-chat.tsx`, `app/src/routes/_authed/_app/index.tsx` (Composer plus hint/error rows aligned to 720px).
- Incremental patch SHA-256: `6ba618d32cfa617437efb609902bba0643edf5cda1b87d048161297e2dafa335`.
- No source or test files outside the T07 owned paths were changed by this task. The rest of the worktree remains the pre-existing shared baseline.

## Checks bound to this POST source version

| Check | Command/result | Evidence |
| --- | --- | --- |
| Native selected tests | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-native bunx e2e run --config e2e.unit.config.ts app/tests/channel-event-patch.test.ts app/tests/channel-label.test.ts app/tests/channel-menu-mutations.test.ts app/tests/channel-order.test.ts app/tests/channel-search.test.ts app/tests/channel-socket-message.test.ts app/tests/channel-unread.test.ts app/tests/composer-attachment-strip.test.tsx app/tests/composer-attachments.test.ts app/tests/composer-collapse.test.tsx app/tests/composer-rejected-files-gap.test.tsx app/tests/composer-rejected-files.test.tsx app/tests/computer-driving-local-fields.test.tsx app/tests/computer-handoff-rejoin.test.ts app/tests/computer-preview-visibility.test.tsx app/tests/computer-reset-clears-activity.test.ts app/tests/mark-open-channel-read.test.tsx` — exit 0; 17 files, 124 selected/executed/passed, 0 failed/skipped | [final-native/report.json](final-native/report.json) |
| Driven part 2 | `E2E_BUN_ONLY='app/tests part 2' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part2 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; 1 selected/executed/passed driver group | [final-driven-part2/report.json](final-driven-part2/report.json) |
| Driven part 3 | `E2E_BUN_ONLY='app/tests part 3' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part3 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; 1 selected/executed/passed driver group | [final-driven-part3/report.json](final-driven-part3/report.json) |
| Driven part 4 | `E2E_BUN_ONLY='app/tests part 4' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part4 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0; 1 selected/executed/passed driver group | [final-driven-part4/report.json](final-driven-part4/report.json) |
| Biome | `bunx biome check` on the three chat components and P01 Home route — exit 0; all changed source paths clean (the route was rechecked in T07-R2) | terminal output |
| Diff whitespace | `git diff --check` — exit 0 | terminal output |
| App typecheck | `bun run --cwd app typecheck` — after T06-R4/R5, only `app/tests/button-native.test.tsx:54` remained; T02-R3 is correcting the callback, then typecheck will be rerun | captured output; update after T02-R3 |
| App build | `bun run --cwd app build` — exit 0; generated production bundle. Existing Rollup annotation/dynamic-import warnings and >500 kB chunk warning remain | [build.log](build.log) |

The native e2e runner also emitted collection warnings for two pre-existing untracked tests (`app/tests/bot-subpage.test.tsx`, `app/tests/routines-list.test.tsx`) whose imports use `bun:` under Node. They were not selected, are not T07-owned test paths, and do not count as T07 passes. Driven reports emitted that same global collection warning plus an unrelated `server/tests/billing-period-fulfillment.integration.test.ts` warning; selected driven groups passed with nonzero execution.

## Browser and interaction acceptance

Browser/runtime acceptance remains **pending user testing**, as directed in T07. This checkpoint does not claim real identity/tenant fixtures, computed styles, viewport overflow, mobile keyboard/safe-area, IME interaction, stream/stop/retry, URL/Back context-panel behavior, control release, long content, loading/error/empty state screenshots, or direct `/bot` runtime behavior as browser-verified. Existing targeted automated suites cover related behavior, but are not a substitute for the required browser evidence.
