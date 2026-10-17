# #234 Bot 服务登记 — File Scope（编辑前记录）

- Recorded: 2026-10-15, BEFORE any edits in this worktree (branch `1123786563/issue5-234`, BASE `f0520524`).
- Ticket: https://github.com/1123786563/OpenBot/issues/234 (04.1 Bot 服务登记与唯一服务身份; write scope = Bot registry module/migration + admin route + tests).
- Test database: dedicated `postgres://openbot:openbot@localhost:5432/openbot_234` (created fresh in the local `openbot-postgres-1` container; NOT the dev `openbot` database; guard in `server/tests/support/database.ts` enforces the dedicated name).

## New files (owned by this ticket)

- `server/src/db/schema/bots.ts`
- `server/src/bots/service-registry.ts`
- `server/src/bots/admin-routes.ts`
- `server/tests/bot-service-registry.integration.test.ts`
- `server/drizzle/0122_bot_services.sql` (name after `drizzle-kit generate`; number 0122 = next after 0121 on this branch)
- `server/drizzle/meta/0122_snapshot.json`
- `docs/execution-ledgers/checkpoints/234/*` (this record + final report)

## Modified files (wiring only; append-only edits, no logic changed)

- `server/drizzle.config.ts` — add one schema path `"./src/db/schema/bots.ts"` (required: files missing from this list are invisible to `generate`).
- `server/src/db/schema/index.ts` — add one `export * from "./bots";` line.
- `server/drizzle/meta/_journal.json` — append migration journal entry (generated).
- `server/src/app.ts` — import `createBotAdminRoutes`; add optional `botServiceDatabase?: Database` param; conditional mount of `/api/admin/bots` (same absent-means-unmounted contract as billing).
- `server/src/audit.ts` — append `bot_service.registered` / `bot_service.edited` / `bot_service.status_changed` to the closed `auditEventTypes` union (typecheck-necessary wiring, additive only).

## Conflict notes for the coordinator (parallel siblings #207/#209/#215)

- Migration number `0122` may collide if siblings also add migrations on their branches; renumber at integration (journal + snapshot + SQL are generated together and renumberable).
- `server/src/app.ts`, `server/src/audit.ts`, `server/src/db/schema/index.ts`, `server/drizzle.config.ts`, `_journal.json` are shared append-points; my edits are single-hunk additive lines at distinct locations from gateway/payer wiring.
- No edits outside the ticket write scope; no dev/prod data touched; no commit/push/merge per dispatch constraints.
