# T03 Authorized Conversation Listing Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure revoked newer legacy mappings cannot displace still-authorized older conversations from the bounded enterprise list.

**Architecture:** Apply active resource and principal read-grant eligibility in the candidate SQL query before the 100-item limit. Keep resource and legacy advisory locks plus the post-lock re-read so a concurrent revocation cannot leak a row selected before its grant was removed.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, guarded enterprise test database.

**Spec:** Approved migration design §5–§6 and §10, AC-05; parent migration plan Task 3; R3-1 repair plan; independent review finding R3-1-Q01.

## Global Constraints

- Preserve HEAD `508800cf2c54f6eba2f3cf52ff897b198a92c714`, all uncommitted T03/R3-1 changes, and unrelated `.DS_Store`; no commit or stash.
- Use only a fresh guarded reserved database on `openbot-enterprise-test-pg`, synthetic fixtures, three transient capability logins, zero-row cleanup proof, and teardown; never use `DATABASE_URL` as a test fallback.
- Do not grant online table UPDATE permissions or alter schema/migrations.
- Preserve T02 resource shared advisory locking, sorted legacy-channel shared locks, lock order, and re-read authorization after locks.
- A revoked or absent resource must remain excluded; list completeness does not grant access.
- T17 continues to own trusted production route wiring and legacy history dispatch.

## Review Focus

1. More than 100 newer revoked/missing-resource mappings must not hide an older conversation that still has an active resource and current read grant.
2. Revocation between candidate selection and lock acquisition must be rechecked after the shared resource lock and excluded from the returned list.
3. Resource and channel lock order remains deterministic, with no UPDATE grants or schema changes.

---

## Worktree and checkpoint

Worktree: `/Users/wuyongjun/.codex/worktrees/trpc-intelligence-migration/OpenBot`; source checkpoint is R3-1 after snapshot `snapshots/r3-1-after.json` SHA-256 `39db843454b54678a5166395235c56c36142b6d0cda513538ce1f86772baeaae`; parent commit remains `508800cf2c54f6eba2f3cf52ff897b198a92c714`. R3-1 review finding: `.superpowers/sdd/2026-10-10-trpc-intelligence-t03-review-fixes/reports/task-r3-1-review.md` (`R3-1-Q01`). T03 remains running; downstream T04 stays pending.

### Task R3-1-Q01-1: Authorized candidates before the list bound

**Depends on:** R3-1 source checkpoint; R01–R04 changes retained. **Roles:** `backend_implementer` → `backend_validator` → `reviewer`.

**Files / ownership:**
- Modify `server/src/enterprise/conversations/service.ts` only in `authorizedLegacyList`.
- Modify `server/tests/enterprise/conversations.integration.test.ts` for a guarded database regression.
- No other file ownership; no migration/schema change.

**Consumes:** R3-1 `authorizedLegacyList(tx, scope)` and its T02 resource / legacy channel locking and re-read protocol.

**Produces:** At most 100 newest *authorized* legacy conversation rows, with grants/resources filtered before the SQL limit and current authorization rechecked after locks.

- [ ] **Step 1 — RED:** Add a real PostgreSQL test with one older authorized legacy mapping and at least 101 strictly newer legacy mappings whose channel memberships remain but whose enterprise resource/read grants are absent. Assert `list(scope)` contains the older authorized thread and omits every denied thread. Assert the initial and final fixture states, and restore/delete all synthetic records in `finally`.
- [ ] **Step 2 — Confirm RED:** Run the focused suite on a fresh guarded database. The baseline must fail because the older authorized conversation is missing while setup confirms its active resource/read grant and newer mappings are denied. Setup/import errors do not count.
- [ ] **Step 3 — Implement:** Add inner joins/conditions for same-tenant and workspace active `channel` resource plus the current principal's `read` grant to the candidate query before `.limit(100)`. Keep deterministic `updatedAt DESC` ordering, current candidate/resource key ordering, shared channel locks, post-lock re-read, and final cap. Do not promote grants, add unbounded list behavior, or bypass authorization on missing/denied resources.
- [ ] **Step 4 — Green:** Rerun the full enterprise conversation integration suite on a new fresh guarded database; expected all tests pass, including the >100 candidate case, with fixture rows zero before teardown and DB/logins removed afterward.
- [ ] **Step 5 — Static checks:** Biome on changed files, scoped strict typecheck, `git diff --check`, and `drizzle-kit check`; expect no schema change. Record the known unrelated server typecheck diagnostic if present.
- [ ] **Step 6 — Checkpoint and gates:** Capture full-content exact package/snapshot. Backend validator and reviewer inspect the same checkpoint; reviewer states Spec and quality separately. Keep T03 running until both pass. Any new C/H/M issue requires another numbered SDD fix plan.

**Acceptance / failure handling:** The list returns an older authorized row despite 101+ newer revoked/ineligible mappings; every denied row stays absent; post-lock grant revocation is still observed; all prior R3-1 tests pass; database and role cleanup prove no fixture residue; independent exact-hash validation and review pass. If fixtures cannot reach 100+ resources without violating current constraints, explain with concrete PostgreSQL limits and do not weaken the regression requirement.
