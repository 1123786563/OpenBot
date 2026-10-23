# B1 OCR Repair 04 implementation report

**Task:** R4 / T05 routine action menu safeguards  
**PRE:** `docs/verification/workspace-redesign/execution/checkpoints/ocr-r4-t05/PRE/`  
**Scope:** `app/src/components/routines/routines-list.tsx`, `app/tests/routines-list.test.tsx`  
**No commit created.**

## Changes

- Render the secondary action trigger through the shared `Button` with `variant="ghost"`, `size="icon"`, and `IconDots`. This restores shared focus-visible and coarse-pointer safeguards.
- Add translated schedule-specific accessible labels for History and Delete, retaining their existing callbacks.
- Mark the Delete menu item `variant="destructive"`.
- Extend the existing behavior test to assert shared trigger focus/touch classes, icon presence, schedule-aware menu names, destructive data variant, and the existing dialog behavior.

## Verification

- `bun test ./app/tests/routines-list.test.tsx --timeout=120000` — **pass**, 1 test / 7 assertions. Emits a HeroUI `PressResponder was rendered without a pressable child` diagnostic, but test passes.
- `bunx biome check app/src/components/routines/routines-list.tsx app/tests/routines-list.test.tsx` — **pass**, 2 files checked.
- `bun run --cwd app typecheck` — **pass** (`tsc --noEmit`).
- `git diff --check` — **pass**.
- Attempted `bunx e2e run --config e2e.unit.config.ts app/tests/routines-list.test.tsx`; expected collection rejected the file because it is excluded for the native Node layer and belongs to the Bun-driven tier per `docs/verification/e2e-bun-suites.json`.
- Attempted manifest group via `E2E_BUN_ONLY='app/tests part 1' bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`; interrupted after the group failed to write a JUnit report for `app/tests/bot-sharing.test.tsx`. Target suite therefore verified directly with `bun test` instead.

## aria-expanded ruling

Deferred as low risk. `DropdownMenuItem` spreads arbitrary props to React Aria's item, but selecting an item closes/unmounts its menu before a stable exposed history state can be inspected; the test observed `aria-expanded="false"` after activating History. No menu architecture was added. The history panel still toggles through the existing callback.

## Snapshot evidence

Final SHA-256:

- `app/src/components/routines/routines-list.tsx`: `9df7a3f846b2fbb9210eb171bd5a1cd37f7859900bf8c4f6489436ddc71ebb33`
- `app/tests/routines-list.test.tsx`: `81b988f8c87b6cb72974f266991be6feb67726aa51efdd2d13a08ebcad8bf24a`

Other workspace modifications were present before and remain untouched.
