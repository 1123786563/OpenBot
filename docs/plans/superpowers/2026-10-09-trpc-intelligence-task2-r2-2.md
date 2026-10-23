# R2-2 Legacy Channel Revocation Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `canReadLegacyChannel` from returning access based on a membership observation that can be revoked before a separate Bot-visibility query.

**Architecture:** Evaluate channel membership, non-deleted channel state, and optional Bot mapping through one PostgreSQL statement. Invalid inputs and query errors deny access. Add focused tests that exercise positive/negative outcomes and inspect the actual emitted query contract to prove membership and Bot visibility share one statement.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM, PostgreSQL dialect.

**Spec:** `docs/specs/superpowers/2026-10-09-trpc-intelligence-migration-design.md` AC-05; `docs/plans/superpowers/2026-10-09-enterprise-ai-02-tenancy.md` T1-B/T1-C; repair requirement `.archive/runs/legacy-plans/superpowers-briefs/2026-10-09-trpc-intelligence-task2-review-fixes.md` Task R2-2; finding `reports/task-2-review.md` T02-R03.

## Global Constraints

- Keep this change inside the managed isolated worktree; preserve pre-existing uncommitted source changes.
- No DB operations, commits, or stash.
- Membership, channel deletion status, and optional Bot mapping must be evaluated in one SQL statement/snapshot.
- Any missing membership, deleted/missing channel, missing Bot mapping, malformed input, or DB error denies access.
- Preserve the existing boolean interface and channel/Bot visibility semantics.

## Review Focus

- Revocation between membership and Bot resolution must not allow a Bot-linked read; prove the emitted query contains both predicates and executes once.
- No-Bot checks remain membership plus live-channel checks; a missing Bot mapping denies when a Bot ID was supplied.
- Empty, whitespace-only, or malformed runtime values and query failures fail closed without a second query.
- The emitted Drizzle SQL preserves actor/channel/Bot parameters as bound values rather than interpolation.

---

### Task 1: Make legacy channel authorization a single statement

**Files:**
- Modify: `server/src/enterprise/authz/legacy-channel-scope.ts`
- Create: `server/tests/enterprise/legacy-channel-scope.test.ts`

**Interfaces:**
- Consumes: `canReadLegacyChannel(database: Database, input: { actorId: string; channelId: string; botId?: string }): Promise<boolean>` and the existing `channelMemberships`, `channels`, `channelAgents` schema.
- Produces: the same exported signature, returning true only when one SQL statement finds a current membership on a non-deleted channel and (if supplied) a matching channel-to-Bot row; malformed input or query error returns false.
- Owner role: `backend_implementer`
- Validator role: `backend_validator`
- Verification: focused Bun tests, scoped strict TypeScript, Biome, `git diff --check`.

- [ ] **Step 1: Write failing focused tests** for a live member with and without a valid Bot mapping, nonmember, deleted channel, missing Bot mapping, blank/malformed identifiers, and DB rejection. Add a query-contract test using `PgDialect` to inspect the actual SQL condition built by the helper and assert one `select` call contains channel membership, `deleted_at IS NULL`, and the optional `channel_agents` relation/predicate together.
- [ ] **Step 2: Run** `bun --no-env-file test tests/enterprise/legacy-channel-scope.test.ts`; confirm baseline fails because the new suite is absent or the current two-query helper violates the one-statement assertion.
- [ ] **Step 3: Implement** a single Drizzle query using a join/EXISTS predicate for optional Bot mapping; validate runtime identifiers and catch database errors as denial. Do not issue a follow-up membership or Bot query.
- [ ] **Step 4: Run** the focused new suite and `tests/enterprise/authz.integration.test.ts`, then scoped strict TSC, Biome and `git diff --check`. No test may connect to a database.
- [ ] **Step 5: Capture** uncommitted before/after manifests and a full-content package for both owned files; independent backend validator and reviewer must assess the same after hash before marking verified.

**Failure handling:** If a test harness cannot inspect the emitted SQL contract without a database, use a deterministic transaction/barrier test backed by a dedicated isolated fixture; do not claim a race test from mock results alone. If schema/Drizzle semantics are ambiguous, document the query contract and resolve it before implementation.
