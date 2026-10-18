# MT067 red-green 记录（Issue #110）

## RED（模块缺失，整组红）

- 证据：`red-green/RED-1-module-missing.txt`
- 命令：`bun test tests/multitenancy/deletion-semantics.test.ts`
- 结果：`Cannot find module '../../src/enterprise/tenancy/deletion-semantics'` —
  0 pass / 1 fail（import 失败，先于任何断言）。迁移尚未注册时同库 22 任务
  journal（前置链 42 步）。

## GREEN（模块 + 迁移落地，聚焦全绿）

- 落地件：deletion-semantics.ts（双轨服务）+ migrate-test.ts MT067 任务块
  （幂等条件策略 + GRANT）+ migration-tool.test.ts allowlist "MT067"。
- 迁移真实 apply：`applied: MT067 @ openbot_enterprise_w16d_test (127.0.0.1:55595)`，
  journal 22→23 任务 / 42→43 步；dry-run 重放「待应用 0 步」= 幂等。
- 证据：`red-green/GREEN-1-all-green.txt` — 12 pass / 0 fail / 92 expect。
- 收敛后（REFACTOR：import 合并 + biome organizeImports/format；新增第 13 用例
  「管理员上下文签发后成员行漂移 → SCOPE_RErevoked」）终态：**13 pass / 0 fail /
  98 expect**（verification/02-full-regression-final.txt 聚焦段）。

## 环境纪事（设计 → 实施的一处事实修正）

- 设计初稿假设 `enterprise_workspace_memberships` 缺 DELETE 授权需 MT067 迁移创建。
  实施首跑 apply 即 refused（policy already exists）：MT006 的 workspace-scope 测试
  夹具（`tests/multitenancy/support/workspace-scope.ts` `provisionOperatorDeletePolicy`）
  一直在测试库上夹具侧幂等预置同名策略与授权（夹具内注释披露的 stand-in 先例）。
  处置：MT067 迁移保留（生产环境的唯一权威创建方），策略语句改为 pg_policies
  目录条件幂等（MT012「幂等再断言」纪律），GRANT 重复执行为无操作——同一语句在
  全新生产库与预置过的测试库上都干净落地（亲跑 applied + up-to-date 重放）。
