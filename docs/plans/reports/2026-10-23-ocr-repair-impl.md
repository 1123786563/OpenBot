# B1 OCR Repair — Round 2 (6 boundary fixes) implementation report

**Date:** 2026-10-23 · **Worktree:** `.worktrees/heroui-migration` (branch `feat/heroui-v3-migration`) · **Executor:** frontend_implementer

Scope: the 6 triaged-valid findings from `docs/verification/workspace-redesign/ocr/2026-10-23-b1-final.md`. All other findings in that report were ruled misroute/out-of-scope/existing-design by the coordinator and were intentionally not touched.

Evidence tree: `docs/verification/workspace-redesign/final-closure-r7/ocr-repair/` — `PRE/` (pre-repair copies + SHA-256), `POST/` (post-repair copies + SHA-256), `pre-red/` (RED run), `post-green/` (GREEN run), `native-full/`, `driven/`.

## Per-item changes

### 1. `app/public/__iso-login.html` → `scripts/iso-login.html` (security · medium)

- `app/public/__iso-login.html` was already deleted (unstaged) in this worktree; `scripts/iso-login.html` now carries the page, so the net effect equals a pure move out of the build-published `public/` directory.
- A header HTML comment states: manual use in a local isolated environment only; the Vite-proxy scenario requires starting the isolated services yourself or copying the page back into `public/` yourself; never move it back into `public/` (files there ship with every build and the page carries throwaway credentials).
- **Disclosed deviation from "content unchanged":** `scripts/` is inside Biome's lint scope (`app/spike/heroui.html` passes the same lints, so HTML files are linted), and the moved file produced 3 lint errors. Applied the minimal mechanical fixes: `lang="zh-CN"` on `<html>` and two string concatenations → template literals (Biome `useHtmlLang`, `useTemplate`). Page logic and rendered output are unchanged.

| file | PRE SHA-256 | POST SHA-256 |
|---|---|---|
| login helper | `2f16834e10d6afd25a2be6c5c6f61f5f9aff5e60ac8ad62534f973b5e91f400d` (`app/public/__iso-login.html`, from HEAD) | `67a7a179d89e7f7440b7a7d4c68bf9418d3e3489053e9a134c6af563d37ea00e` (`scripts/iso-login.html`) |

### 2. `app/src/components/ui/checkbox.tsx` dead class (bug · high → dead-class removal per triage)

- Removed `"ob-checkbox"` from the wrapper `className`; the prop now forwards as `className={className}` (matching the file's other call sites, which pass plain strings). Dropped the now-unused `cn` import.
- Comment explains why: the class never named a stylesheet rule anywhere in the app, so the control wears HeroUI's default visuals plus whatever the caller passes.
- No test or style referenced `ob-checkbox` (verified by repo-wide grep before removal).

| file | PRE | POST |
|---|---|---|
| checkbox.tsx | `200515f02dba8a5f9319a7fc2f32463ca9cb7f6e2e4223e11b0f1793daa3763b` | `16635063d153c45471bcca241a6b108aea80af21d586a926086e9fa85c76b82e` |

### 3. `app/src/components/ui/switch.tsx` false theme claim + ref churn (bug · high, performance · medium)

- Checked `docs/design/2026-10-20-workspace-redesign/handoff/refinement/theme-contract.json`: it defines no switch track dimension (no 32×18.4) and no teal ON colour — `--ob-brand` maps to `--ob-action` (blue `#315FCF`). **No hard contract exists, so the "HeroUI default is the contract" branch was taken:** the dead `ob-switch` class was removed (`className={className}`), and the header comment now states the truth: the switch wears HeroUI's default visuals as themed by the `--ob-*` variables in `tokens.css`, and the app layer adds no track-size/on-colour override. No new CSS was introduced, so the rendered appearance is bit-identical to before the repair (the class never had a rule); no browser visual re-check is required on that account.
- `inputRef` inline callback → `useCallback`-stable `connectInput` (deps `[ariaLabel, id, inputRef]`; `hiddenInput` is a stable ref and Biome flags listing it). Reason documented in code: React re-runs a changed ref with `null` + element every render, and the callback registers the uncontrolled-mirror `change` listener, so the inline version stacked one more listener per render. Listener behaviour is unchanged (same registration, H14 note preserved).
- Also fixed: the PRE file passed Biome; POST does too.

| file | PRE | POST |
|---|---|---|
| switch.tsx | `207ee518a00b122ef47dbfdf61478173b918c4f585821e8a29b2ad0d89c793f7` | `ce8714b2660308944259c549c8a722ba2042e7c1b74d188c1a6d5fa64ce161c9` |

### 4. `app/src/components/ui/field.tsx` dangling `aria-describedby` (bug · medium)

- Mirrors `app/src/components/ui/dialog.tsx`'s `DialogDescriptionContext` pattern: `FieldContext` now carries `{ errorId, setPresent }`; `FieldError` claims the slot in a `useEffect` for exactly as long as it renders content (`setPresent(true)` on mount, `setPresent(false)` on cleanup; hooks stay ahead of the `null` early return, and an empty `FieldError` renders nothing so it registers nothing).
- `Field` composes `aria-describedby` with `errorId` only when `invalid && hasError`. Existing behaviour preserved: whenever a content-bearing `FieldError` renders, `aria-describedby` still contains the same errorId (covered by the pre-existing `ui-wrapper-merge.test.tsx` assertion, still green).
- Not changed on purpose: a `FieldError` with a caller-supplied custom `id` still registers presence while `aria-describedby` names `errorId` — that mismatch predates this repair and the task scoped the fix to the dangling-id case ("存在标志" option from the finding).
- New focused test `app/tests/field-describedby.test.tsx` (2 tests): invalid without `FieldError` → `aria-describedby` has no invented id; invalid with rendered `FieldError` → contains `existing` + the alert id; empty `FieldError` (`errors={[]}`) → renders no alert and no describedby.

| file | PRE | POST |
|---|---|---|
| field.tsx | `89e0fb6b8f22cb239a64cc5e112a4a0c366b3c3f53fe539886b52ccf906eec73` | `d8b80f608731ee609b3e2bab7cd3fb0dd4f53f4a81986e740cb6eb668fef112b` |
| field-describedby.test.tsx (new) | — | `56c6feebe9dedb3514480dadb3b4ad48c5330209dbfc939f3437032c02e4b791` |

### 5. `app/src/components/ui/combobox.tsx` trigger never closed (bug · medium)

- Trigger `onClick={() => setOpen(true)}` → `onClick={() => setOpen((value) => !value)}`, with a comment explaining why toggle is safe: React Aria excludes the popover's own trigger from outside-press dismissal, so without toggle the open list could never be closed from the trigger. `open` is single-source (`useState` + the Popover's `onOpenChange={setOpen}`), so the functional toggle is the minimal change and the keyboard path (input autofocus, Escape via RAC) is untouched.
- Existing combobox-touching tests grepped: no test asserted the always-open behaviour; `channel-new-recipients.test.tsx` clicks the trigger from the closed state (unchanged behaviour). No assertion required modification.

| file | PRE | POST |
|---|---|---|
| combobox.tsx | `0a0f3eb7d9bd74747d078226442ea73b3eed14029a9ea3cf2e3152a367ff1649` | `142680b8e15cbd86665cfe23d9c3adff1c97aee74b8e575da93ac6a4a97135c5` |

### 6. `app/src/routes/_authed/_app/skills.tsx` edit-target switch reuses the form instance (bug · high)

- **RED first:** new focused test `app/tests/skills-edit-target.test.tsx` drives the production route component through the public router seam (same harness as `skills-draft-lifecycle.test.tsx` — no hand-planted `key`): load `?edit=alpha`, dirty the title, `router.navigate` straight to `?edit=beta`, assert beta's title shows and the save POST payload belongs to beta. Pre-repair run failed with exactly the OCR defect: `expected "Alpha skill (dirtied)" to be "Beta skill"` (`ocr-repair/pre-red/…skills-edit-target…/trace.md`).
- **Minimal fix applied:** `<EditSkill key={editingSlug} …>` (direct target switches remount the form, so `useForm` re-reads beta's defaults) and `<NewSkill key="new" …>` for symmetry. Route-level draft semantics untouched (draft still keyed by `draftKey`; `currentDraft` still matches by key, so alpha's saved draft is not fed into beta).
- **GREEN after:** test passes; the POST payload is `{ slug: "beta", title: "Beta skill" }` and `data-dirty` resets to `"false"` on the fresh form.

| file | PRE | POST |
|---|---|---|
| skills.tsx | `f7cbfb4973ec7009d862d1c8ab7313542ccf4a9447f572b219f71b5eef73e9f6` | `31226c5d3cded59bd4aecf25af7d791b58df14b44449434c1c00cb962db89e20` |
| skills-edit-target.test.tsx (new) | — | `71fa9bf3db8950e4db7294ec2f89370b2951701acb119b9e9ce848e5dd0bc097` |

### Whole-file formatting disclosure

`combobox.tsx` and `field.tsx` were reformatted/import-sorted by `bunx biome check --write` (safe fixes only). Both PRE copies already fail Biome in this worktree's uncommitted migration state (verified against `PRE/` copies), so the gate "biome green on changed files" required the mechanical formatting; no semantic edits beyond the ones listed above.

## Verification (all green)

| # | command | result | exit |
|---|---|---|---|
| 1 | focused tests (`e2e run … app/tests/field-describedby.test.tsx app/tests/skills-edit-target.test.tsx`) | pre-repair RED 0/3 (two dangling-id failures + `"Alpha skill (dirtied)" to be "Beta skill"`), post-repair **3/3 pass** (`post-green/`) | 0 |
| 2 | `bunx biome check` on all 8 changed files | clean | 0 |
| 3 | `bun run --cwd app typecheck` | clean (`tsc --noEmit`) | 0 |
| 4 | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/ocr-repair/native-full bunx e2e run --config e2e.unit.config.ts` | **1014/1014 passed, 134 files** (floor was 1009; +2 new test files) | 0 |
| 5 | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=…/ocr-repair/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **6/6 passed** | 0 |
| 6 | `bun scripts/e2e-coverage-audit.mjs` | 1082 suite files, 605 native / 462 driven / 10 engine / 5 named exclusions — **no gaps** (count includes the 2 new test files) | 0 |

## Delivery summary

- **Files changed (existing):** 5 — `checkbox.tsx`, `switch.tsx`, `field.tsx`, `combobox.tsx`, `skills.tsx`; plus the in-worktree deletion of `app/public/__iso-login.html` retained.
- **Files added:** 3 — `scripts/iso-login.html`, `app/tests/field-describedby.test.tsx`, `app/tests/skills-edit-target.test.tsx`.
- **Verification status: 6/6 green.** Item 6 was RED before the fix and GREEN after (evidence in `pre-red/` and `post-green/` traces); item 3 resolved on the "no hard theme contract" branch, so no browser visual re-check is pending.
