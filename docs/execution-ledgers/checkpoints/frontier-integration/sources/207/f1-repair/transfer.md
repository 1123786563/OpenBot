# F1 Repair — Checkpoint Transfer Ledger (Task 1)

- **Date**: 2026-10-15
- **Purpose**: Repair of independent reviewer finding **F1 (Medium)** — timeout without upper bound → PostgreSQL int4 overflow → HTTP 500 — per parent plan `docs/superpowers/plans/2026-10-15-issue5-207-timeout-bound.md`.
- **Source worktree (user-owned, read-only)**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207`, branch `1123786563/issue5-207`, **HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`**, checkpoint form: uncommitted workspace snapshot (4 modified + 10 untracked files).
- **Target worktree (this repair child)**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-timeout`, branch `1123786563/issue5-207-timeout`, **HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`** (identical BASE; clean before transfer).

## Transferred files (12 deliverables + 2 checkpoint ledger docs)

Full SHA-256 computed independently at both sides after copy (`shasum -a 256`); every source/target pair is byte-identical, and all 12 deliverable hashes equal the independent reviewer's full-SHA table in `checkpoints/207/review.md`.

| # | File | Status in checkpoint | Full SHA-256 (source == target) |
|---|------|----------------------|--------------------------------|
| 1 | `server/src/gateway/endpoint.ts` | untracked | `e845082383207ddce61f61e6100753d852b1a81fe3ba077a8ff8c27187bb0534` |
| 2 | `server/src/gateway/config-store.ts` | untracked | `963f082e066142c8efc5191dc31352348331c84840a52e53dbf0e5db362b77c3` |
| 3 | `server/src/gateway/routes.ts` | untracked | `da7e54dec6b9f12f90eccf3a56e225462834ea889c0c7910a42374993fbcc2f0` |
| 4 | `server/src/db/schema/gateway.ts` | untracked | `849f91868518de0f3651676ae3428ee3c8e747429a98a13df3ae166714128f2d` |
| 5 | `server/src/db/schema/index.ts` | modified | `f8fa962c18c03f6a3d2769a1bc371a7aa267312f36103b92d2112c931a4dacef` |
| 6 | `server/drizzle.config.ts` | modified | `16e5456f894c58280b1d609b87708a30fe1b69d6c568f0618228719795863f32` |
| 7 | `server/src/config.ts` | modified | `05873af2d6b5ccb270244177160df13dd5a2b7a684dab2708bd77aab9f808f00` |
| 8 | `server/drizzle/0122_gateway_endpoint_config.sql` | untracked | `e452ae4f93086d2ca3d10a8b50e3a3db983e7d62ce8e3260811ac1e12da758d1` |
| 9 | `server/drizzle/meta/0122_snapshot.json` | untracked | `31b406c9d58917e6da33276120e4e59fe477bd40f90fd54fba50737f5f714ff9` |
| 10 | `server/drizzle/meta/_journal.json` | modified | `39e657fba083cd70d155857ff38f3ce85abd103f51d0c208cacf19f0e9be2cf8` |
| 11 | `server/tests/gateway-endpoint-config.test.ts` | untracked | `838cc2f9c9d53175b1513866fe01d6a95e82c39d57aef47f508be8a80d308827` |
| 12 | `server/tests/gateway-endpoint-config.integration.test.ts` | untracked | `1f0a03b14bd7862e3756445bff1252a9138fa2491f387adc57ca90dd1173dc84` |
| 13 | `docs/execution-ledgers/checkpoints/207/checkpoint-report.md` | ledger doc | `418202558ec894d74d975dd4dd6550be9af9d4ca4cb20593bcc684f7e329147c` |
| 14 | `docs/execution-ledgers/checkpoints/207/file-hashes.txt` | ledger doc | `a89c1ebecfaedfa1a57fcc97b296c97da935e5b5828cdfce57bfa013b1c169c6` |

Additional approved-plan copy (not part of the source checkpoint): `docs/superpowers/plans/2026-10-15-issue5-207-timeout-bound.md` = `2617c9dd4a5d53ad574efcd6c7efd5ead380d498f56a78f68c86ddb7681408d2` (byte-identical to the parent repair plan in `issue5-execution`).

## Post-transfer target status

`git status --porcelain -uall` reproduces exactly the source checkpoint shape (4 `M` + 10 `??`) plus the plan copy and this ledger directory — nothing else. No commit, no staging, no push. Source worktree was only read (`cp`/`shasum`); no writes were made to it.

## Scope of this repair (from dispatch)

- Only `server/src/gateway/endpoint.ts`, `server/src/config.ts` (**only** the `gatewayEnvConfig` block; do not touch the #209-disjoint `bifrostConversionRate` block), `server/tests/gateway-endpoint-config.test.ts`, `server/tests/gateway-endpoint-config.integration.test.ts` may change beyond the transfer.
- New docs allowed only in `docs/execution-ledgers/checkpoints/207/f1-repair/` (`transfer.md`, `red.md`, `green.md`, `report.md`).
- Tests run serially against dedicated `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207` only.
