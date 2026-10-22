# T03 Review Repair 03 — Test Production Craft Draft Ownership

> **Execution:** scoped SDD test-seam repair for `docs/plans/reports/T03-R2-review.md` finding R2-Q1. One `frontend_implementer`, no commits.

**Parent:** T03 and repair plans 01/02. **Input increment:** `checkpoints/t03-r2/delta.patch`, SHA `07112110f7c895f1df16dd05188c82d9efe9d5b74a7ef2477aaac96500dbe687`.

## Finding

- **T03-R2-Q1 (medium):** current behavior test reproduces the same `key` expression by hand, so it does not test production route-owned `editorKey` selection; it also starts A untouched and does not test dirty draft isolation. A future deletion/misrouting of the production key would leave it green.

## Task R3

- **Owner / validator / reviewer:** `frontend_implementer` / `frontend_validator` / `reviewer`.
- **Scope:** only the production Craft route-owned draft ownership seam and its behavior test. Preferred approach: extract the current route-owned editor/detail presenter into a small shared component used by `CraftTasksPage` and the test, keeping the state owner above `DetailPanel` and the real `ScheduledTaskEditor`. Do not duplicate the key logic in the test. Touch `ScheduledTaskEditor` only if required to expose existing typed props; no API/data protocol/storage changes.
- **PRE/POST:** capture every changed source/test path, full content/hash/bytes, HEAD, full status and staged/unstaged patches; save under `checkpoints/t03-r3/`, produce a reversible PRE→POST delta.
- **Required RED→GREEN cases:**
  1. Render the same production presenter used by Craft route with task A. Resolve A, edit a field so it is dirty, resize actual DetailPanel at 880→879→880 using the ResizeObserver test helper, and assert A's entered value and dirty state remain after branch changes.
  2. Change route-owned presenter props from A to B (no test-authored `key`). Resolve B; assert B's loaded name/prompt are shown, A's dirty values are absent from B, save targets `/B`, and the mutation payload contains B values only.
  3. Keep the existing pending query across breakpoint case; assert actual inline→Sheet→inline before resolving and then loaded data seeds.
- **Verification:** run the targeted native file via ADR0008 and scoped Biome; exact counts/exits and same-hash artifact. No browser checks; user deferred rendered acceptance.
- **Acceptance:** tests fail if the production route-owned identity/key/draft-selection seam is removed or incorrectly passes A's draft to B. Same-identity dirty state survives actual branch remount. No duplicated test-only key expression; no storage/protocol changes.

## Review focus

The test and production route must exercise the same owner/presenter; A dirty → same-ID resize → value+dirty retained → B identity → B loaded and B-only save. The test cannot encode the fix independently of the production path.
