# T08-R2 Independent Validation

- Revision: `203d0f0244b2f898218fa12027089c631e8448d9` (workspace HEAD; uncommitted tree).
- Status: **DONE_WITH_CONCERNS**. The scoped assertions match the current implementation and the required focused checks pass. The implementation report's POST hashes are confirmed; its PRE hashes cannot be independently reproduced from a preserved T08-R2 PRE snapshot in the current verification tree.
- Scope: only `app/tests/item-disabled.test.tsx`, `app/tests/detail-panel.test.tsx`, T08-R2 repair plan, implementation report, and directly referenced UI contracts/components. No source or test files were modified by validation.

## Checkpoint hash verification

`sha256sum app/tests/item-disabled.test.tsx app/tests/detail-panel.test.tsx` returned:

- `ca1b99e548d345927cd693183f4f1966f63854a2c46d6994048969b4f2d4aff3` — matches report POST.
- `cb23b88c514efadd1e630a6a07db98fbf270358746d9ad8ec90b6b39dc0c5658` — matches report POST.

The report PRE hashes are `b3838484739bd6fe5fce66c1c9d59fe807b2da841ada57f92a271a8cc90e672a` and `1f0b70388eeecc16777f1a034338ce2d1a322550602f9fe081ebf87e129b66ad`. No `checkpoints/t08-r2/PRE` artifact exists under `docs/verification/workspace-redesign`; therefore the historical PRE claims cannot be independently recomputed from a retained snapshot. This is an evidence-retention gap, not a mismatch in POST.

## Assertion alignment and behavior

- `item-disabled.test.tsx` still verifies the real disabled DOM attribute and the current `Item` implementation's three classes: disabled foreground token, opacity 100, and pointer suppression. This matches the approved workspace redesign implementation spec's disabled contract (opacity 1, disabled foreground, preserve prevention of interaction) and current `app/src/components/ui/item.tsx`. Replacing the retired `disabled:opacity-50` expectation does not weaken disabled behavior; it removes an assertion for the superseded visual contract while retaining direct semantic and pointer checks.
- `detail-panel.test.tsx` scopes the pending-state lookup to `Loading scheduled tasks…` and confirms that exact element has `role="status"`, matching `CraftTaskEditorPresenter`'s pending branch. Existing resize/remount and draft lifecycle assertions remain in the test. No production behavior is changed by this assertion selection.
- Plan `docs/plans/2026-10-20-workspace-redesign-b1-t08-repair-02.md` limits changes to these two test files and calls for focused native e2e, scoped Biome, and diff-check; implementation report's change description aligns with that scope.

## Commands and results

1. `E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t08-r2/independent-native bunx e2e run --config e2e.unit.config.ts app/tests/item-disabled.test.tsx app/tests/detail-panel.test.tsx` — exit 0; 2 files, 8 tests passed. Existing PressResponder warnings appeared. The collector also repeated the unrelated known skip for `server/tests/billing-period-fulfillment.integration.test.ts` because the default ESM loader rejects its `bun:` URL.
2. `bunx biome check app/tests/item-disabled.test.tsx app/tests/detail-panel.test.tsx` — exit 0; 2 files checked.
3. `git diff --check -- app/tests/item-disabled.test.tsx app/tests/detail-panel.test.tsx` — exit 0.
4. `sha256sum app/tests/item-disabled.test.tsx app/tests/detail-panel.test.tsx` — hashes listed above.

## Acceptance gaps and risks

- No browser, accessibility-tree, or responsive-browser check was run; this repair changes assertions only, and T08's parent plan reserves rendered acceptance for later user testing. This does not affect T08-R2's scoped test repair acceptance.
- The only validation concern is the missing retained T08-R2 PRE snapshot, which prevents independent confirmation of its PRE hashes and the report's assertion that one test file was already modified at task start. The live POST files match exactly.

## Coordinator checkpoint addendum

After the initial validation, the coordinator reconstructed the dedicated PRE package from independently hash-matched authoritative sources (Item test from the unchanged HEAD blob; DetailPanel test from the preserved T03-R3 POST snapshot), captured live POST files, hashes, HEAD and PRE-to-POST delta under `execution/checkpoints/t08-r2/`. See `execution/checkpoints/t08-r2/provenance.md`. This closes the missing-package concern while retaining the fact that the package was reconstructed after the implementation rather than captured in real time.
