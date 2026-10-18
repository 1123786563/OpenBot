# Frontier Integration — Transfer Ledger (Task 1, Step 1–2)

- **Date**: 2026-10-15
- **Child worktree (this integration)**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-frontier-integration`, branch `1123786563/issue5-frontier-integration`, **HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`** (== BASE; verified clean before transfer; no commit/stage/push at any point).
- **Plan copy**: `docs/superpowers/plans/2026-10-15-issue5-frontier-integration.md`, SHA-256 `0234ed9fd7b52909ccacdc6112386230ba1e7ac5909548b41f698558d551cd3f` (byte-identical to the parent plan in `issue5-execution`; hash pre-verified before copy).
- **Source worktrees (user-owned, read-only — only `cp`/`shasum`/`diff` reads; never written)**:

| Source | Branch | HEAD | Role |
|---|---|---|---|
| `issue5-207-timeout` | `1123786563/issue5-207-timeout` | `f0520524…` | **authoritative** final F1-repaired #207 state |
| `issue5-207` | `1123786563/issue5-207` | `f0520524…` | original #207 checkpoint (read; every deliverable byte-identical in both — see notes) |
| `issue5-209` | `1123786563/issue5-209` | `f0520524…` | #209 incl. F1 concurrency repair (final state) |
| `issue5-215` | `1123786563/issue5-215` | `f0520524…` | #215 final state |
| `issue5-234` | `1123786563/issue5-234` | `f0520524…` | #234 final state |

## Pre-edit allowed-file list (recorded before any child edit)

Transferred production/test deliverables (below), shared merge files (`server/src/config.ts`, `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `server/drizzle/meta/_journal.json`), migration SQL + snapshots (`0122/0123/0124` SQL, `0122/0123/0124_snapshot.json`), whole-file #234 wiring (`server/src/app.ts`, `server/src/audit.ts` — no other ticket touches them; #234 review verified pure-additive vs BASE), and this ledger directory. Nothing else was edited; `git status` confirms (see `final-state/manifest.md`).

## Transferred deliverables — full SHA-256, verified at BOTH sides after copy

Every row: hash computed at source and at child; byte identity confirmed (script output in run log). All hashes equal the accepted independent reviews' manifests (see `sources/` copies of each ticket's checkpoint docs, preserved verbatim).

### #207 — final F1-repaired state (source: `issue5-207-timeout`)

| File | Full SHA-256 (source == child) | vs original #207 checkpoint |
|---|---|---|
| `server/src/gateway/endpoint.ts` | `45032acb713a05b02ba26f0cd9d9deccbb34adc9e526a40d8de99cd277891624` | repair-changed (= f1-repair report) |
| `server/src/gateway/config-store.ts` | `963f082e066142c8efc5191dc31352348331c84840a52e53dbf0e5db362b77c3` | identical |
| `server/src/gateway/routes.ts` | `da7e54dec6b9f12f90eccf3a56e225462834ea889c0c7910a42374993fbcc2f0` | identical |
| `server/src/db/schema/gateway.ts` | `849f91868518de0f3651676ae3428ee3c8e747429a98a13df3ae166714128f2d` | identical |
| `server/drizzle/0122_gateway_endpoint_config.sql` | `e452ae4f93086d2ca3d10a8b50e3a3db983e7d62ce8e3260811ac1e12da758d1` | identical |
| `server/drizzle/meta/0122_snapshot.json` | `31b406c9d58917e6da33276120e4e59fe477bd40f90fd54fba50737f5f714ff9` | identical (kept as the integrated 0122) |
| `server/tests/gateway-endpoint-config.test.ts` | `9f027dc2a4cd5a29cb420b952565e8fd646d3438dafcc3af122fb0de7ee9cdc4` | repair-changed |
| `server/tests/gateway-endpoint-config.integration.test.ts` | `c29326eea42388b66c42dd076508ab3d04bdb60a2f3e4d107bf3ec6ea7eae506` | repair-changed |

`server/src/config.ts` (#207 source version `3d3bd74c6abe000a761e70fef045ebb2ca24e25c1b175a38e671fd4be866ce11`) is a **shared merge file** — see below.

### #209 — final F1-repaired state (source: `issue5-209`)

| File | Full SHA-256 (source == child) |
|---|---|
| `server/src/gateway/conversion-rate.ts` | `d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034` |
| `server/src/gateway/conversion-rate-store.ts` | `eda84eb8d7613ab55ac3259bc6af42ff51a60f099b299a8f4d9b81150e9d00fc` (post-F1-repair) |
| `server/tests/gateway-conversion-rate.test.ts` | `89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38` |
| `server/tests/gateway-conversion-rate.integration.test.ts` | `50165a1c5ec6952962214fd92e37e8e754c9c9d017f810fbaae552850eea8357` (post-F1-repair) |

`server/src/config.ts` (#209 source version `5b28118a01e63245ecbe61bdc2d12f77876972faa1ecda77dd15afbf252cc86b`) — shared merge file.

### #215 — final state (source: `issue5-215`)

| File | Full SHA-256 (source == child) |
|---|---|
| `server/src/billing/payer-ref.ts` | `774c3591f2d5cf9a265dffa47b1336fbb8d987909290d478e6046fab30ed499f` |
| `server/src/billing/payer-account.ts` | `315e33e540b9a71d48897fc9cf582866472c10071c4366bc7c572dc19c3f0b60` |
| `server/src/db/schema/payer.ts` | `400b037abee54b7eaa265fd7a2100b57785e4ae794e9c696a796e58859b0db4a` |
| `server/drizzle/0122_payer_accounts.sql` → delivered as **`server/drizzle/0123_payer_accounts.sql`** | `b3913af40da6fdacd716da5fa10aac0d35513f8d1da9d137dd2ed94c4f4ae6ad` (content byte-identical; renamed only) |
| `server/tests/payer-ref.test.ts` | `461beb3a6abbc50c2864b1663898afd0a5041f44c28cbb07685a037e548c782d` |
| `server/tests/payer-account.integration.test.ts` | `3775308fc9366c376b19c75422adb72f3b3d6fdcf511c14d46080e16e9359f54` |

Shared merge inputs from #215: `schema/index.ts` (`642981b1…`), `drizzle.config.ts` (`623fe383…`), `_journal.json` (`5229afd6…` — entry `idx 122 / when 1792039063976 / tag 0122_payer_accounts`).

### #234 — final state (source: `issue5-234`)

| File | Full SHA-256 (source == child) |
|---|---|
| `server/src/db/schema/bots.ts` | `b9b7b557292c9aec6bac8bb2e2eb837e302dfcc673194862f1212d37a954338f` |
| `server/src/bots/service-registry.ts` | `a31df1f4c871e699ec9fc29e5c9df665fe882e503d302de4d5caaeeee341109e` |
| `server/src/bots/admin-routes.ts` | `26cf1dfbb99d8799ab52cb2c16ad537f435e64e24fa70b63f8d71d5dd8a795b7` |
| `server/tests/bot-service-registry.integration.test.ts` | `866f2979a7bb9d6b7e12aa085fac9037b6c821a707622a95e3bf186f972a53b4` |
| `server/drizzle/0122_bot_services.sql` → delivered as **`server/drizzle/0124_bot_services.sql`** | `90bb0b592931641715a3e846c05a2ae171f37a087be47ffc55fd6a0081bbfc01` (content byte-identical; renamed only) |
| `server/drizzle/meta/0122_snapshot.json` | `1ef71dd4cc2b84434b707fbdb07cc96969e34360222deeabd00eb47aa83429b7` (source of the `public.bot_services` subtree + its snapshot id; delivered re-chained as `0124_snapshot.json`) |
| `server/src/app.ts` | `672f238a5b28f1bfb9dd0c44e588b38e714f493198db3e82c2fdd86ba91e7d22` (whole file; #234 review: pure additive vs BASE) |
| `server/src/audit.ts` | `0da2068da4dec90692a56bba4e8b3acbdb9aea600cc8a9368d96b909daaa75c0` (whole file) |

Shared merge inputs from #234: `schema/index.ts` (`82a8125f…`), `drizzle.config.ts` (`0f4168e4…`), `_journal.json` (`1808e3df…` — entry `idx 122 / when 1792036800000 / tag 0122_bot_services`).

## Shared merge files (merged; cannot equal any single source)

- `server/src/config.ts` — 3-way merge (BASE `f0520524` : ours `issue5-207-timeout` : theirs `issue5-209`) via `git merge-file`; two conflicts (adjacent import insertions; adjacent function insertions) resolved keep-both. **Proof of no contract loss**: `diff` vs #207 source shows 0 deletions and exactly #209's added lines; `diff` vs #209 source shows 0 deletions and exactly #207's added lines. Final SHA-256: `862310a5448474f162d35d20b7fa0dfca2a1c01e44d4196b29dc78ed0b6b9ec5` (see `final-state/manifest.md`).
- `server/src/db/schema/index.ts` — BASE + the three single-line re-exports at each ticket's exact anchor style, alphabetical order preserved (`./bots`, `./gateway`, `./payer`); each source's line verified present verbatim.
- `server/drizzle.config.ts` — BASE + the three schema paths, each inserted at its ticket's exact BASE anchor (gateway after `delivery.ts`, bots after the second `billing.ts`, payer after `payment.ts`).
- `server/drizzle/meta/_journal.json` — BASE (122 entries) + three appended entries idx 122/123/124; terminal newline restored (fixes #207 review F2; BASE had it). See `migration-adjudication.md`.
- `server/drizzle/meta/0123_snapshot.json`, `0124_snapshot.json` — newly built, chained onto the untouched #207 `0122_snapshot.json`. See `migration-adjudication.md`.

## Source-worktree integrity

`git status --porcelain -uall` of every source worktree recorded before and after transfer: shapes unchanged from their checkpoint reports (no writes performed by this integration). #207's original checkpoint (`issue5-207`) was read for cross-verification only; all 8 non-repair #207 deliverables are byte-identical between `issue5-207` and `issue5-207-timeout` (hash-verified), and the 4 F1-repair files are taken from `issue5-207-timeout` per dispatch.
