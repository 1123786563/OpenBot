# F1 Repair Report — Ticket #207, independent reviewer finding F1 (Medium)

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-timeout`, branch `1123786563/issue5-207-timeout`
- **HEAD**: `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (BASE; **no commit made**, no staging, no push)
- **Repairer**: dispatched Pi worker, task `task_dd8c622e9ec9`, dispatch `ctx_4012bbcf79fe`
- **Plan**: `docs/superpowers/plans/2026-10-15-issue5-207-timeout-bound.md` (byte-identical copy of the approved parent repair plan, SHA-256 `2617c9dd4a5d53ad574efcd6c7efd5ead380d498f56a78f68c86ddb7681408d2`)
- **Evidence files**: `transfer.md` (Task 1), `red.md` (RED), `green.md` (GREEN + review-focus resolution)

## Reviewer finding F1, verbatim (from `checkpoints/207/review.md`, source worktree)

> | F1 | **Medium（必修）** | `server/src/gateway/endpoint.ts:46-56`；`server/src/config.ts:1514` | timeout 无上界：`PUT requestTimeoutMs=3000000000` 实测 `PostgresError: integer out of range` → 500（事务回滚无脏写），破坏"非法输入 400 带原因"契约；env 路径同样无界 | `parseRequestTimeoutMs` 增加 `raw <= 2_147_483_647`（int4 对齐）或运营上限（如 600_000）；补一条拒绝用例 |

Fix implemented exactly as the reviewer's first option (int4 alignment): the shared `parseRequestTimeoutMs` rejects `> 2_147_483_647`, and the `GATEWAY_REQUEST_TIMEOUT_MS` env path now uses that same shared parser instead of its own inline rule.

## What changed (repair delta vs the byte-verified transferred checkpoint)

Only the 4 permitted implementation files changed beyond the transfer:

1. `server/src/gateway/endpoint.ts` — new `GATEWAY_ENDPOINT_ERRORS.timeoutMaximum` sentence ("requestTimeoutMs must be no greater than 2147483647, the largest value a PostgreSQL integer column can store."), `REQUEST_TIMEOUT_MS_MAX = 2_147_483_647`, upper-bound rejection in `parseRequestTimeoutMs`. Positive-integer accept/reject behavior otherwise unchanged.
2. `server/src/config.ts` — **only** the `gatewayEnvConfig` block + its import: env timeout parsing replaced with the shared `parseRequestTimeoutMs`, throw prefix `GATEWAY_REQUEST_TIMEOUT_MS: ${timeout.error}` (same pattern as `GATEWAY_BASE_URL` in the same function). No #209 `bifrostConversionRate` block exists in this worktree (grep-verified).
3. `server/tests/gateway-endpoint-config.test.ts` — 3 new tests (parse boundary max-accepted/one-above-rejected; env max accepted & one-above throws with shared reason; admin PUT above max → 400 + reason before any write, with untouchable DB) + 1 regex updated to the env path's new shared-sentence wording.
4. `server/tests/gateway-endpoint-config.integration.test.ts` — 1 new test: admin PUT `requestTimeoutMs: 3_000_000_000` → 400 with the reason, stored row and `configVersion` unchanged (this exact request reproduced the 500 in RED).

Full repair diff (all 4 files, `diff -u` vs transferred checkpoint) is reproduced in full in this report's appendix run: see "F1 REPAIR DELTA" captured in the worktree terminal; identical content to the per-file sections of `green.md`. No other file changed. No migration/schema/journal/routes/app.ts changes. Gateway remains unmounted and disabled.

## Final exact snapshot

`git status --porcelain -uall` (nothing staged; `git diff --cached` empty):

```
 M server/drizzle.config.ts
 M server/drizzle/meta/_journal.json
 M server/src/config.ts
 M server/src/db/schema/index.ts
?? docs/execution-ledgers/checkpoints/207/checkpoint-report.md
?? docs/execution-ledgers/checkpoints/207/f1-repair/green.md
?? docs/execution-ledgers/checkpoints/207/f1-repair/red.md
?? docs/execution-ledgers/checkpoints/207/f1-repair/transfer.md
?? docs/execution-ledgers/checkpoints/207/file-hashes.txt
?? docs/superpowers/plans/2026-10-15-issue5-207-timeout-bound.md
?? server/drizzle/0122_gateway_endpoint_config.sql
?? server/drizzle/meta/0122_snapshot.json
?? server/src/db/schema/gateway.ts
?? server/src/gateway/config-store.ts
?? server/src/gateway/endpoint.ts
?? server/src/gateway/routes.ts
?? server/tests/gateway-endpoint-config.integration.test.ts
?? server/tests/gateway-endpoint-config.test.ts
```

(this `report.md` itself adds one further untracked file under `f1-repair/`.)

Unstaged tracked diff stat: `drizzle.config.ts +1`, `_journal.json +9 -1`, `config.ts +35`, `schema/index.ts +1` — the first, second, fourth are byte-identical to the reviewed checkpoint; `config.ts` = checkpoint gateway block + F1 repair.

### Full SHA-256 manifest (final state, `shasum -a 256`)

| File | Full SHA-256 | vs checkpoint |
|---|---|---|
| `server/src/gateway/endpoint.ts` | `45032acb713a05b02ba26f0cd9d9deccbb34adc9e526a40d8de99cd277891624` | **changed by repair** (was `e845082383207ddce61f61e6100753d852b1a81fe3ba077a8ff8c27187bb0534`) |
| `server/src/gateway/config-store.ts` | `963f082e066142c8efc5191dc31352348331c84840a52e53dbf0e5db362b77c3` | identical |
| `server/src/gateway/routes.ts` | `da7e54dec6b9f12f90eccf3a56e225462834ea889c0c7910a42374993fbcc2f0` | identical |
| `server/src/db/schema/gateway.ts` | `849f91868518de0f3651676ae3428ee3c8e747429a98a13df3ae166714128f2d` | identical |
| `server/src/db/schema/index.ts` | `f8fa962c18c03f6a3d2769a1bc371a7aa267312f36103b92d2112c931a4dacef` | identical |
| `server/drizzle.config.ts` | `16e5456f894c58280b1d609b87708a30fe1b69d6c568f0618228719795863f32` | identical |
| `server/src/config.ts` | `3d3bd74c6abe000a761e70fef045ebb2ca24e25c1b175a38e671fd4be866ce11` | **changed by repair** (was `05873af2d6b5ccb270244177160df13dd5a2b7a684dab2708bd77aab9f808f00`) |
| `server/drizzle/0122_gateway_endpoint_config.sql` | `e452ae4f93086d2ca3d10a8b50e3a3db983e7d62ce8e3260811ac1e12da758d1` | identical |
| `server/drizzle/meta/0122_snapshot.json` | `31b406c9d58917e6da33276120e4e59fe477bd40f90fd54fba50737f5f714ff9` | identical |
| `server/drizzle/meta/_journal.json` | `39e657fba083cd70d155857ff38f3ce85abd103f51d0c208cacf19f0e9be2cf8` | identical |
| `server/tests/gateway-endpoint-config.test.ts` | `9f027dc2a4cd5a29cb420b952565e8fd646d3438dafcc3af122fb0de7ee9cdc4` | **changed by repair** (was `838cc2f9c9d53175b1513866fe01d6a95e82c39d57aef47f508be8a80d308827`) |
| `server/tests/gateway-endpoint-config.integration.test.ts` | `c29326eea42388b66c42dd076508ab3d04bdb60a2f3e4d107bf3ec6ea7eae506` | **changed by repair** (was `1f0a03b14bd7862e3756445bff1252a9138fa2491f387adc57ca90dd1173dc84`) |
| `docs/execution-ledgers/checkpoints/207/checkpoint-report.md` | `418202558ec894d74d975dd4dd6550be9af9d4ca4cb20593bcc684f7e329147c` | transferred |
| `docs/execution-ledgers/checkpoints/207/file-hashes.txt` | `a89c1ebecfaedfa1a57fcc97b296c97da935e5b5828cdfce57bfa013b1c169c6` | transferred |
| `docs/superpowers/plans/2026-10-15-issue5-207-timeout-bound.md` | `2617c9dd4a5d53ad574efcd6c7efd5ead380d498f56a78f68c86ddb7681408d2` | approved plan copy |
| `docs/execution-ledgers/checkpoints/207/f1-repair/transfer.md` | `09f08f730eac738ce05490cad25f2ad8fd01caf2465d58241a840cd7e3d0eb12` | new (ledger) |
| `docs/execution-ledgers/checkpoints/207/f1-repair/red.md` | `81f628e19c039eceb0f80c28a3f8ef290615d2e205e08b973a5bfa4e1d297334` | new (ledger) |
| `docs/execution-ledgers/checkpoints/207/f1-repair/green.md` | `801b7d1e0a002abfdd48973b8a3e4ee2cb27b6e87835ed55639f700e89d63300` | new (ledger) |

## Verification (all run serially; exact commands and exit codes)

```
cd server
bun test tests/gateway-endpoint-config.test.ts
  → 16 pass / 0 fail / 45 expect()          exit 0
TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207 \
  bun test tests/gateway-endpoint-config.integration.test.ts
  → 9 pass / 0 fail / 33 expect()           exit 0
bun run typecheck
  → tsc --noEmit                            exit 0
bunx biome lint --error-on-warnings server/src/gateway/endpoint.ts server/src/config.ts \
  server/tests/gateway-endpoint-config.test.ts server/tests/gateway-endpoint-config.integration.test.ts
  → Checked 4 files. No fixes applied.      exit 0   (from repo root)
bun test tests/config.test.ts
  → 140 pass / 1 fail (documented pre-existing BASE failure, unchanged baseline)
```

`bunx biome format` on the 4 files still flags pre-existing checkpoint regions only (identical flags on the byte-identical source files; every repair-authored line is format-clean). Database state after run: `openbot_207.gateway_configs` = 0 rows; no other database touched (`openbot`, `openbot_test`, `openbot_wave1` exist but were never connected to).

## TDD evidence

- RED (`red.md`): before implementation — unit 12 pass / 4 fail (each new assertion failing for the missing bound: 2_147_483_648 accepted, env 2147483648 accepted, env message not shared-sentence, route reached the DB → 500); integration 8 pass / 1 fail with the exact F1 reproduction `PostgresError: integer out of range` (errno 22003) → `Expected: 400 / Received: 500`.
- GREEN (`green.md`): after the minimal implementation above — 16/0 and 9/0, exit 0, plus typecheck/lint/config.test.ts baseline.

## Remaining limitations (for the independent reviewer)

1. Boundary is int4 alignment only; no operational cap (e.g. 600 000 ms) was added — the reviewer offered either; the plan chose int4.
2. The env rejection message for low values changed wording to the shared sentence (`GATEWAY_REQUEST_TIMEOUT_MS: requestTimeoutMs must be a whole number...`); accepted values and all rejection semantics are unchanged.
3. Pre-existing `biome format` drift in the checkpoint's untouched lines was left as-is to keep the repair delta exactly F1.
4. Reviewer findings F2 (journal trailing newline) and F5 (0122 migration-number collision) remain out of this task's scope (F1-only dispatch).
5. Routes remain unmounted in app.ts (unchanged checkpoint decision, F5/01.2 follow-up).

**Status**: implementation complete; awaiting independent reviewer — not self-approved.
