# Bifrost 01.3（Issue #209）执行检查点 — 2026-10-15

执行者：dispatched worker（task_f45c9d92c8ea / dispatch ctx_ce5531931320）
基础提交：`f0520524`（main，worktree `issue5-209`，分支 `1123786563/issue5-209`）
状态：**未提交**（按调度约束：不 commit / 不 push / 不 publish）。文件哈希清单见下，接手者可用其核对工作区未被改动。

## RED → GREEN 证据

1. **RED（先写失败测试）**
   - `bun test server/tests/gateway-conversion-rate.test.ts` → `0 pass / 1 fail`：`Cannot find module '../src/gateway/conversion-rate'`（功能缺失导致的失败，非笔误）。
   - `TEST_DATABASE_URL=… bun test server/tests/gateway-conversion-rate.integration.test.ts` → 同样的模块缺失失败。
   - 写入纯模块后、接入 `config.ts` 前：45 例中 boot 路径 18 例继续失败（`loadConfig` 未接校验）——config 接缝的第二次 RED。
2. **GREEN**
   - 单元：`bun test server/tests/gateway-conversion-rate.test.ts` → **45 pass / 0 fail**。
   - 集成：`TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5569/openbot_test bun test server/tests/gateway-conversion-rate.integration.test.ts` → **12 pass / 0 fail**。
   - 两文件合计：**57 pass / 0 fail**。

## 验证命令（按 Ticket Verification 块，均可重跑）

```bash
bun test server/tests/gateway-conversion-rate.test.ts
# → 45 pass / 0 fail（136 expect）

TEST_DATABASE_URL=postgres://openbot:openbot@localhost:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
# → 12 pass / 0 fail（38 expect）

bun run --filter server typecheck
# → server typecheck: Exited with code 0

bunx biome lint --error-on-warnings \
  server/src/gateway/conversion-rate.ts \
  server/src/gateway/conversion-rate-store.ts \
  server/src/config.ts \
  server/tests/gateway-conversion-rate.test.ts \
  server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 5 files. No fixes applied.（无警告）
```

## 测试数据库（专用，未触碰任何生产/开发库）

- 容器 `openbot-issue5-209-pg`（pgvector/pgvector:pg17，127.0.0.1:5569，openbot/openbot，库 openbot_test）。
- 基线对照库 `openbot-issue5-209-baseline-pg`（127.0.0.1:5570，仅用于 pristine main 的预存失败比对）。
- 迁移执行：`server/ops/enterprise/roles.sql` → `DATABASE_URL=…5569/openbot_test bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`。

## 回归说明（预存失败，非本 Ticket 引入）

全量 `bun test`（server，8058 例）：7944 pass / 95 fail / 19 skip。在 pristine main（`/Users/wuyongjun/trea/OpenBot` @ f0520524，同样规格的全新基线库）重跑失败集中的代表性文件（`tests/enterprise/migration-runner-guard|runtime-artifacts|tenancy-rls.integration`、`tests/config.test.ts`、`src/knowledge/retrieval.test.ts`），**同样失败**：enterprise RLS/目录校验类、config.test.ts 的 Google auth `emailPassword` 断言、knowledge retriever（需在线 kb 服务）。结论：全部为预存/环境性失败，与本 diff 无关；本 diff 未使任何原本通过的用例失败。

## 文件清单与哈希（SHA-256，未提交状态）

```
d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034  server/src/gateway/conversion-rate.ts          (新增)
b896526631ff46f7f872ed8c4e14f8befa599cffd25980573aa3700bece2f538  server/src/gateway/conversion-rate-store.ts   (新增)
5b28118a01e63245ecbe61bdc2d12f77876972faa1ecda77dd15afbf252cc86b  server/src/config.ts                          (修改)
89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38  server/tests/gateway-conversion-rate.test.ts           (新增)
23bbd49bc150948b412e40ef183126fd4911c75727669d874f131b1ec58b1506  server/tests/gateway-conversion-rate.integration.test.ts (新增)
```

`git status`：仅上述 5 处（` M server/src/config.ts`，`?? server/src/gateway/`，两条 `?? server/tests/gateway-conversion-rate*.test.ts`）。

## 失败即弃

本 Ticket 未污染任何前置 Ticket：无共享前置（Blocked by: None），未触碰 #207/#215/#234 的文件。接手者读本文件 + 同目录 `report.md` 即可续做。
