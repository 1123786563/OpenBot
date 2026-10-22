# T08 Verification Repair 02 — Align Migration Regression Assertions

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1-t08.md`; extends T08-R1 only after locale repair.
- **Evidence:** final app native verification reports two failures in migration-touched tests. `item-disabled.test.tsx` asserts the retired `disabled:opacity-50` class while T02 intentionally maps disabled rows to explicit disabled foreground and opacity 100. `detail-panel.test.tsx` added a pending scheduled-task presenter whose accessible loading status now coexists with its own status output, making a generic `getByRole("status")` ambiguous.
- **Goal:** update only these stale/ambiguous assertions to verify intended accessible behavior and current design contract. No production behavior change.
- **Owner / order:** one `frontend_implementer`, followed by validator and reviewer. No commit.
- **Owned files:** `app/tests/item-disabled.test.tsx`, `app/tests/detail-panel.test.tsx` only.
- **Required changes:** in the Item test assert disabled foreground class, `disabled:opacity-100`, and disabled pointer suppression. In the DetailPanel test wait for the specific scheduled-task loading text/status (or uniquely select status) rather than generic role ambiguity; retain lifecycle assertions.
- **PRE:** captured in `checkpoints/t08-r2/PRE/` before editing; preserve all unrelated user changes.
- **Verification:** both native tests via e2e, scoped Biome on two files, diff-check. Full app native rerun after changes. Keep any other pre-existing native failures reported.
- **Failure handling:** if the existing assertions are still required by approved implementation contract, stop and document evidence; don't alter production code to appease stale tests.
