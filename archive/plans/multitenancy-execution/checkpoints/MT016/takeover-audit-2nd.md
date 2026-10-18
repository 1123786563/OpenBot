# MT016 接管审计（第 2 任）— 逐文件处置

对照：MT016-brief.md（权威）+ brief-2nd.md 接管规则 + Issue #59 票面 5 条 +
brief 票面 4 条。基线/前置证据（PLAN.md、before-hashes.txt、RED-1、
00-apply-prereq-tasks.txt、01-baseline.txt）全部保留为第 1 任证据。

## 保留（合规）

| 文件 | 处置 | 依据 |
| --- | --- | --- |
| `server/src/db/schema/enterprise-bot-ownership.ts` | 保留 | 2 新表（归属+偏好）、复合 FK、全局唯一索引、RLS/GRANT 与迁移 SQL 逐条对应；expand-only |
| `server/scripts/multitenancy/migrate-test.ts` 的 MT016 任务注册 | 保留 | 授权编辑点 #1；2 步（tables+rls）；TASKS 注册表追加；digest 确定 |
| `server/src/db/schema/index.ts` barrel 追加 `enterprise-bot-ownership` | 保留 | 授权编辑点 #3（1 行） |
| `server/tests/multitenancy/bots-ownership.test.ts` | 保留 | 验收逐条映射完整（brief 4 条 + issue 5 条 + canonical 形状 + 迁移契约）；0 skip 门槛由 itDb 探针保证 |
| checkpoints/MT016/ 第 1 任证据 | 保留 | 恢复纪律：不删除前人证据 |

## 修复（缺口——第 1 任死因迹象：RED 循环中断）

1. `server/src/enterprise/tenancy/bots-ownership.ts`
   - **缺口**：可见性门/创建/列表/计数只重验团队级成员关系，缺**公司级成员
     重验**（status='active' 且 epoch === scope.memberEpoch）。公司成员资格
     被 provision.suspendMembership 暂停后，已签发 scope 仍可通过全部判定
     ——违反测试「撤权后 create 响亮拒绝、读取 fail-closed not-found」与
     Spec §5.2。先例：scope-gate.ts（MT005 canonical 重验）。
   - **修复**：readVisibleOwnership join enterprise_memberships 并要求
     active + epoch 匹配；createBot/listBots/countBots 的成员重验同升。
2. `server/tests/multitenancy/support/bots-ownership.ts`
   - **缺口 A**：`suspendTeamMember` 引用 `createCompanyAdminAuthorizer` /
     `createWorkspaceAdminService` 但**未 import**（运行时 ReferenceError、
     typecheck 失败）。
   - **缺口 B**：夹具接口暴露 `suspendTeamMember(tenant, workspace,
     principal)`，测试调用 `suspendCompanyMembership(tenant, principal)`——
     契约错位。
   - **缺口 C**：`suspendMembership` import 未使用（biome 拒绝）。
   - **修复**：删除坏的 suspendTeamMember 实现，改为
     `suspendCompanyMembership(tenantId, principalId)` 经真实
     provision.suspendMembership（support/fixture.ts 同款先例）。
3. `server/tests/multitenancy/migration-tool.test.ts`
   - **缺口**：穷举断言无 "MT016" 行（10 任务 → 应为 11 任务注册表）。
   - **修复**：授权编辑点 #2——仅该断言追加 "MT016" + 裁决注释；
     其余内容保持只读。

## 新增（第 2 任）

- checkpoints/MT016/verification/02-env-setup-2nd.txt（容器 mt016-impl2-pg，
  端口 55502——55501 被 mt069-impl-pg 占用，按 brief +1 并记录）
- 后续 red-green/mutation/verification 证据均带 `-2nd` 后缀
