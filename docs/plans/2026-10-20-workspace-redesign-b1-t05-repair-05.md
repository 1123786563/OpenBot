# T05 Repair 05 — Prove the UI Creates a Fresh Pending Challenge

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1-t05-repair-04.md`.
- **Finding:** low T05-R4-Q1 in `docs/plans/reports/T05-R4-review.md`. An earlier Bot navigation test can leave the same challenge tuple in sessionStorage, allowing the UI-start test to accidentally reuse stale state.
- **Goal:** ensure the A→B→A conversation test begins with no stored challenge and proves the Send verification code action creates the exact challenge it later resumes/confirms.
- **Owner/order:** one `frontend_implementer`, then validator and independent reviewer; no commits.
- **Owned path:** `app/tests/bot-reaching-you.test.tsx` only.
- **Required delta:** clear `openbot.reachability.pendingSms` before rendering the test and assert it is absent before send; after send assert the expected new tuple and request; retain switch/return/confirmation assertions. If needed return a distinct challenge ID in a test-local response only. No production source change.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r5/PRE/`.
- **Verification:** e2e driven app/tests part 1, single-file diagnostic if required, scoped Biome and diff-check. Preserve and disposition the exact pre-R3 shared process warning set and `bun:` collection skip.
