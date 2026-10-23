# R4 / T05 independent validation

**Result:** `DONE_WITH_CONCERNS`  
**Revision:** `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (workspace has no new commit)  
**Scope:** `app/src/components/routines/routines-list.tsx` and `app/tests/routines-list.test.tsx`  
**Authority:** `docs/plans/2026-10-23-b1-ocr-repair-04.md`; implementation report at `docs/plans/reports/2026-10-23-b1-ocr-repair-04-impl.md`.

## Checkpoint integrity

The pre-checkpoint hashes are in `PRE/checkpoint.sha256`. The current source and test hashes match the implementation report's final SHA-256 values:

| File | PRE SHA-256 | Current SHA-256 | Report final SHA-256 | Result |
|---|---|---|---|---|
| `app/src/components/routines/routines-list.tsx` | `7bec18a8a9c3272fcaa9b10540c940fbab5ca90a777bac4b7940f9a4b81a376f` | `9df7a3f846b2fbb9210eb171bd5a1cd37f7859900bf8c4f6489436ddc71ebb33` | `9df7a3f846b2fbb9210eb171bd5a1cd37f7859900bf8c4f6489436ddc71ebb33` | Match |
| `app/tests/routines-list.test.tsx` | `3bb505de3f85b82c83588903af31c9b0c257c549cf4de6aee4ca39c3bfbe01a6` | `81b988f8c87b6cb72974f266991be6feb67726aa51efdd2d13a08ebcad8bf24a` | `81b988f8c87b6cb72974f266991be6feb67726aa51efdd2d13a08ebcad8bf24a` | Match |

The PRE snapshot includes the test file and hash manifest; no source snapshot was present there. The source delta was inspected with `git diff` against the workspace base. Only the assigned source and test are included in the R4 diff (24 source insertions/deletions and 14 test insertions/deletions).

## Acceptance checks

- **Shared trigger, focus/touch classes, and icon in rendered DOM:** passed. The test queries the named button, checks `focus-visible:outline-2` and `pointer-coarse:min-h-11`, and verifies an SVG child. Source composes the trigger with shared `Button` (`ghost`, `icon`) and `IconDots`.
- **Schedule-specific History and Delete accessible names:** passed. The test queries `Run history for the routine scheduled Every day` and `Delete the routine scheduled Every day` by role/name.
- **Destructive Delete variant:** passed. The test observes `data-variant="destructive"` on the menu item.
- **Interaction and callbacks:** passed for opening the menu, showing the history panel's “No runs yet.” state, opening the named delete confirmation dialog, and preserving the existing selection handlers.
- **History `aria-expanded`:** deferred, consistent with the implementation report's ruling. The assigned test confirms history toggling, but does not establish a stable expanded state on the menu item after activation because menu selection closes/unmounts the menu. This remains an explicitly disclosed low-risk gap.
- **Loading/error/success and responsive/browser states:** not applicable to this narrow menu safeguard change; no route or data-state behavior changed. Coarse pointer behavior is covered by checking the rendered shared Button class path, not by a real touch-device browser run.

## Commands and results

All commands ran against the current workspace at the revision above.

| Command | Result |
|---|---|
| `sha256sum app/src/components/routines/routines-list.tsx app/tests/routines-list.test.tsx` | Passed; values match implementation report. |
| `bun test ./app/tests/routines-list.test.tsx --timeout=120000` | Passed: 1 test, 7 expectations. Emits HeroUI diagnostic: `A PressResponder was rendered without a pressable child...`; does not fail the test. |
| `bunx biome check app/src/components/routines/routines-list.tsx app/tests/routines-list.test.tsx` | Passed: 2 files checked, no fixes. |
| `bun run --cwd app typecheck` | Passed (`tsc --noEmit`, exit 0). |
| `git diff --check -- app/src/components/routines/routines-list.tsx app/tests/routines-list.test.tsx` | Passed (exit 0). |
| `git diff --no-index --check PRE/files/app/tests/routines-list.test.tsx app/tests/routines-list.test.tsx` | Exit 1 because the files differ; this is the expected comparison result and emitted no whitespace-error diagnostic. The normal scoped `git diff --check` above is the whitespace validation. |

Per `docs/verification/e2e-bun-suites.json`, the target test is in the Bun-driven `app/tests part 1` group, not the native Node collection. The implementation report records an attempted `bunx e2e run --config e2e.unit.config.ts app/tests/routines-list.test.tsx`, rejected at collection because the file is excluded from the native layer, plus an attempted group run that could not write a JUnit report for unrelated `app/tests/bot-sharing.test.tsx`. I did not repeat that broad group run; the target itself was run directly with Bun as the ADR permits for Bun-runtime execution. Thus focused behavior is independently green, but a clean e2e-driven group result is not established here.

## Concerns and risks

- The HeroUI `PressResponder` warning remains present on an otherwise passing test; assess separately if it begins affecting browser behavior.
- At the time of the initial validation, no successful e2e-driven run of the containing group was available; the follow-up below supersedes this limitation.
- The explicit `aria-expanded` expectation remains deferred as described above.

## Follow-up: final-state driven app/tests run

The final-closure driven report resolves the earlier aggregate-group limitation for R4. I read `docs/verification/workspace-redesign/final-closure-r8/driven-app-tests/report.json` without rerunning suites:

- e2e run `01a164ee-933a-7856-9562-728de2ed1c5a`, status `passed`, exit code 0; started `2026-10-22T18:45:34.094Z`, finished `2026-10-22T18:47:58.350Z`.
- VCS commit is the same workspace base, `f55d12f899883fc4a5d7bf0e8067bb500b86ee38` (dirty workspace recorded).
- The selected result `bun runtime suite app/tests part 1` passed, with no secondary errors. All six selected app/tests group results passed: 6 executed, 6 passed, 0 failed, 0 interrupted, 0 flaky, 0 skipped.
- Current R4 source/test SHA-256 values remain `9df7a3f846b2fbb9210eb171bd5a1cd37f7859900bf8c4f6489436ddc71ebb33` and `81b988f8c87b6cb72974f266991be6feb67726aa51efdd2d13a08ebcad8bf24a`, respectively—the implementation report values. Their filesystem modification times (`2026-10-23 02:27:28 CST`) precede the report file time (`2026-10-23 02:47:58 CST`), and match the recorded R4 final snapshot hashes.

This supplies the previously missing e2e-driven group evidence for the unchanged R4 test/source snapshot. The standalone HeroUI diagnostic and the `aria-expanded` deferral remain as previously recorded.
