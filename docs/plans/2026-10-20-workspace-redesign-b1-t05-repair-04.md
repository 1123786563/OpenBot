# T05 Repair 04 — Exercise SMS Conversation Switch From the User Flow

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1-t05-repair-03.md`.
- **Finding:** low T05-R3-Q1 in `docs/plans/reports/T05-R3-review.md`. The A→B→A test seeds `sessionStorage`, so it does not prove the start-code action stores a pending challenge before conversation switching.
- **Goal:** drive the new A→B→A regression test through the real UI sequence: open SMS, choose conversation A, enter phone, send code, assert the persisted challenge A, switch to B (hide challenge, keep A record), return to A (restore code form), confirm original challenge ID.
- **Owner/order:** one `frontend_implementer`, then validator and independent reviewer; no commits.
- **Owned path:** `app/tests/bot-reaching-you.test.tsx` only. No source change.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t05-r4/PRE/`; capture test file, HEAD/status/hash.
- **Verification:** e2e driven app/tests part 1, one-file Bun diagnostic if needed, scoped Biome and diff-check. Driver warning/shared-process files and collection skips must be reported exactly and compared with available pre-R3 group evidence. No browser claims.
- **Failure handling:** keep start-SMS API request and confirmation assertions; do not weaken the test or bypass the UI with storage setup.
