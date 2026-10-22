# T05-R1 S1 regression test report

## Scope

Added the assigned public behavioral regression only. The test renders production `BotSubpage` within a real TanStack Query client/router, loads an agent profile through the real query function, edits child-local state, invalidates the detail query, then makes the background HTTP request fail. It asserts the error is announced and the same mounted child/input retains its draft.

The e2e Bun driver manifest registers `app/tests/bot-subpage.test.tsx` in `app/tests part 1`. PRE recorded the test path as absent with the empty sentinel SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

## Verification

- Initial failure evidence is not reliable: the test used `fireEvent.change` and only asserted the input DOM property. That did not establish that the child's React state had updated.
- Replaced it with `userEvent.type` and a visible `<output>` bound directly to the child's `useState`. The test now asserts that output equals `Keep this draft` **before** invalidating/refetching.
- `bun test ./app/tests/bot-subpage.test.tsx` — **pass**, 1 test / 7 assertions. The visible React state and draft survive the failed background refetch, and the input node identity is preserved.
- Conclusion: the former RED was a test interaction/evidence defect, not proof of a mounted-child reset. No production change is justified by this test run. Coverage audit and Biome were not run; this diagnostic was limited to the targeted test.

## Checkpoint delta

Diagnostic checkpoint: updated `app/tests/bot-subpage.test.tsx` to verify React state with a real user interaction and visible state output. The existing manifest entry and setup were left unchanged. No production code or other test files were edited by this diagnostic; no commit made.

## Finding / handoff

The corrected test confirms genuine React state updates before refetch, and that state survives the failed refetch. The earlier observed blank DOM value was not reproducible with a real user interaction. No production root cause was found; do not infer remounting from the invalid earlier check.

## Follow-up: Biome and exact source checkpoint (2026-10-21)

- Corrected import ordering in the test with `bunx biome check --write app/tests/bot-subpage.test.tsx app/src/components/bot-profile/bot-subpage.tsx` (Biome reported one file fixed).
- Removed `agent.data!` in `BotSubpage` by assigning the query result to local `agentData` and using that value for the data checks and child render. This is a type-narrowing cleanup; no intended behavior change.
- `bun test ./app/tests/bot-subpage.test.tsx` — pass, 1 test / 7 assertions.
- `bunx biome check app/tests/bot-subpage.test.tsx app/src/components/bot-profile/bot-subpage.tsx` — pass, 2 files checked, no fixes applied.
- SHA-256 after verification:
  - `app/tests/bot-subpage.test.tsx`: `5beb45f25fac3ce72e5e40ac7c3191badac7e3b19a389d16a6ba41628b1c5a80`
  - `app/src/components/bot-profile/bot-subpage.tsx`: `ff40349b94a0db737dd85058f927cb4ee11cd26a85b4e2ce2a7a4155cc2932aa`
- No commit made.
