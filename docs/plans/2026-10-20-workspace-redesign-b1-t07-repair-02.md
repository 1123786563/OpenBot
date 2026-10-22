# T07 Review Repair 02 — Align Home Hint and Error Rows

- **Source:** `docs/plans/reports/T07-R1-review.md`, T07-S1 medium. The current POST shows the Composer at 720px but its fallback hint, send error, and load error at 672px.
- **Parent:** T07 main plan and T07-R1 repair. No scope expansion.
- **Goal:** make all four P01 home input-column elements use the same 720px maximum, preserving existing full-width behavior, padding, content and conditions.
- **Owner/sequence:** one serial `frontend_implementer`, then independent validator and reviewer. No commits. T08 remains gated.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t07-r2/PRE/` captures the current home route and Git state before edits.

## Owned path

| Path | Allowed change |
|---|---|
| `app/src/routes/_authed/_app/index.tsx` | Change only the three `max-w-2xl` classes on fallback hint, send error and initial-load error rows to `max-w-[720px]`. Composer already has the 720px class from R1. Keep each existing `w-full`, condition, padding, copy and behavior unchanged. |

## Verification

Run the Home fallback driven group (ADR 0008 part 3), changed-path Biome and `git diff --check`; use valid in-repo `E2E_UNIT_OUTPUT`. Capture the current R1 source as PRE and the exact R2 delta. Re-run app typecheck after T06-R5. Independent Spec/quality review must confirm all P01 Home column elements align in source; browser sizing remains pending user testing.
