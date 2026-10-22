# Task Brief — PKG04 Slice A (#463): instantiateExpert backend (atomic expert creation from package templates)

## Context

Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`, uncommitted; binding checkpoint cp12 (source `b361256b…`, see `ledger.md` 2026-10-19 entries — read the three PKG03 sections first). No commit/push. Prereq #462 delivered: scoped grants (`enterprise_package_grants`, service `grants.ts`), run pins (§9), install/revision authority (`install-service.ts`), restricted operator channel pattern (`mutation-context.ts` + advisory-lock order in `install-service.ts`).

## Goal (slice A, backend)

`instantiateExpert`: an admin instantiates a Bot from an installed package's expert template — one operator transaction writing profile + ownership + provenance + initial Skill grant atomically; retries with the same (actor, idempotency key) return the SAME agentId.

## Acceptance mapping (from ingestion #463 — each item must have a test)

1. Template accepts ONLY name/summary/systemPrompt/in-package skill refs; endpoint/auth/remote-runtime fields → reject (`TEMPLATE_FIELD_REJECTED` or reuse 400 INPUT_INVALID — declare the code in shared enum).
2. Created agent is forced `built_in`; deployment managedConfiguration cannot override; creator + ownership resolved server-side from the trusted scope (never from body).
3. profile + ownership + provenance + initial grant commit in ONE operator transaction; injected mid-transaction failure leaves zero rows (no ghost Bot).
4. Same (actor, idempotency key) replay → same agentId 200; same key + different input → 409-style rejection (declare code).
5. The restricted creation function is operator-EXECUTE only, PUBLIC revoked; forged scope/actor headers, non-admin, cross-scope input → 403/404 same-shape (mirror `package-grants-routes.test.ts` patterns).
6. No connector tools auto-granted, no account connections, no team publishing — assert nothing else was written.
7. Later user edits to the Bot / private skills survive package upgrade/uninstall (provenance is metadata only, never an override path — assert the upgrade path does not touch created rows).

## Deliverables (priority order; keep tree compiling + green each step)

1. **Read first**: existing expert authorities (`AgentProfile`/`BotOwnership`/`ExpertVersion` — grep `server/src` for their tables/services), the package manifest schema (`shared/enterprise/plugin-package-contracts.ts`) for where an expert template lives (if the manifest has no expert-template field, STOP and report — do not invent product surface), and the MT migrate-test tail-append recipe (`server/scripts/multitenancy/migrate-test.ts`, PKG03 pattern).
2. **DDL (MT task step, tail-append)**: provenance + creation-idempotency storage per spec §6/§8 conventions (tenant+workspace compound keys, RLS identical shape to installs: data read arm, operator write arm). If existing tables suffice, write none — justify in report.
3. **Service** `instantiateExpert` in `server/src/enterprise/plugin-packages/` (new file, PKG03A patterns): template validation → single operator transaction (advisory-lock order AFTER the existing sequence to avoid reorder — document placement) → rows above → reuse `grants.ts` seam for the initial Skill grant inside the same tx.
4. **Routes**: admin PUT/POST under `/api/enterprise/plugin-packages/...` mirroring `routes.ts` (classified-entrance guard, idempotency-key header REQUIRED, scope headers only).
5. **Tests**: native `server/tests/package-expert-routes.test.ts` (schema/identity/idempotency/403/404 mapping) + driven `server/tests/multitenancy/package-expert.test.ts` (real roles; transaction-failure injection → zero rows; replay → same agentId; cross-tenant refused). Register explicit group `server/tests/multitenancy pkg04` in `scripts/lib/e2e-manifest.mjs`.

## Constraints

- No new npm deps; expand-only DDL; production migration forbidden.
- server typecheck: only the 3 pre-existing bootstrap errors; Biome clean on touched files.
- Official evidence: `.e2e/pkg04a/` native (files you touch) + `E2E_BUN_ONLY="server/tests/multitenancy pkg04" E2E_UNIT_OUTPUT=.e2e/pkg04a-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`; pkg03 groups must stay green.
- Env: test DB docker `openbot-enterprise-test-pg` (:5435); boot recipe + env pitfalls in ledger (PORT==SERVER_PORT, env-file precedence, channel URL derivation).

## Report

Files, DDL-or-not justification, lock-order placement, test counts (new + regression), evidence dirs, typecheck/biome, deviations. ≤450 words. No commit.
