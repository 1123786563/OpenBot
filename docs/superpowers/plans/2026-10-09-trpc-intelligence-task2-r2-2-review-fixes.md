# R2-2 Query Contract Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen the legacy-channel query test so it detects incorrect actor, channel, or Bot predicates instead of merely checking SQL tokens.

**Architecture:** Capture the SQL and bound values emitted by Drizzle's PostgreSQL proxy for both Bot and no-Bot queries. Assert exact distinct sentinel-value mapping and the relevant JOIN/WHERE relationships; keep the one-statement contract. Rename fixed-row result tests so they state only what their proxy establishes.

**Tech Stack:** TypeScript, Bun test, Drizzle ORM `pg-proxy`, `PgDialect`.

**Spec:** `docs/superpowers/specs/2026-10-09-trpc-intelligence-migration-design.md` AC-05; parent repair plan Task R2-2; independent finding `reports/r2-2-review.md` R2-2-R01.

## Global Constraints

- Preserve the verified single-statement production authorization query and public function signature.
- Do not perform DB operations, commit, or stash.
- Keep query values parameterized; never interpolate actor/channel/Bot IDs into SQL.
- Tests must verify the actual Drizzle-emitted SQL and bound values, not infer authorization from proxy-provided rows alone.
- Use distinct literal actor/channel/Bot sentinels so wrong bindings cannot alias.

## Review Focus

- Membership-to-channel ON relation and live-channel WHERE predicate remain present in both query forms.
- Bot query requires channel_agents.channel_id to equal the membership channel and agent_id to bind the supplied botId; no-Bot query excludes the Bot join and binds only actor/channel.
- Wrong actor, channel, or Bot binding makes the new contract test fail; prove with a temporary isolated mutant, then restore the production source byte-for-byte.
- Empty proxy-row tests describe result mapping only and make no claim about PostgreSQL policy evaluation.

---

### Task 1: Assert authorization predicate and parameter mapping

**Files:**
- Modify: `server/tests/enterprise/legacy-channel-scope.test.ts`
- Do not modify: `server/src/enterprise/authz/legacy-channel-scope.ts` unless verification discovers a real current defect; escalate rather than changing production speculatively.

**Interfaces:**
- Consumes: Existing `canReadLegacyChannel(database, input): Promise<boolean>` and actual Drizzle PostgreSQL proxy callback `{ sql, params }`.
- Produces: Tests proving exact actor/channel/Bot values bind to the intended ON/WHERE relations for both query shapes, in one callback/statement.
- Owner role: `backend_implementer`
- Validator role: `backend_validator`
- Verification: focused suite, predicate mutation check, scoped strict TypeScript, Biome, diff check.

- [ ] **Step 1: Capture exact SQL and bound parameters** from pg-proxy in the test helper; use distinct literal values `actor-sentinel-47`, `channel-sentinel-93`, `bot-sentinel-18`.
- [ ] **Step 2: Add exact query-contract assertions** for channel.id = membership.channel_id; membership.channel_id and membership.user_id WHERE binds; live-channel deleted_at IS NULL; Bot join channel_id = membership.channel_id and agent_id bound to bot sentinel. Assert exact ordered parameter arrays for Bot and no-Bot paths, one SQL callback each, and no channel_agents join in no-Bot path. Rename empty-result assertions to state that they test mapping an empty query result to false, not live database semantics.
- [ ] **Step 3: Run the test against the correct baseline** and confirm its assertions pass; temporarily mutate only the `agent_id` binding to use the actor sentinel, run focused test, and confirm the new test fails on parameter mapping. Restore production source exactly and verify its SHA equals the R2-2 after-checkpoint source hash.
- [ ] **Step 4: Run** `bun --no-env-file test tests/enterprise/legacy-channel-scope.test.ts tests/enterprise/authz.integration.test.ts`, scoped strict TypeScript, Biome, and `git diff --check`; all pass and no DB test is run.
- [ ] **Step 5: Capture** complete uncommitted before/after manifests and a full-content incremental package, then append evidence to the existing R2-2 report. Independent validator and scoped reviewer assess the same fixed hash.

**Failure handling:** If the expected PostgreSQL dialect SQL differs in whitespace or placeholder order, inspect captured SQL/params from the actual Drizzle proxy and write exact semantic relationship assertions without weakening actor/channel/Bot distinction. If production source hash differs after mutation restoration, stop and recover exact source from the recorded R2-2 after package before any validation.
