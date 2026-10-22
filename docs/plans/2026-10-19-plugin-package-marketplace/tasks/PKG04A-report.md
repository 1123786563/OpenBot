# PKG04 Slice A (#463 backend) — Finisher Report

Status: DONE (finisher resumed at phase 2 after the first implementer hit its turn cap; nothing committed).

## Files

Delivered by the previous implementer (verified, behavior unchanged this round): `server/src/enterprise/plugin-packages/experts.ts` (service), `server/tests/package-expert-routes.test.ts` (native), `server/tests/multitenancy/package-expert.test.ts` (driven), PKG04 steps in `server/scripts/multitenancy/migrate-test.ts` (already journal-applied; rerun = up-to-date), group `server/tests/multitenancy pkg04` in `scripts/lib/e2e-manifest.mjs`, expert POST route + `package-admin` classification + shared codes.

Finisher changes:
- `server/tests/multitenancy/package-expert.test.ts` — test-only fixes (below).
- `server/tests/multitenancy/support/sql-errors.ts` (new) — single source for `thrownSqlState`/`thrownMessage`, which were duplicated verbatim across the package test chain; `support/package-install.ts` and `support/plugin-install.ts` now re-export it.
- `server/src/enterprise/plugin-packages/experts.ts` — lint-only, semantics-preserving: two `useOptionalChain` rewrites, `let artifact` given an explicit type.
- `server/tests/package-expert-routes.test.ts` — removed one dead variable.

## DDL / lock order (as implemented, test-verified)

`enterprise_package_experts`: PK `(tenant_id, agent_id)`; FKs pin tenants/workspaces/installs/bot-ownership/memberships; revision CHECK; FORCE RLS with data read arm (tenant+team) and operator read+INSERT arms (tenant); zero UPDATE/DELETE grants for every role (provenance immutable — acceptance 7). Changes action CHECK widened with `'createExpert'`. `openbot_create_package_expert`: INVOKER plpgsql, `search_path=pg_catalog`, re-proves the `app.*` binding, refuses endpoint/auth keys and non-`built_in` agentType; PUBLIC revoked, EXECUTE only to `ob_ent_operator`. Lock order appends after the canonical member locks: release → package-key → idempotency → install → grant(bot); clock read only after all locks.

## Test fixes (tests only; no service spec violation surfaced)

1. Install seeds collided on `enterprise_package_install_scope_key_uq`: the atomicity and disabled-install seeds got their own package keys (`assistantAtomic`/`assistantDisabled` catalogue aliases of the same verified release; `assistantUpgrade` kept for the provenance test).
2. `has_function_privilege('PUBLIC',…)` raises `role "PUBLIC" does not exist` — PUBLIC is now probed via the resolved ACL (no grantee-0 EXECUTE row).
3. The base plan has no company-b admin identity — the cross-company case promotes `b1-member` via the disclosed `promoteToCompanyAdmin` stand-in, then resolves the context through the real authorizer.

## Tests & evidence (fresh dirs)

- Native: 15/15 → `.e2e/pkg04a-native` (passed, exit 0).
- Driven group `server/tests/multitenancy pkg04`: inner 13/13 (107 expects) → `.e2e/pkg04a-driven`.
- Regression: pkg03 + pkg03b groups green → `.e2e/pkg04a-pkg03-regress`; MT031 `plugin-install.test.ts` (other `sql-errors` consumer) 35/35 — one unrelated flake seen once, then 4 consecutive greens.

## Verification

- Server typecheck: only the 3 pre-existing bootstrap errors (`scripts/bootstrap-local-gateway.ts`, TS2339 ×3).
- `bunx biome check` on 8 touched files: clean.
- Env note: reset the forgotten passwords of the `ent_directory`/`ent_data`/`ent_operator` login roles on the shared `openbot-enterprise-test-pg` container.

## Fix round 1

Finding 1 (race): `instantiateExpertWithin` now takes the install advisory lock (keyed on the INPUT-derived installId) plus the grant lock BEFORE reading the install row — the enabled/expectedRevision/currentVersion CAS checks run under the lock; canonical order unchanged (member locks → release → packageKey → idempotency → install → grant). New driven test: a rival session holds the install lock, commits a revision-2 upgrade inside the window, releases; assertion is REVISION_CONFLICT with zero rows. Discriminating proven: the pre-fix order was temporarily re-injected (test failed — stale CAS satisfied), then reverted byte-identically.

Finding 2 (lint): `biome check --write` fixed the 3 files; biome clean on all 8 PKG04A-touched files.

Gates (fresh dirs): native 15/15 → `.e2e/pkg04a-fix-native`; driven harness pass → `.e2e/pkg04a-fix-driven` (inner direct: 14/14, 111 expects); typecheck = 3 pre-existing only; pkg03 regression green (driven 15/15, native grants-routes 19/19).
