# T02-R6 independent review

**Scope:** Exact four-wrapper PRE→POST delta in `docs/verification/workspace-redesign/execution/checkpoints/t02-r6/review-package.patch` (SHA-256 `f4ddb50d5762a1eab7c7b63293e8dd93f2ad20255a0b9712056b24a2bdaa882e`). Reviewed the assigned brief, R6 plan and implementation report, independent validation, B1 wrapper contract, layout contract, HeroUI migration spec, ADR 0008, and `CONTEXT.md`. This is a read-only source review; no OCR or test run was performed here.

## Findings

1. **Medium — Context-menu trigger gains an accessible group against the stated presentational contract.** `app/src/components/ui/context-menu.tsx:196` adds `role="group"` to the wrapper around the actual control. The R6 plan says to mark this event surface *presentational* while preserving descendants, and the B1 contract preserves menu positioning and keyboard/focus behavior. A group is exposed as an extra accessibility node, so this is a semantic change beyond clearing the lint diagnostic. The sole current production call site wraps a `Link` (`app/src/components/app-sidebar/channel.tsx:112`); its link semantics remain, and no observed failure is established. **Smallest correction:** use a presentational role that passes Biome, while preserving any caller-supplied `role` from the existing `ComponentPropsWithoutRef<"div">` API; add a focused accessible-tree assertion only if that behavior cannot be verified from existing coverage. In the current JSX, the explicit role after `{...props}` also overwrites a caller-supplied role.

2. **Medium — Required focused behavior acceptance remains unproven.** The R6 brief requires zero failures and no new skips. The implementation and independent validation reports record 32 executed, 30 passed, 2 failed in `heroui-spike`, and `bot-setup` was not selected. The two Modal ESC failures have the same test identities as the isolated W7/H14 failures, so this is **not evidence of an R6 regression**. It still cannot support a green focused-suite verdict or prove the intended `bot-setup` coverage. **Smallest correction:** run the affected suites in the already documented passing app-scope configuration, and confirm the runner selects `bot-setup` through the ADR 0008 native/driven partition; record the exact report and exit. If the baseline reds persist only in isolation, document the acceptance exception explicitly rather than count this focused run as passed.

## Spec compliance verdict

**Not fully satisfied.** The patch is limited to the four assigned wrappers and does not change their exports, class values, event handlers, pointer coordinates, or Dialog callback logic. Button and Sheet changes are formatting only. The `useCallback` cleanup is stable, and the Dialog effect now tracks `props.onOpenChange`. The new group role conflicts with the R6 plan's presentational instruction, and the brief's focused-suite acceptance has not passed. No theme token or layout value changes appear in this delta.

## Code quality verdict

**Static check passes; quality has one bounded accessibility concern.** Independent validation recomputed the POST hashes and reran `bunx biome check` on exactly the four files with exit 0. The hook fixes are small and preserve cleanup/rebinding semantics. Existing context-menu and button behavior checks passed in the recorded run. The role change above should be resolved before calling this repair fully reviewed. The two isolated Modal failures match prior W7/H14 evidence; no new runtime regression is demonstrated by this package.

## Process and evidence boundary

The brief explicitly forbids commits. PRE records HEAD `203d0f0244b2f898218fa12027089c631e8448d9`, while POST/current HEAD is `d00e0ee144340350e676b0c759abfe1df8fc435f`; independent validation says the whole dirty worktree was committed. This is a **high-severity checkpoint/authorization violation**, separate from the four-wrapper code delta. Restore a trustworthy no-commit delivery record through the controller's authorized workflow; do not treat `BASE..HEAD` as the R6 review package. I made no Git mutation.
