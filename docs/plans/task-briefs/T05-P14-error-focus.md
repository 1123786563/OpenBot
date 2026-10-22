# Task Brief — T05 P14 Publish Save-Error Focus

Repair the reproduced keyboard-focus loss after a rejected Team Bot publication save. Plan: `docs/plans/2026-10-21-workspace-redesign-p14-error-focus.md`. Owner `frontend_implementer`; workspace is current worktree, BASE `203d0f0244b2f898218fa12027089c631e8448d9`; no commits.

Production file ownership: `app/src/components/bot-profile/sharing.tsx` only. Existing dirty content is preserved. PRE at `docs/verification/workspace-redesign/b1-share-failure/checkpoints/PRE/`. Finding evidence is in `docs/verification/workspace-redesign/b1-share-failure/INITIAL_BROWSER_FINDING.md` and `browser-validation.json`.

Acceptance: synthetic 503 leaves exact selected audience and typed recipient values plus alert; focus returns inside Audience control; Escape closes and returns focus to Audience trigger; no intercepted request reaches API. Keep success close behavior. Run scoped Biome, app typecheck and diff check. Do not OCR or write database/publication data.
