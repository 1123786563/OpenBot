# Bifrost 01.3（Issue #209）重派执行检查点 — 2026-10-15

执行者：dispatched worker（task_70823a91f78b / dispatch ctx_a8e965009b72，worktree `issue5-209-2`）
基础提交：`bab7c0b9`（分支 `1123786563/issue5-209-2`；与 main `f0520524` 仅差一个 docs-only 提交，`server/` 零代码差异）
状态：**未提交**（按调度约束：不 commit / 不 push / 不 deploy）。

## 本次交付的性质（Transplant 申明）

本 dispatch 是同票重试。前任执行者（task_f45c9d92c8ea，worktree `issue5-209`，base `f0520524`）已交付经两轮独立只读 Review（review.md → final-review.md，Spec PASS / 质量 APPROVE、F1 并发缺陷已修复并复核）的未提交实现。本次将该已验证工作**逐字节移植**到本 worktree 的当前基线，并在本基线上独立重跑全部验证：

- 移植方式：5 个文件直接复制；本基线 `server/src/config.ts` 与 `f0520524` 版本 SHA-256 相同（`01870d4f…281d`），故移植后 5 文件哈希与前次 final-review manifest 全部一致（见下）。
- 未采纳 stale 分支 `1123786563/bifrost-wave1` 的旧实现（迁移 0113 与现 main 0121+ 冲突、契约缺 rateVersion），与前次执行者决策一致。
- 继承已记录的协调者决策：enterprise_settings 复用（无新迁移）/ 环境变量名 `BIFROST_CREDITS_PER_USD` / config.ts 独立区块。

## RED → GREEN 证据（在本基线独立产生）

1. **RED**：先只落 2 个测试文件，`bun test server/tests/gateway-conversion-rate.test.ts` → `0 pass / 1 fail`：`Cannot find module '../src/gateway/conversion-rate'`；集成测试同样因模块缺失失败（功能缺失型失败，非笔误）。
2. **GREEN**：落入 `server/src/gateway/conversion-rate.ts`、`conversion-rate-store.ts` 与修改后的 `server/src/config.ts` 后全部转绿（输出见下）。

## 验证命令与输出摘要（本基线，2026-10-15 实测）

```bash
git rev-parse HEAD          # → bab7c0b9（基线未移动）
bun test server/tests/gateway-conversion-rate.test.ts
# → 45 pass / 0 fail（136 expect）
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
# → 13 pass / 0 fail（46 expect）；串行重跑共 3 次，3/3 全绿（含 F1 并发用例，无 flake）
bun run --filter server typecheck
# → server typecheck: Exited with code 0
bunx biome lint --error-on-warnings \
  server/src/gateway/conversion-rate.ts server/src/gateway/conversion-rate-store.ts \
  server/src/config.ts \
  server/tests/gateway-conversion-rate.test.ts server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 5 files. No fixes applied.
bun test server/tests/config.test.ts      # → 140 pass / 1 fail（= 干净基线基线，预存 Google auth 失败，非本 diff 引入）
bun test server/tests/billing-config.test.ts  # → 41 pass / 0 fail
grep 全仓确认 bifrostConversionRate/readConversionRate/billingReadiness 在 gateway/+config.ts 之外零运行时消费点（无启用路径、无绕过）
```

## 测试数据库（专用，未触碰任何生产/开发库）

- 容器 `openbot-issue5-209-pg`（127.0.0.1:5569，openbot/openbot，库 `openbot_test`，迁移已就绪）；运行前确认无其他会话占用，全部串行执行。
- 干净基线回归对照：`config.test.ts` 移植前 140 pass / 1 fail（Google auth `emailPassword` 预存失败），移植后完全一致 → 本 diff 未使任何原本通过的用例失败。

## 文件清单与哈希（SHA-256，未提交状态，实测）

```
d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034  server/src/gateway/conversion-rate.ts                    (新增)
eda84eb8d7613ab55ac3259bc6af42ff51a60f099b299a8f4d9b81150e9d00fc  server/src/gateway/conversion-rate-store.ts             (新增)
5b28118a01e63245ecbe61bdc2d12f77876972faa1ecda77dd15afbf252cc86b  server/src/config.ts                                    (修改, +31/-0)
89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38  server/tests/gateway-conversion-rate.test.ts            (新增)
50165a1c5ec6952962214fd92e37e8e754c9c9d017f810fbaae552850eea8357  server/tests/gateway-conversion-rate.integration.test.ts (新增)
```

5/5 与前次 dispatch 的 final-review manifest 一致（该 manifest 已经独立 reviewer 哈希链核验），即本次移植未引入任何字节级偏差。

`git status`：仅 ` M server/src/config.ts`、`?? server/src/gateway/`（2 文件）、2 个 `?? server/tests/gateway-conversion-rate*.test.ts` + 本 ledger 目录。

## 失败即弃

无共享前置（Blocked by: None），未触碰 #207/#215/#234 文件；两 worktree 的 #209 实现逐字节等价，任一可独立续做，#210 接手者读本目录 + 前次 `issue5-209` ledger 的 review 包即可。
