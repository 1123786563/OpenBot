# Issue #207 (Bifrost 01.1) — 检查点转移 + 独立复验（run 2, worktree issue5-207-2）

- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-207-2`，分支 `1123786563/issue5-207-2`
- **BASE**: `bab7c0b9`（`f0520524` + 1 个纯 docs 提交；`server/` 与前置 BASE 无差异，转移无冲突）
- **Dispatch**: task `task_7f4a637f3052` / `ctx_15a6323054f7`
- **前序事实**: 前一次派发已在 `issue5-207-timeout` 工作树完成本票实现并通过 F1 修复
  （Medium：requestTimeoutMs 无上界 → int4 上界 2,147,483,647）与独立终审
  （`checkpoints/207/f1-repair/{report,final-review}.md`，结论 PASS/APPROVE）。
  按 Ticket #207 Handoff「接手者读本节 + Verification 即可续做」续做，不重做产品发现。

## 任务

把已验证的 F1 修复后检查点字节级转移到本工作树，并在本工作树独立重跑全部验证
（单测 / 集成 / typecheck / lint / 迁移应用），产出本工作树自己的检查点报告、
哈希清单与 review 包。不 commit、不 push、不改父 Issue。

## 转移清单（12 个实现文件，SHA-256 以 f1-repair/report.md 清单为准）

新增：`server/src/gateway/{endpoint,config-store,routes}.ts`、
`server/src/db/schema/gateway.ts`、`server/drizzle/0122_gateway_endpoint_config.sql`、
`server/drizzle/meta/0122_snapshot.json`、
`server/tests/gateway-endpoint-config{,.integration}.test.ts`

修改：`server/src/config.ts`、`server/src/db/schema/index.ts`、
`server/drizzle.config.ts`、`server/drizzle/meta/_journal.json`

## 验证（RED/GREEN 证据来自前次 TDD；本次为 GREEN 复验）

1. `shasum -a 256` 逐一核对 12 文件 == f1-repair 终稿清单（4 个 repair 后哈希 + 8 个 checkpoint 哈希）。
2. 专用测试库：`docker exec openbot-postgres-1 createdb openbot_207_2` →
   `DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207_2 bun scripts/migrate.ts`。
   不触碰 `openbot`（开发库）/`openbot_test`/他票专用库。
3. `cd server && bun test tests/gateway-endpoint-config.test.ts` — 期望 16 pass / 0 fail。
4. `TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_207_2 bun test tests/gateway-endpoint-config.integration.test.ts` — 期望 9 pass / 0 fail。
5. `cd server && bun run typecheck` — 期望 exit 0。
6. `bunx biome lint --error-on-warnings`（12 个改动文件）— 期望 exit 0。
7. 回归：`bun test tests/config.test.ts` — 允许且仅允许 BASE 既有的 1 个已知失败
   （"enables Google authentication…"，前次已在 BASE 上复现归因）。

## 交付

- 未提交检查点（`git status` 即检查点）+ `archive/execution-ledgers/checkpoints/207-r2/`
  下本工作树自己的 checkpoint-report.md、file-hashes.txt、verify.md（命令与输出证据）、
  review.md（本次复审结论）。
- 票面差异沿用前次已审查决策：专用 `gateway_configs` 单行表替代 EnterpriseSettings KV 行
  （原子 `config_version+1`，结构性单调）；routes 不挂载 app.ts、config 不注入容器
  （app.ts 越出 write scope，留给 01.7/01.8 集成票）；迁移为手工构造
  （BASE 上 drizzle-kit generate 因既有快照链冲突不可用，前次已复现归因）。
