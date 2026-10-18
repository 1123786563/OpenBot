# Frontier Integration — Migration & Snapshot Adjudication

- **Date**: 2026-10-15. All decisions below implement the dispatch goal: reconcile three independent `idx 122` migrations into `0122_gateway_endpoint_config` (#207), `0123_payer_accounts` (#215), `0124_bot_services` (#234), with journal idx/tag/when agreement and a continuous Drizzle snapshot chain 0121→0122→0123→0124 — closing #215 review F1 — while preserving documented pre-existing snapshot collisions and never rewriting history.

## 1. The three-way idx-122 collision and its resolution

Each source worktree appended its own `idx 122` journal entry and migration SQL:

| Ticket | Original name | Original `when` | Resolution |
|---|---|---|---|
| #207 | `0122_gateway_endpoint_config` | `1792039004488` | **kept verbatim** (name, idx 122, when, SQL, snapshot) |
| #215 | `0122_payer_accounts` | `1792039063976` | renumbered to **0123**; SQL content byte-identical; idx 123; `when` kept (`1792039063976` > 0122's, monotonic ✓); tag renamed to `0123_payer_accounts` |
| #234 | `0122_bot_services` | `1792036800000` | renumbered to **0124**; SQL content byte-identical; idx 124; original `when` (`1792036800000`) < 0123's, so bumped to **`1792039063977`** (= 0123's `when` + 1, minimal deterministic monotonic bump, documented here); tag renamed to `0124_bot_services` |

Final journal tail (125 entries total, idx 0–124; `version: "7"`, `breakpoints: true`, all matching file names):

```json
{ "idx": 122, "version": "7", "when": 1792039004488, "tag": "0122_gateway_endpoint_config", "breakpoints": true },
{ "idx": 123, "version": "7", "when": 1792039063976, "tag": "0123_payer_accounts", "breakpoints": true },
{ "idx": 124, "version": "7", "when": 1792039063977, "tag": "0124_bot_services", "breakpoints": true }
```

Diff vs BASE is **pure addition** of these three entries (`git diff` verified); every historical entry byte-untouched. The **terminal newline was restored** (BASE `0x0a`; the #207 checkpoint had dropped it — its review's F2, explicitly deferred to "the integrator's next journal edit"). `when` ordering satisfies `migration-runner.ts`'s strictly-increasing validation (exercised by real applies below).

## 2. Snapshot chain construction (closes #215 review F1)

Delivered meta state (all `version: "7"`):

| Snapshot | id | prevId | tables | Tree provenance |
|---|---|---|---|---|
| `0121_snapshot.json` | `fbb4e855-2b41-4ad3-9229-4f3d7a1bd490` | `0564380c-…` | 160 | BASE, untouched |
| `0122_snapshot.json` | `533380cc-a8e9-4548-b23b-0c0b914f0d30` | `fbb4e855-…` (0121) | 161 | #207's reviewed snapshot, **byte-identical** (SHA `31b406c9…`); adds `public.gateway_configs` |
| `0123_snapshot.json` (new) | `cd8dfb17-d777-4fe2-95fc-f78ac5cbca16` | `533380cc-…` (0122) | 162 | 0122's full tree + `public.payer_accounts` subtree; id and subtree are **drizzle-kit-generated** (see §3) |
| `0124_snapshot.json` (new) | `efa2f5db-3f33-4e2e-b4e2-e8dee0aab04d` (#234's original id) | `cd8dfb17-…` (0123) | 163 | 0123's full tree + `public.bot_services` subtree taken verbatim from #234's reviewed snapshot |

Programmatically asserted invariants (script in run log; re-verified against the delivered files):

1. `0122.prevId == 0121.id`, `0123.prevId == 0122.id`, `0124.prevId == 0123.id` — continuous chain.
2. For every table in 0121's tree: its subtree is deep-equal in 0122, 0123 and 0124 — **no historical tree rewritten**.
3. Each new snapshot adds exactly one subtree: 0122 `+gateway_configs`, 0123 `+payer_accounts`, 0124 `+bot_services` (deep-equal diff vs predecessor).
4. `0124`'s `bot_services` subtree is byte-equal (deep-equal) to #234's reviewed subtree.

This resolves #215 review F1 (Medium): the missing payer snapshot now exists, correctly sequenced (`prevId` → 0122 → 0121), with a drizzle-authored subtree (not hand-derived), and the chain is continuous through 0124.

## 3. drizzle-kit generate evidence (disposable copies only; delivery untouched)

Full-repo `drizzle-kit generate` remains unusable on this repository for pre-existing reasons, reconfirmed here in a `/tmp` copy of the delivery (`/tmp/frontier-gen`):

1. The two documented historical snapshot collisions (`0054`/`0055` fork; `0086`/`0096` duplicate id) block it. In the disposable copy I linearized them experimentally (`0055.prevId := 0054.id`; re-id `0086`, chain `0095→0086→0096→0097`) **only to probe** — the delivery keeps all historical snapshots untouched.
2. Even with the chain linearized, generate then fails on an interactive `promptNamedWithSchemasConflict`: the newest snapshot tree (0121/0122, 160–161 tables) is behind the current schema code (e.g. `enterprise_conversations` missing from 0121's tree) — a pre-existing snapshot/code divergence, so a full generate would bundle dozens of unrelated table creations. This is repo debt outside this integration's write scope.

**Working alternative (used for authoring):** a minimal closed sandbox `/tmp/payer-sandbox` (fresh `git archive HEAD` + node_modules symlinks; empty journal; drizzle.config listing only `billing.ts`, `gateway.ts`, then `payer.ts`, then `bots.ts` — a closed import set):

- Step 1 (`billing`+`gateway`): generate produced `0000` (tree: billing_customers, billing_subscriptions, billing_webhook_events, gateway_configs; id `9aabb313-…`).
- Step 2 (+`payer`): generate produced `0001_absent_captain_universe.sql` — **only** `payer_accounts` — and snapshot `0001` (id `cd8dfb17-d777-4fe2-95fc-f78ac5cbca16`, prevId `9aabb313-…`) whose `public.payer_accounts` subtree is the delivered 0123 subtree verbatim; its id became the delivered 0123 id.
- Step 3 (+`bots`): generate produced `0002` — **only** `bot_services` — whose subtree is **deep-equal to #234's reviewed subtree** (independent validation of #234's hand-injection), and whose gateway-step subtree is **deep-equal to #207's reviewed 0122 subtree** (validation of #207's hand-construction).

Generated-vs-reviewed SQL cross-check: the sandbox-generated `payer_accounts` SQL is semantically identical to #215's reviewed SQL (same columns/defaults, same CHECK set, same FK `ON DELETE cascade`, same two unique indexes; only cosmetic difference: drizzle inlines the CHECK inside CREATE TABLE while the reviewed SQL adds it via ALTER — PostgreSQL-equivalent). The generated `bot_services` CREATE TABLE is identical to #234's reviewed SQL. **No generated file entered the delivery**; only the subtree JSON and id were adopted, embedded by script into the real chain.

`drizzle-kit check` on the delivery: exit 0, output byte-identical to clean HEAD (`git archive HEAD` probe in `/tmp/headcheck`) — only the two documented historical collision notes; zero complaints about the new 0122→0124 chain.

## 4. Pre-existing collisions left unchanged (0054/0055, 0086/0096)

Rationale for retaining them: (a) they exist verbatim on clean HEAD (verified by `git show HEAD:` probes in both #215's and #234's reviews and reconfirmed here); (b) the dispatch says preserve them; (c) runtime migration (`server/scripts/migrate.ts` + drizzle-orm postgres-js migrator) reads only `_journal.json` + SQL files — proven by the real 125-entry applies below; (d) rewriting historical snapshots is out of write scope and would falsify history. The 0121→0124 chain is fully continuous regardless: the new snapshots reference only 0121/0122 ids.

## 5. Real-database verification (dedicated test DBs only)

- **Incremental** (journal 122→125): `DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_{215,234,int} bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}` ×3; each DB now has 125 `drizzle.__drizzle_migrations` rows.
- **Fresh from scratch**: new DB `openbot_frontier_full` → one `migrate.ts` run → 125 rows; last three `hash` values equal SHA-256 of the three delivered SQL files (`e452ae4f…`, `b3913af4…`, `90bb0b59…`).
- **Structures** (`\d` on `openbot_frontier_full`): `gateway_configs` (PK `id`, `request_timeout_ms` int4 default 10000, `config_version`), `payer_accounts` (PK `id`; `payer_accounts_owner_unique_idx` UNIQUE `(kind, owner_id)`; `payer_accounts_external_customer_unique_idx` UNIQUE `(external_customer_id)`; CHECK `kind IN ('personal','company','legacy_deployment','unknown_owner')`; FK → `billing_customers(external_id) ON DELETE CASCADE`), `bot_services` (PK `bot_id`, jsonb `capabilities`, `status` default `'active'`) — all exactly as reviewed.

## 6. Databases used (all dedicated; no dev/prod contact)

| DB | Container | Purpose |
|---|---|---|
| `openbot_207` (pre-existing, task-designated) | `openbot-postgres-1` (5432) | #207 integration tests (already at the identical 0122 state from the source run) |
| `127.0.0.1:5569/openbot_test` (task-designated) | `openbot-issue5-209-pg` | #209 integration tests (incl. concurrency case; serial only) |
| `openbot_frontier_215` (created fresh here) | `openbot-postgres-1` | RED at 122 entries, then 125; #215 tests |
| `openbot_frontier_234` (created fresh here) | `openbot-postgres-1` | RED at 122 entries, then 125; #234 tests + regressions |
| `openbot_frontier_int` (created fresh here) | `openbot-postgres-1` | RED gateway integration at 122; incremental apply evidence |
| `openbot_frontier_full` (created fresh here) | `openbot-postgres-1` | from-scratch full apply + structure/hash verification |

The dev database `openbot` (same container) was never connected to; every test used `TEST_DATABASE_URL` (whose guard in `server/tests/support/database.ts` rejects the `openbot` name) and every migrate used an explicit dedicated `DATABASE_URL` above.
