# T05-R1 Final Independent Validation

- **Result:** `DONE_WITH_CONCERNS`
- **Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`); worktree dirty as expected.
- **Final checkpoint:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/FINAL/`
- **POST manifest SHA-256:** `afeed9f4d663c304fe2f6e988b1dead1e7c32bef8d44f9958fca73088d7f7f53`.

## Checkpoint integrity

Recomputed SHA-256 on PRE and POST manifest JSON files; PRE is `7a8676683b75542d3996665a7ee6c7cb76043359fd8ea11d8ad4e75b5f7ec7dd`, POST matches the assigned SHA above. Both manifests contain the same nine scoped paths. Recomputed all nine live path digests and compared existence, byte length, and SHA-256 to POST: **9/9 match**. PRE absent sentinels for the two new test files were respected. `FINAL/delta.patch` covers the scoped PRE→POST changes; its SHA-256 is `dca7edcd93f0ef5a48c206e21c431e510de84fafffcc4966b9c2f355017acca4`.

## Verification evidence

- `bun test ./app/tests/bot-subpage.test.tsx ./app/tests/bot-reaching-you.test.tsx ./app/tests/routines-list.test.tsx` — **exit 0; 9 passed, 0 failed, 33 assertions**. Covers retained child state following failed Bot refetch, Bot-scoped A→B→A SMS behavior, and routine History/Delete menu actions. Harness emitted HeroUI `PressResponder` and missing-visible-label warnings while rendering the SMS test.
- `E2E_BUN_ONLY='app/tests part 1' E2E_UNIT_OUTPUT=.e2e/t05-r1-final-independent bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` — **exit 0; selected Bun driver group passed (1/1)**. Current report: `.e2e/t05-r1-final-independent/report.json`, run `01a15a4c-9925-794a-97f2-9ffdb0fcff2c`, same HEAD. Five files failed only in the shared process and were individually rerun successfully by the harness, including `bot-reaching-you.test.tsx`. `bot-subpage` and `routines-list` are now in the current driven manifest; the Node collector's expected `bun:` collection skips for those entries do not replace the Bun driver run.
- `bun run scripts/e2e-coverage-audit.mjs` — **exit 0**: 1,077 files; 603 native, 459 Bun-driven, 10 engine, 5 named exclusions; no gaps.
- `bunx biome check app/src/components/bot-profile/bot-subpage.tsx app/src/components/delivery/reaching-you.tsx app/src/components/routines/routines-list.tsx app/src/locales/en/routines.json app/src/locales/zh-CN/routines.json app/tests/bot-subpage.test.tsx app/tests/bot-reaching-you.test.tsx app/tests/routines-list.test.tsx` — **exit 0**, 8 files checked, no fixes.
- `bunx tsc --noEmit --project app/tsconfig.json` — **exit 2**, one existing unrelated TS2322 at `app/tests/button-native.test.tsx:54` (callback ref returns `HTMLButtonElement | null`). No T05-R1 paths are named in the diagnostic.

The initial command with `E2E_UNIT_SCOPE=app` added returned `NO_TESTS` because that scope excludes the root `tests/bun-suites.test.ts`; rerunning without the restrictive scope produced the passing driven result above. A direct `bun test ./tests/bun-suites.test.ts` is unsupported here and failed collection on Bun's missing `node:module` `registerHooks`; it is not treated as product evidence.

## Acceptance and limits

T05-S1, S2, and S3 have matching current source/test evidence and the exact final hashes. Component tests establish behavioral states and menu semantics. Browser behavior, visual responsive geometry, and browser keyboard focus were explicitly deferred; no browser or full-app visual acceptance is claimed. The HeroUI accessibility warnings are recorded, but this run did not establish that they originate in the changed controls. TypeScript remains blocked by the unrelated baseline diagnostic above.
