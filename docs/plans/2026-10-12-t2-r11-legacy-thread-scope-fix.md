# T2 R11 Legacy Thread Scope Compatibility Fix

> **For agentic workers:** implement the single task below in this isolated workspace. Keep the change narrow; do not start downstream T3 work.

**Goal:** Preserve access to authorized legacy conversation history after existing-thread routes switch to persisted-thread scope resolution, without restoring client-selected tenant/workspace authority.

**Architecture:** Extend `ScopeResolver.resolveForThread` to derive a unique scope from either an enterprise conversation row or an authorized legacy channel mapping. For legacy mappings require the authenticated actor's active tenant membership, exact mapping actor/thread, active channel membership, and an active channel resource with an explicit read grant in the resolved workspace. Reuse the conversation service's subsequent reauthorization. Never fall back to selector-based `resolve` on a miss. Return safe 404 for missing/ambiguous thread scope and safe 503 for missing verified data capability.

**Tech Stack:** TypeScript, Hono, Drizzle, Bun tests, existing DirectoryDatabase/DataDatabase capability verifiers and conversation services.

**Spec and finding sources:** Approved `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md` §§2–5, 8; Task 2 brief; R11 review `.superpowers/sdd/2026-10-11-mastra-intelligence-only-dag/reports/task-2-r11-review.md` (SHA256 `cbf0770658594aabae13754c29b28a052575e5adc61a7838197809e2f16544ea`), findings R11-01 (Medium) and R11-02 (Low).

## Global Constraints

- Preserve authenticated server identity, active membership, exact-thread ownership, RLS context and channel/resource read authorization; client tenant/workspace selectors never authorize thread requests.
- Do not fall back to selector-based scope on a thread lookup miss. Legacy scope must derive from the exact mapping and current authorized resource.
- Keep conversation history on its existing legacy read-only path; do not make legacy history writable or alter Run admission semantics.
- Preserve all unrelated/user edits, especially the 0065/0066 migrations, migration runner files, existing dirty integration suites, T1 R2 files and journal baseline. Do not edit them.
- Do not start, reset, provision, migrate, access, or modify any database service. Run DB-independent tests only; record live RLS behavior as unverified.
- Do not stage, commit, stash, reset, rebase, merge, push, publish, or delete the worktree.

## Review Focus

- A listed legacy thread can open message history through the mounted route using a scope derived from its mapping, actor, membership, resource and grant.
- A different actor, missing channel membership, missing resource grant, deleted channel, missing mapping, or ambiguous match fails closed; no selector fallback occurs.
- Legacy POST remains read-only after authorization and does not append a message.
- Scope errors map to safe 404; missing verified data capability maps to safe 503 without exposing tenant/thread existence.
- Existing platform conversation routes continue to use exact `resolveForThread` matching.

### Task 1: Preserve legacy thread history with trusted scope

**Files:**
- Modify `server/src/enterprise/tenancy/store.ts` to include authorized legacy mapping scope derivation.
- Modify `server/src/enterprise/conversations/routes.ts` to map expected thread-scope errors safely.
- Modify `server/tests/enterprise/runner-scope.test.ts` with resolver and mounted-route regressions.
- Read-only: `server/src/enterprise/conversations/service.ts`, `server/src/db/schema/core.ts`, `server/src/db/schema/enterprise-tenancy.ts`, `server/src/enterprise/contracts.ts`.

**Consumes:** `ScopeResolver.resolveForThread`, active membership enumeration, verified DataDatabase, legacy `intelligenceChannelMappings`, active channel membership, `enterpriseResources`, `enterpriseResourceGrants`, `ConversationService.list/history/append`.

**Produces:** A unique trusted PlatformScope for exactly one authorized enterprise conversation or legacy mapping; safe route responses for absent/ambiguous scope and missing capability.

- [ ] **Step 1 — RED:** Add resolver tests proving a legacy mapping with active membership/channel membership/resource read grant resolves to its persisted tenant/workspace/principal; reject an actor mismatch, missing grant/membership, deleted channel, zero matches and ambiguous matches. Add a mounted list-to-history test proving scope reaches `service.history`, and verify legacy POST remains read-only. Add route status tests for 404/503.
- [ ] **Step 2 — GREEN:** Query legacy mappings only within each active candidate tenant/principal RLS context. Join the actor-owned mapping to active channel membership, current channel, active enterprise channel resource and matching principal read grant; return the workspace from that resource. Merge platform and legacy candidates and require exactly one authorized match. Keep service-level reauthorization in place. Map missing/ambiguous scope to the same safe 404 contract and missing data capability to 503.
- [ ] **Step 3 — Verify:** Run focused `runner-scope.test.ts`, scoped Biome and `git diff --check`; inspect the increment to prove no selector fallback or broader data access. No database-backed test execution is allowed unless the user provides an explicitly disposable DB later.
- [ ] **Step 4 — Freeze:** Save before/after manifests, exact increment, hashes and implementer report. Require independent backend validation and Spec/code-quality review on the same hashes. T2 remains incomplete until production composition/cutover and all required DB gates pass.

**Acceptance:** Authorized legacy threads remain listable and their history remains readable through trusted scope; unauthorized/ambiguous legacy requests fail closed; errors are safe and stable; no database service is accessed.
