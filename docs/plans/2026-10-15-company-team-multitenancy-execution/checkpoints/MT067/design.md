# MT067 设计 — 退出公司与全局账号删除是两个不同操作（Issue #110）

日期：2026-10-19。树=w16-mt067（BASE f0520524 + 284 项 prereq 快照，含波次 14/15 全部
verified 交付；prereq-manifest 284/284 亲算通过）。事实源：Issue #110 票面 + 父 Spec
§4.2/§5.2/§9/§11（A5/A1/A2）+ ADR 0004 + CONTEXT.md「公司与团队」。本文件是实施设计
与变异计划；结论性数字以 checkpoints/MT067/verification/ 亲跑证据为准。

## 0. 票面四条验收 → 实现面映射

| # | 验收（票面原文） | 实现面 | 证明（聚焦套件用例组） |
|---|---|---|---|
| AC1 | 公司管理员只能清理本公司范围内该成员的数据与资格；全局身份与其他公司资格保留 | `deletion-semantics.ts` Track A `cleanupCompanyMemberData`：受信 CompanyAdminContext（MT006）→ 单 operator 事务（pin app.tenant_id + app.operator_principal_id）→ 管理员重验 → 只清本公司事实（公司成员行停用、团队成员行删除、资源授权删行、任务协会删行、连接凭据撤销、凭据动作删行）；users/principals 行零触碰=结构（模块不 import §9 标记面） | AC1 组（双公司矩阵逐项断言：他公司成员行/授权行/协会行/凭据行原样；users+principals 行原样；§9 标记零写入；非成员/伪造 principal = COMPANY_MEMBER_NOT_FOUND 不可区分） |
| AC2 | 全局账号删除是独立、显式授权的操作，不能被公司管理动作触发 | Track B `deleteGlobalAccount`：独立服务（签名只收 `{userId, confirmation}`，**API 形状上不存在 admin 上下文参数**）；显式确认短语常量比对，错/缺 → `GLOBAL_DELETION_CONFIRMATION_REQUIRED` 零写入；fence 消费真实 §9 store（insert-once 标记先行）→ 全公司资格停用（每公司 epoch+1 + 审计） | AC2 组（缺确认/错确认/空 userId 响亮拒绝且零副作用；公司管理动作（MT076 三动作 + 本票 Track A）执行后 §9 标记仍零行；Track B 后全公司成员行停用但 users/principals 原样（fence 语义，物理清除属 MT068）） |
| AC3 | 退出公司后该范围内的任务、连接、文件与订阅失效；其他范围不受影响 | 失效 = 范围事实撤除：任务协会行删除（MT060 协会=可见性权威）→ 任务对一切 scope 不可见；个人连接凭据 status→revoked（MT027 撤销语义）；资源授权行删除（文件/KB 等 grant 授权对象不可达）；团队成员行删除 + 公司成员停用 → 后续 HTTP 请求/订阅在真实 scope 解析器处拒绝（A5） | AC3 组（清理后：requestAs 真实 403/404 失败；任务协会零行；凭据 revoked；grant 零行；对照面——同用户公司 B 任务/凭据/成员资格全部原样可用、同公司他成员数据原样） |
| AC4 | 两种操作的响应与审计记录可区分，不产生歧义 | 响应形状：Track A `{outcome:"company_scope_cleaned", tenantId, …}` vs Track B `{outcome:"global_deletion_fenced", userId, marker…}`（outcome 字符串、键集合、租户面/全局面三重差异）；审计：Track A 写 `company_member.data_cleaned`（仅被清理公司）；Track B 写 `global_account.membership_revoked`（每个受影响公司各一条）+ §9 标记行（全局面，公司清理永不产生） | AC4 组（两 outcome 字符串互异且各自封闭；审计事件类型集合互斥逐字断言；Track A 后目标公司只有 data_cleaned 一条、无 global_account.*；Track B 后每公司只有 global_account.membership_revoked、无 data_cleaned） |

## 1. 领域模型：零新表，一道授权补齐

双轨域不新增持久化对象——清理/删除的权威事实全部落在既有表（成员、团队成员、资源授权、
MT060 任务协会、MT027 凭据、§9 删除标记）。唯一结构缺口：

- `enterprise_workspace_memberships` 有 operator INSERT/UPDATE（MT004/MT012），**无
  DELETE 策略与授权**——清理要摘除团队成员资格行，没有这条授权就只能绕过 RLS（禁止）。
  MT067 迁移补：operator DELETE 策略（pin app.tenant_id + app.operator_principal_id，
  与同表既有 UPDATE 行策略同形）+ `GRANT DELETE`。

其余全部复用既有授权：`enterprise_resource_grants` DELETE（0056 基线，MT076 先例消费）、
`openmuse_task_scopes` DELETE（MT060，pin tenant+principal）、`enterprise_credential_actions`
DELETE（MT027）、`enterprise_credentials` 全列 UPDATE（MT027，pin tenant）、
`enterprise_memberships` UPDATE status/epoch（0056）+ role 列（MT076——本票不写 role）、
`enterprise_security_events` INSERT（pin tenant+operation_id，MT075/MT076 同通道）。

§9 标记（`openmuse_account_deletions`，无 RLS 的全局面表）只在 Track B 经**真实 §9 store**
（`createOpenMuseAccountDeletionStore().delete`，insert-once + 重 fencing 语义原样消费）
写入；Track A 模块结构上不 import 该面。

## 2. 服务面（`server/src/enterprise/tenancy/deletion-semantics.ts`）

```
DELETION_SEMANTICS_AUDIT_EVENT_TYPES = [
  "company_member.data_cleaned",          // Track A（被清理公司一条）
  "global_account.membership_revoked",    // Track B（每个受影响公司一条）
]                                        // 封闭集合，跨面互斥由类型集合 + 测试钉死
GLOBAL_DELETION_CONFIRMATION = "delete-my-account-permanently"

createCompanyMemberCleanupService(operator: OperatorDatabase): {
  cleanupCompanyMemberData(context: CompanyAdminContext,
    input: {principalId}): Promise<CompanyCleanupReport>
}
// CompanyCleanupReport = { outcome:"company_scope_cleaned", tenantId, principalId,
//   membership:{status:"suspended", epoch}, workspaceMembershipsRemoved, grantsDeleted,
//   taskScopesRemoved, credentialActionsRemoved, credentialsRevoked, auditEventId }

createGlobalAccountDeletionService(deps{operator, directory, fence}): {
  deleteGlobalAccount(input:{userId, confirmation}): Promise<GlobalDeletionReport>
}
// GlobalDeletionReport = { outcome:"global_deletion_fenced", userId,
//   disabledAt(ISO), phase:"fenced", companiesRevoked, auditEventIds }
```

- **Track A 事务纪律**（与 MT076 逐字同构）：assertTrustedAdminContext → read committed +
  lock/statement timeout → pin app.tenant_id=admin 公司、app.operator_principal_id=admin →
  advisory 排他锁（规范序：tenant → membership(admin) → membership(target)）→ 事务内
  tenant_admin + epoch + principal 重验（漂移 SCOPE_REVOKED）→ pinTarget → 目标成员行
  active 校验（缺行/非在职 = COMPANY_MEMBER_NOT_FOUND，无存在性泄漏）→ 清理序列 →
  审计 → 提交。清理序列顺序（同事务内全部 RLS pin 死本公司）：
  1. 团队成员行 DELETE（新 MT067 策略 pin tenant+operator_principal_id=目标）；
  2. 资源授权行：先枚举（pin app.resource_id 逐行）后逐行 DELETE（MT076/MT007 撤权=删行
     范式，逐行删 `deleted.length !== 1` = 策略故障响亮拒绝）；
  3. 任务协会行 DELETE（MT060 策略 pin tenant+principal=目标）；
  4. 凭据动作行 DELETE（MT027 策略 pin tenant；WHERE principal_id=目标）；
  5. 个人连接凭据 UPDATE status='revoked'（WHERE owner_principal_id=目标 AND status='active'）；
  6. 公司成员行 UPDATE suspended + epoch+1（MT076 同款 CAS，冲突 COMPANY_CLEANUP_CONFLICT）；
  7. 审计 `company_member.data_cleaned`（details 带五类计数 + offboard 同款 epoch）。
- **Track B 序列**：输入校验（userId 非空；confirmation 逐字等于常量，错/缺 →
  GLOBAL_DELETION_CONFIRMATION_REQUIRED，任何写都不发生）→ §9 fence 先行（真实 store
  delete：insert-once，重复调用幂等返回同一 marker、同一 disabledAt；lifted 标记重新
  fencing）→ directory 通道（pin app.user_id=目标，self-read 策略天然跨公司且只及本人）
  枚举 active 成员行 → 对每公司逐次 operator 事务：pin tenant=该公司 +
  operator_principal_id=目标 → membership 锁（跨公司按 tenantId 排序取锁，防死锁）→
  行仍 active 才 UPDATE suspended + epoch+1 → 审计 `global_account.membership_revoked`
  （details 带 actor=本人 + 全局 marker 事实）。users/principals 行零触碰——全局身份由
  §9 fence 使后续认证请求失效，物理清除是 MT068 的 purge 面。
- **结构性分离（AC2 的"不能被触发"）**：Track A 的模块不 import §9 store/表；Track B 的
  签名没有 CompanyAdminContext 参数（跨公司管理动作在形状上不可达全局删除）；两个服务
  无共享可变状态，唯一共享物是 per-(tenant,principal) membership advisory 锁族（并发互斥）。

## 3. 迁移（MT067，单步，注册于 migrate-test.ts TASKS 表尾=MT060 之后）

`workspace_membership_cleanup_delete`：
- `CREATE POLICY "enterprise_workspace_membership_operator_delete" ON
  "enterprise_workspace_memberships" FOR DELETE TO ob_ent_operator USING (tenant_id =
  nullif(current_setting('app.tenant_id', true), '') AND principal_id =
  nullif(current_setting('app.operator_principal_id', true), ''));`
- `GRANT DELETE ON TABLE "enterprise_workspace_memberships" TO ob_ent_operator;`

expand-only：新策略 + 新授权，不改既有表/列/约束/策略/授权；表已 ENABLE+FORCE RLS
（MT012）。授权窄缝（3 处，brief 预授权「纯追加」）：migrate-test.ts += MT067 任务块 +
TASKS 注册 1 行；migration-tool.test.ts += allowlist "MT067"（排序位 MT060<**MT067**<MT069，
ruling #5 第 20 次先例，带裁决注释）；scenarios.ts += ISOLATION_DOMAINS "deletion"
（域注册表自述「A domain that gains a task gets its name here in the same change」的
纯追加先例，not-found-semantics 同款）。无新 schema 文件 → schema/index.ts 零改动。

## 4. TDD 计划

RED：新建 `tests/multitenancy/deletion-semantics.test.ts` + `support/deletion-semantics.ts`
（people-lifecycle fixture 模式：isolation 矩阵 + verified 三通道 + 真实 MT006 管理员
authorizer；另加任务协会/凭据/授权/团队成员行的受限通道播种缝 + §9 marker 平台通道探针 +
真实 §9 store。缺 env 显式 skip）。首跑预期整组红：模块缺失（import 失败）。

GREEN：deletion-semantics.ts + 迁移注册落地 → 聚焦全绿。REFACTOR：不改行为收敛，聚焦+
全量复跑。

## 5. 变异自证计划（每安全分支 ≥1：注入→聚焦捕获→字节复原→复绿）

| 变异 | 打击面 | 预期捕获者 |
| --- | --- | --- |
| MUT-1 范围溢出 | Track A 的任务协会 DELETE 拔掉 principal 过滤（只 pin tenant）→ 同公司他人任务协会一并被删 | AC3「同公司他成员数据原样」（对照面任务协会计数不变） |
| MUT-2 确认弱化 | Track B 的确认短语比对放宽（前缀/大小写不敏感）→ 弱确认触发全局删除 | AC2「错确认响亮拒绝且零写入」 |
| MUT-3 审计合流 | Track B 每公司审计事件类型改写成 Track A 的 `company_member.data_cleaned` → 两轨审计不可区分 | AC4「审计事件类型互斥」 |
| MUT-4 越权资格 | Track A 跳过管理员重验（或 epoch 比对拔掉）→ 非管理员/漂移上下文可执行清理 | AC1/AC2「非管理员上下文被拒；epoch 漂移 SCOPE_REVOKED」 |

## 6. 边界与披露（诚实边界）

- 路由/装配不接（MT016/MT022/MT026/MT060 同例）：双轨服务面供下游接线票复用；
  `src/index.ts`、既有 §9 routes.ts 零改动。
- Track B 交付 fence + 全公司资格停用 + 审计；账户数据的物理清除、retention/restore 与
  manifest 执行权在 MT068（票面备注原文）。
- 双通道非原子：Track B 的 §9 fence（平台通道）与逐公司停用（operator 通道）各自提交；
  fence 先行 = §9 语义（fence 不依赖 cleanup），中途失败披露为「已 fenced、部分公司停用」，
  重放幂等收敛（marker 同 disabledAt；已停用公司零重复）。不声称跨通道原子性。
- "文件与订阅"的失效走本树真实存在的授权事实（资源授权行删除 + 成员资格失效 → 真实
  scope 解析器/资源读取器拒绝）；本树无独立的租户域文件表/订阅表，物理文件与外部订阅的
  清理属 MT068 purge 面——报告 D 项披露，不用假桩冒充文件字节删除。
- MT060 任务根记录（openmuse_tasks 行）零改动（既有 store 权威，冻结面）；清理只删协会行
  （可见性权威），任务行本身留待 MT068。
