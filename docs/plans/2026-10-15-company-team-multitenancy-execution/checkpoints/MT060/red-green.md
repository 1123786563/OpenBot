# MT060 RED→GREEN 记录（波次 15，三轮接力完成）

聚焦套件：`server/tests/multitenancy/openmuse-tasks.test.ts`（AC1–AC4 四组）。
证据文件均在本目录；结论性数字以亲跑输出为准。

## RED

- `RED-1-module-missing.txt`（worker#1，10:39）：模块缺失整组红
  `Cannot find module '../../src/enterprise/tenancy/openmuse-task-tenancy'`——
  0 pass / 1 fail / 1 error。

## GREEN（三轮接力）

- `GREEN-1-first.txt`（worker#2，10:42）：23 pass / **7 fail**（AC3×3 + AC4×4）。
  worker#2 于此后停滞（transcript 953 行），mutation 未开始。
- **worker#3（本轮）接任诊断**：树内无未复原变异残留（mutation 未开始）；
  7 个失败归因三处 GREEN 中断缺陷（全部位于本票自有新文件，零冻结面改动）：
  1. `previewLegacyBackfill` 在受限 data 通道执行分类 SQL →
     `permission denied for table openmuse_tasks`（设计本意平台通道，注释已写明）。
  2. fixture `issueScheduleScope` 会话缝键名错位（facts.actorId 存入、
     authenticate 读 session.userId）→ `AUTH_REQUIRED` → 一切 schedule 签发
     异常 → AC4 重建/租约面以 `OPENMUSE_TASK_SCOPE_REVOKED` 响亮拒绝。
     （撤权用例因同一错误路径"歪打正着"通过，接任后复跑仍真通过。）
  3. AC2 用例 4 在 b1 留下 60s 活租约未释放 → AC4「他人持活租约」用例的
     holder 认领确定性撞 `JOB_LEASE_HELD`（测试资源泄漏，非实现缺陷）。
- 修复（本票自有文件三处）：
  - 服务增 `platform` 平台主库通道依赖（与生产装配同源，设计 §2），preview 改经它；
  - fixture 会话缝改存 `{userId: facts.actorId, …}` 并把 platform 传入服务；
  - AC2 用例 4 末尾释放 b1 租约（断言全部先行，零验证弱化）。
- **新增 1 条 AC1 用例**（见 mutation/MUT-1 论证）：同一人跨团队上下文
  （RLS 主体自读臂对同一人全公司可见，三元组第二道防线是唯一隔离）——
  填补「A1 pin 的任务从 A2 读取/取消」覆盖缺口。
- `GREEN-2-all-green.txt`：**30 pass / 0 fail**（修复后首跑）。
- 新增用例落位后聚焦复跑：**31 pass / 0 fail**（168 expect）。

## REFACTOR

本轮接任修复均为最小改动；服务/测试结构（worker#2 交付面）已按设计分区，
无重复判定可合并，REFACTOR 为 no-op（零行为改动，避免无谓 churn）。
最终聚焦 31/0 + 全量回归 1155/0 复跑见 verification/11。
