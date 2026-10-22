# T08 OCR Findings Review (sessions incomplete)

Date: 2026-10-21

The user instructed that OCR scans must not continue. This report records findings already returned by the aborted first session only; it is not a substitute for a completed independent OCR report.

## Disposition

| Finding | Disposition |
|---|---|
| `theme.ts`: optional `setRootTheme` weakens `.dark` / `[data-theme]` invariant | Fixed: required callback, direct call; only production and test callers both supply it. |
| `page-shell.tsx`: stale 16px radius comment | Fixed: comment describes 12px card radius. Tokenization suggestion deferred; no approved token exists in the active design source. |
| `context-menu.tsx`: no explicit viewport max height | Fixed: align with dropdown bound `max-h-[calc(100vh-16px)]`. |
| `dialog.tsx`: focus capture in effect can observe modal focus | Fixed: capture `document.activeElement` synchronously when controlled open callback receives `true`; removed effect-time capture. |
| `sheet.tsx`: relies on `undefined` handler override to disable drag | Deferred for browser verification; actual touch scrolling is a user-pending browser acceptance case. No unverified library merge semantics were guessed. |
| `combobox.tsx`: ArrowUp/ArrowDown does not bridge filter input to listbox | Deferred for browser interaction review; keyboard focus behavior needs runtime verification and was not changed from static speculation. |
| `reaching-you.tsx`: optional `agentId` mode cannot resume challenge | Rejected as false positive: call sites/tests render the per-Bot route; the component is not used as a generic chooser in this scope, so existing Bot-bound behavior is correct. |
| `scheduled-task-editor.tsx`: detail query error exposes empty editable form | Fixed: show localized error alert when detail query is in error. |
| `scheduled-task-editor.tsx`: Checkbox nested in external label | Fixed: pass visible text as Checkbox children. |
| `router-link.tsx`: `to`/`href` should be mutually exclusive | Rejected as not actionable from this finding: the general wrapper contract is pre-existing shared code, and attempted type tightening conflicted with registered TanStack LinkProps. No change retained. |
| Shared render-adapter extraction across menu/tooltip/button/etc. | Deferred: broad cross-wrapper refactor exceeds this repair's concrete behavior scope. |
| Spike and historical CDP harness findings | Not applied: test-spike / archival harness cleanup is outside T01–T08 production acceptance. |

## Evidence

- TypeScript: `bun run --cwd app typecheck` passed after fixes and route-link experiment was reverted.
- Native focused E2E: `bunx e2e run --config e2e.unit.config.ts app/tests/detail-panel.test.tsx app/tests/bot-reaching-you.test.tsx app/tests/theme-preference.test.ts app/tests/button-native.test.tsx` passed, 24 tests.
- `git diff --check` passed.
- Full driven driver rerun reached terminal result: 26/35 groups passed; 9 failing groups are server database/cleanup integration groups with isolated red assertions/query failures. App-driven groups passed. This result is recorded, not represented as a full repository pass.
- OCR sessions `79806102-7b4f-4b4b-9706-1a82fb7211c0` (188 files, 135 comments, aborted) and `9e17a873-4314-48ea-af55-44a8fc59329a` (0 files, aborted during 639-path grouping) were incomplete and produced no report. No further OCR is authorized.
- Browser acceptance remains pending user testing.

## Final bounded follow-up and independent review (2026-10-21)

The final bounded source review by the independent reviewer (`docs/plans/reports/T08-final-review-r2.md`) reports **Spec PASS / code quality PASS** for the B1 source/test scope after T05-R3/R4/R5. A separate read-only follow-up review of the Dialog controlled and nested focus restoration changes also reported both scoped findings closed, Spec PASS, and quality PASS. No OCR scan was run, per explicit user instruction.

The follow-up fixes address controlled external opener focus restoration, nested Dialog trigger restoration, and an initial scheduled-task detail load error that must not expose an empty editable form. Regression cases are in `app/tests/detail-panel.test.tsx`. Current source hashes are recorded at `docs/verification/workspace-redesign/final-r5-review/hashes.txt`; this is a POST-only checkpoint because a PRE snapshot was not captured before these follow-up edits. Latest focused regression run passed 10/10. Browser acceptance remains pending user testing.
