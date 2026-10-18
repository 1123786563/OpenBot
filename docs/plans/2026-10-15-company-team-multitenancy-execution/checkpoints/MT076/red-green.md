# MT076 — TDD RED→GREEN 记录

## RED-1（模块缺失，MT026 RED-2 同型）

- 新增 `server/tests/multitenancy/people-lifecycle.test.ts`（16 用例，票面四条 AC 逐条对应 describe）+ `server/tests/multitenancy/support/people-lifecycle.ts`（真实 MT006 authorizer 签发上下文 + 真实 MT026 reconciler 做 AC4 对照 + b-admin + 目录供应的双公司成员夹具）。
- 被测模块不存在 → 整文件失败：`error: Cannot find module '../../src/enterprise/tenancy/people-lifecycle'`，0 pass / 1 fail（verification/01-red-fullfile.txt）。失败原因 = 功能缺失，非笔误。

## RED-2（迁移授权缺失，自然实验）

- 首版实现后聚焦套件 11 pass / 4 fail（verification/02-green-first.txt）：提升/降级全部 `permission denied for table enterprise_memberships`（Postgres 42501）。
- 根因（领取勘察即复核）：0056 基线 operator 角色列级 UPDATE 仅 `("status","epoch")`；`role` 列无授权。→ 开出 MT076 迁移任务（migrate-test.ts 追加）。
- 迁移任务注册后，migration-tool.test.ts 穷举断言先失败（注册表与断言不同步，RED），追加断言行 "MT076" 后该文件回绿（42 pass / 1 skip——skip 为 assigned 库集成用例，全量态不跳过）。
- MT076 迁移 apply 后，4 个失败用例全部转绿。

## GREEN

- `createCompanyPeopleLifecycleService` 最小实现（promote/demote/offboard + 封闭审计集合 + 共享事务骨架）→ 聚焦套件 15/15（03 首录），后补 2 条 INVALID_REQUEST 用例与三动作伪造上下文用例 → **16/16 / 0 fail / 0 skip**（verification/03-green-focused.txt，58 pass 含 migration-tool 42）。

## REFACTOR

- 移除 `withTargetMember` 内重复的信任断言（各公开动作入口已按 MT006 形状首行断言）。
- grants 逐行删除补 `.returning` + `deleted.length !== 1` 校验（锁下刚枚举的行删不动即策略故障，响亮失败）。
- `membership?.status !== "active"` optional-chain（biome lint）+ 解构收窄（tsc 严格）。
- 重构后聚焦 16/16、全量 593/0/23、tsc 0、biome 5 文件 0 error 0 warning。

## 测试与 AC 对应（16 用例）

| AC | describe | 用例数 |
|---|---|---|
| AC2 提升/降级本公司范围 | promote/demote touch only this company's role | 5 |
| AC1 离职本公司范围 | offboarding in company A touches company A only | 3 |
| AC3 不可见语义 + 审计 | unauthorized callers …; executed actions leave audit | 5 |
| AC4 与 SCIM 一致 | admin offboard matches SCIM deprovision semantics | 3 |
