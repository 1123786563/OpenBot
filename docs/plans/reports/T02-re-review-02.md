# T02 repair round 2 independent re-review

Reviewed 2026-10-20 in `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`. Scope: T02-R3 residual Dialog utility syntax and T02-R5 InputGroup multiline/stacked height preservation only. No source/test edits, test runs, browser checks, commits, or subagents. This report is the sole written artifact.

## Package identity and limitation

Independently SHA-256 checked both live files and both POST-R2 source copies against `POST-R2/checkpoint.json`; all four comparisons match:

- `app/src/components/ui/dialog.tsx`: `b0c753541d32c6a2bfb9919f1e34d0bf720bfa6ce175d198af735e554cd115c0`.
- `app/src/components/ui/input-group.tsx`: `1e0e037d90ef7c93e1b4390e0c112b7b5b0f78083a0587cb160522e9590d9777`.

PRE-R2 has a manifest and full tracked patches but lacks source snapshots. A content-derived, hash-bound PRE-R2→POST-R2 delta is therefore unavailable; the repair plan's capture requirement was not met. This review does not claim otherwise. As supplementary context, comparing the preserved POST-R1 copies against current files shows only the two utility changes and Dialog comment corrections described below; that comparison is not a substitute PRE-R2 checkpoint. Verdicts apply to the inspected, hash-identified POST-R2 source and the narrow repair acceptance, not certification of the missing PRE package.

## Findings and repaired contracts

No new source-level critical/high/medium/low findings in the scoped changes.

**T02-R3 residual — ADDRESSED at source/compiler level.** `dialog.tsx:387` now uses single leading important markers for maximum height and maximum width, and `dialog.tsx:388` does so for the default width. An independent, in-memory probe with the installed Tailwind compiler reports v4.3.3 and emits these exact declarations:

```css
max-height: calc(100dvh - 32px) !important;
max-width: calc(100vw - 32px) !important;
width: min(512px, calc(100vw - 32px)) !important;
```

The probe used `compile('@theme { --spacing: 0.25rem; } @tailwind utilities;')` and `build()` with the three current Dialog candidates plus the InputGroup candidates below; Node exited 0 and created no artifacts. This confirms the corrected syntax emits rules, unlike the prior double markers. `size = "lg"` at line 351 and the `size === "lg"` condition at line 388 retain the explicit 512px default. Other capped sizes retain their HeroUI width choice subject to the viewport maximum; caller classes remain passed last. The unchanged `capped` condition at line 361 excludes both `full` and `cover` from margin/width/height bounds. The stale 85svh comments have been corrected. No event/ref/portal or size prop logic changes appear in this repair.

**T02-R5 (previously T02-R1-N1) — ADDRESSED at source/compiler level.** `input-group.tsx:14` replaces both coarse important fixed height/minimum rules with `pointer-coarse:min-h-11`. The same independent probe emits its 11-spacing-unit minimum under `@media (pointer: coarse)` and retains `height: auto` for direct textarea and block-start/block-end addon variants. The coarse rule sets no height, so it no longer overrides those auto heights. Base `h-9 min-h-9` stays in place for fine pointers; the coarse minimum raises the ordinary single-line floor to 44px with the app's 0.25rem spacing, while textarea/stacked content can grow. Existing composition and forwarding logic are unchanged.

## Verdicts

**Spec compliance: PASS for the two scoped source-level repairs.** Both residual contracts are represented by valid emitted utilities and preserved size/composition branches. The missing PRE-R2 snapshots remain a documented evidence-package deficiency; no hash-bound PRE→POST certification is asserted.

**Code quality: PASS for the scoped POST-R2 source.** No new source-level regression found in the utility syntax or InputGroup height changes. Existing broader lint/test concerns in `T02-impl.md` are not recertified by this narrow review.

Browser computed geometry remains deferred to the user's testing by instruction. No rendered width, height, clipping, custom-size geometry, or interaction acceptance is claimed here.
