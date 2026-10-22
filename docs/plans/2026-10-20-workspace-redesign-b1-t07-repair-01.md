# T07 Review Repair 01 — Align the Home Composer Width

- **Source:** `docs/plans/reports/T07-review.md`, finding T07-S1 (medium).
- **Parent:** T07 plan `docs/plans/2026-10-20-workspace-redesign-b1-t07.md` and B1 implementation plan Task 7.
- **Goal:** align P01 home primary Composer to the approved 720px maximum input column; preserve current responsive outer padding, send behavior, and state.
- **Scope:** one existing T07-owned home route only. No API/route/message flow changes. No commits.
- **Owner/sequence:** one serial `frontend_implementer`; then targeted validation and independent reviewer. T08 remains gated.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t07-r1/PRE/` captures the one source path and current Git state before repair.

## Owned path

| Path | Allowed change |
|---|---|
| `app/src/routes/_authed/_app/index.tsx` | Change only the P01 primary Composer `max-w-2xl` to `max-w-[720px]`; existing hint/error rows are already 720px. Preserve `w-full`, padding, component behavior and all surrounding state/event logic. |

## Verification

Run the P01-relevant native suite and the corresponding ADR 0008 driven group if applicable; run changed-path Biome and diff-check. Capture exact PRE→POST patch and hash. Independent reviewer must specifically confirm P01 Home is within the 720px contract. The earlier T07 native/driven/build evidence remains valid for unchanged source paths; app typecheck must be rerun after the separate T06-R4 fixture correction.

## Failure handling

Do not alter layout beyond the stated width alignment. If the hint/error rows are conditionally rendered outside the current width wrapper, inspect actual structure and keep them aligned using the existing seam. Browser sizing/zoom/viewport/keyboard acceptance remains pending user testing.
