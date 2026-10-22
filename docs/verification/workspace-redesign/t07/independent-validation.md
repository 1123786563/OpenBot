# T07 Independent Validation

- Status: `DONE_WITH_CONCERNS` for source/checkpoint validation; full browser acceptance remains pending.
- Revision: HEAD `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`).
- POST manifest SHA-256: `2cad641c00948db33c286e2ea5f365a95aef4e8bc766ea51ac19fb529d275456`.
- PRE→POST patch SHA-256: `856cb89d9ce5872b19725b20cb0cba95f6061992c3a12955e5aae8fe749dbfd9`.

## Checkpoint integrity and scope

Independently reconstructed PRE in a temporary archive from HEAD plus `PRE/unstaged.patch` (the staged patch is empty). All 84 paths in the PRE manifest matched expected byte counts and SHA-256 hashes: 0 missing, 0 mismatches. The PRE recorded HEAD matches live HEAD. Independently checked all 84 POST manifest paths against live files: 0 missing, 0 mismatches. POST manifest and delta patch hashes match their recorded values. The PRE→POST delta lists exactly:

- `app/src/components/channels/chat-transcript.tsx`
- `app/src/components/channels/conversation-view.tsx`
- `app/src/components/channels/group-chat.tsx`

The only changes are 720px reading/composing column and consistent 16px horizontal insets. Transcript retains its internal scrolling; the conversation composer remains a shrink-0 bottom flex item; group transcript retains its internal overflow-y scroll and its composer stays shrink-0. No event, route, identity, or API wiring changed in this delta. This statically matches the T07 layout contract and is consistent with P01–P05's preservation requirements. The 48px top bar and 880/960 thresholds are outside these three changed components and were not browser-measured here.

## Verification evidence

Same-POST-hash reports were reused after verifying every POST manifest path against the live files:

| Check | Command / result |
|---|---|
| Native suites | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-native bunx e2e run --config e2e.unit.config.ts app/tests/channel-event-patch.test.ts app/tests/channel-label.test.ts app/tests/channel-menu-mutations.test.ts app/tests/channel-order.test.ts app/tests/channel-search.test.ts app/tests/channel-socket-message.test.ts app/tests/channel-unread.test.ts app/tests/composer-attachment-strip.test.tsx app/tests/composer-attachments.test.ts app/tests/composer-collapse.test.tsx app/tests/composer-rejected-files-gap.test.tsx app/tests/composer-rejected-files.test.tsx app/tests/computer-driving-local-fields.test.tsx app/tests/computer-handoff-rejoin.test.ts app/tests/computer-preview-visibility.test.tsx app/tests/computer-reset-clears-activity.test.ts app/tests/mark-open-channel-read.test.tsx` — report exit 0, 17 files, 124 selected/executed/passed, 0 failed or skipped. |
| Driven part 2 | `E2E_BUN_ONLY='app/tests part 2' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part2 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0, selected driver passed. |
| Driven part 3 | `E2E_BUN_ONLY='app/tests part 3' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part3 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0, selected driver passed. |
| Driven part 4 | `E2E_BUN_ONLY='app/tests part 4' E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t07/final-driven-part4 bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — exit 0, selected driver passed. |
| Biome | Reran `bunx biome check app/src/components/channels/conversation-view.tsx app/src/components/channels/chat-transcript.tsx app/src/components/channels/group-chat.tsx` — exit 0, 3 clean. |
| Whitespace | Reran `git diff --check` — exit 0. |
| Typecheck | Reran `bun run --cwd app typecheck` — exit 2. Five diagnostics across three other tests: two omitted-value errors in `app/tests/ai-observability-run-steps.test.tsx`, ref callback type in `app/tests/button-native.test.tsx`, and route type errors in `app/tests/observability-route-guards.test.tsx`. No diagnostic names a T07 file. Parent reports the first two are newly confirmed T06-R3 errors and a T06-R4 repair is underway; this validation result predates that repair. |
| Build | Reused same-POST-hash `bun run --cwd app build` evidence in `build.log`: succeeded. Warnings recorded for Rollup annotation comments, mixed dynamic/static import of i18n, and chunks over 500 kB (largest listed 1.82 MB). |

The runner reports also mention existing global collection warnings for unrelated untracked `bot-subpage` and `routines-list` tests importing `bun:` under Node; these were outside selected T07 tests. Driven reports also report an unrelated server collection warning.

## Acceptance gaps and risks

No browser/runtime evidence was produced. Responsive widths and overflow, keyboard/accessibility behavior, IME, loading/empty/error/success states, send/stop/retry, recipient/group interactions, route-backed context panels and Back, computer control release, and standalone `/bot` remain unverified in a browser. This is explicitly deferred to user testing in the T07 brief; browser/real-identity acceptance is pending. Automated selected suites cover adjacent behavior but cannot establish visual or runtime acceptance. Recheck app typecheck after the in-progress T06-R4 change before treating branch-wide typecheck as passing.
