# MT060 设计 — OpenMuse 任务/计划/监控/租约归属域（Issue #103）

日期：2026-10-18。树=w15-mt060（BASE f0520524 + 268 项 prereq）。事实源：Issue #103 票面 +
父 Spec §4.2/§5/§6/§11（A1/A2/A8）+ ADR 0004 + CONTEXT.md。本文件是实施设计与变异计划；
结论性数字以 checkpoints/MT060/verification/ 亲跑证据为准。

## 0. 票面四条验收 → 实现面映射

| # | 验收（票面原文） | 实现面 | 证明（聚焦套件用例组） |
|---|---|---|---|
| AC1 | 列表、详情、更新与取消只作用于当前范围；跨范围 ID 返回不可见语义 | `openmuse-task-tenancy.ts` 的 list/read/cancel/pause/resume/retry/answerWait：受信 scope → 事务内成员重验 → 协会表三元组（租户臂 RLS + 应用层第二道防线）→ 命中才触达任务行；一切不可见 = MT011 canonical `RESOURCE_NOT_FOUND` 逐字节同形 | AC1 组（列表/详情/取消/暂停/重试/恢复/答等的正反两侧；缺席/跨团队/跨公司/他人四态错误集合大小=1；跨范围取消零副作用对照；撤权后立即失效） |
| AC2 | 任务锁与租约按范围隔离：公司 A 的锁不阻塞也不被公司 B 复用 | 租约 = MT041 既有系统（创建时 pin kind='task' + claim/renew/finish/release 消费）；锁 = 归属写入路径的作用域限定 advisory 锁（键含公司+团队+主体，跨公司键结构性不相交） | AC2 组（B 认领 A 的任务被拒且 A 租约行零变化；A 持锁期间 B 立即拿到自己任务的租约；B 对 A 任务 renew/finish/release 全部拒绝；A 释放后 B 仍不可认领；作用域锁键结构性互异 + 实际并行不阻塞） |
| AC3 | 只有 user_id 的旧根记录被补上公司与团队关联（迁移可 dry-run 预览） | 迁移第三步 `legacy_task_backfill`（幂等 INSERT..SELECT，唯一归属才回填，歧义/无归属保持无行=受控隔离）；服务面 `previewLegacyBackfill()` 只读预览（可回填集 + 隔离集），与迁移执行结果可对照；执行权在 MT117 | AC3 组（唯一成员归属→backfill 行三元组正确；双团队成员→隔离零行；无成员→隔离零行；preview 与实际回填逐行一致；preview 零写入；隔离任务对一切 scope 不可见） |
| AC4 | 后台触发遵守 MT042 的作用域重建规则 | `resolveForExecution` + `runUnderLease`：机器身份（消费 MT042 `createMachineScanIdentity`，只读）→ 元数据（task id）→ operator 通道 + `app.scan_sweep='on'` 读权威协会行（本票迁移自带的扫描臂）→ principal→user 经逐主体臂 → 真实签发入口 `createScopeResolver`（entrypoint="schedule"）产出受信 Scope → MT041 租约 → MT005 gate 事务内执行回调。消息 payload 字段从不参与判定 | AC4 组（伪造 hint 仍按权威行执行；无协会行→OPENMUSE_TASK_RECORD_MISSING 零回显；撤权→OPENMUSE_TASK_SCOPE_REVOKED；成功→租约+队列双 finish；失败→双 release；他人持活租约→跳过） |

## 1. 领域模型：`openmuse_task_scopes`（新表，唯一新持久化对象）

一行 = 一个 OpenMuse 任务根记录在一个 (公司, 团队, 主体) 三元组上的归属关联。这是
Spec §4.2「根对象的子记录：包含 tenant_id 并通过复合关联保持公司一致」的逐字形状：

```
openmuse_task_scopes
  task_id      text PK  FK→openmuse_tasks(id) ON DELETE CASCADE   -- 根记录（受约束关联）
  tenant_id    text NOT NULL  ┐ 复合 FK→enterprise_workspaces(tenant_id,id) CASCADE
  workspace_id text NOT NULL  ┘   （同时证明 workspace 属于该公司）
  principal_id text NOT NULL  ┐ 复合 FK→enterprise_memberships(tenant_id,principal_id) CASCADE
  user_id      text NOT NULL  ┘ FK→users(id) CASCADE（OpenBot 全局用户；不变量 owner_user_id=user_id）
  bot_id       text NOT NULL          -- 执行 Bot（新路径=pbot- 私有 Bot；回填行=旧 agent id）
  attribution  text CHECK in ('created','backfill') NOT NULL
  created_at / updated_at timestamptz DEFAULT now() NOT NULL
  INDEX (tenant_id, workspace_id, principal_id, created_at DESC, task_id)  -- 范围列表
```

- **写入纪律**：create-once。同任务重放同三元组 = 幂等返回 existing（零写入）；携带不同
  选择标识 = `OPENMUSE_TASK_SCOPE_MISMATCH` 响亮拒绝且已存行不动（MT041 pin 同纪律）。
  迁移只授 INSERT/SELECT/DELETE（+回填期间的 INSERT），不给 UPDATE——归属不可改写是
  结构而不是纪律（删了重建走 DELETE→INSERT，审计面可见）。
- **不可见语义**：无协会行 = 对一切 scope 不可见（不存在/隔离/跨范围对外不可区分）。
- **RLS**（MT059 同模式 + MT042 扫描臂）：REVOKE PUBLIC+四能力角色 → ENABLE+FORCE →
  data 角色租户臂 SELECT + restrictive 主体自读臂 → operator 角色租户+主体上下文
  读/插/删 → operator `app.scan_sweep='on'` SELECT 臂（平台触发重建专用，普通业务事务
  永不设置该键）→ 最小 GRANT。
- **与 MT041 的关系**：协会行是 OpenMuse 任务的归属权威；MT041 `job_ownership`
  (kind='task', objectId=task_id) pin 是同一归属在执行/租约面的投影（租约物理上只存在于
  已 pin 的 job 上）。两条都 create-once；pin 顺序 = 协会行先、MT041 pin 后，pin 失败时
  协会行保留（作用域面自洽，租约面缺失 = claim 响亮拒绝），设计披露不掩盖。
- **与 MT059 的关系**：新路径 pin 时经 `PersonalBotService.getPersonalBotById`（只读消费）
  验证 botId 就是当前三元组的私有 Bot；外来 botId = canonical not-found（与不存在不可区分）。
- **bot_id 无 FK**：回填行的 bot id 是旧 agents 命名空间，不指向 enterprise_personal_bots；
  新路径的服务级不变量（botId == 私有 Bot agentId）在 pin 流程内验证，不做跨命名空间 FK。

## 2. 任务行数据面（零改动消费既有存储）

`openmuse_tasks` 及其全部既有 CAS 语义（状态矩阵、幂等键、配额）归既有
`openmuse-tasks/store.ts` 权威；本票**零改动**（冻结面前哈希复核）。作用域服务经窄
row-seam 接口（`OpenMuseTaskTenancyRows`，本模块自定义的最小形状）在**授权之后**读行/
触发既有 CAS——授权判定永远先于任何任务行读写；读/CAS 用主库连接（与既有装配一致），
但每条路径先过受限通道 + RLS 的协会判定，跨范围行到不了数据面。列表分页在协会表上
（created_at DESC, task_id 稳定序），行数据批量取回后按协会序拼装。

## 3. 服务面（`server/src/enterprise/tenancy/openmuse-task-tenancy.ts`）

```
createOpenMuseTaskTenancyService(deps{
  operator, data,                       // 已验证受限通道（装配时断言）
  jobs: JobOwnershipService,            // MT041 消费：pin + 租约
  personalBots: PersonalBotService,     // MT059 消费：私有 Bot 绑定验证（只读）
  rows,                                 // 任务行窄缝（本模块接口；生产=既有 drizzle 行对象的最小投影）
  issueScheduleScope(facts),            // 真实签发入口适配（MT042 同形）
  gate: WorkspaceGate,                  // MT005（执行回调事务）
  queue?: { finish, release },          // 队列侧完结/释放（work_items；同 MT042 形状）
})
pinTaskScope(scope,{taskId,botId,basis})     → {status:'pinned'|'existing', scope view}
listTasks(scope,{limit,cursor?})             → {tasks:[view], nextCursor?}
readTask(scope,taskId)                       → view | canonical not-found
cancelTask(scope,taskId) / pauseTask / resumeTask / retryTask(scope,taskId,retryKey?) /
answerWait(scope,taskId,waitId,values)       → 既有 CAS 结局（scope 先行，not-found 同形）
previewLegacyBackfill(machine)               → {attributable:[{taskId,tenantId,workspaceId,principalId,userId}], isolated:[{taskId,reason}]}
resolveForExecution(machine,{taskId})        → {scope,facts} | 确定性哨兵码拒绝
runUnderLease(machine,{taskId,executor,leaseMs,work}) → 每任务结局（executed/lease-held/released/refused）
```

- 哨兵码（机器面，确定性、零回显）：`OPENMUSE_TASK_RECORD_MISSING / OPENMUSE_TASK_SCOPE_REVOKED /
  OPENMUSE_TASK_LEASE_MISMATCH / OPENMUSE_TASK_EXECUTION_FAILED`；用户面一切不可见 =
  canonical `RESOURCE_NOT_FOUND`（MT011 冻结实例逐字节同形）。
- 事务纪律与 MT016/MT022/MT059 完全一致：assertTrustedScope → read committed +
  lock/statement timeout → set_config('app.*',…,true) → advisory 共享锁（读）/排他锁（写），
  键 = 作用域限定（`openmuse-task-tenancy:<tenant>:<workspace>:<principal>` 族 + MT016
  同序键序）→ 成员事实重验（公司 active+epoch 匹配签发时版本、团队 active）→ 判定。
- 归属写入锁（AC2 的「锁」半边）：pin 事务持
  `pg_advisory_xact_lock(hashtextextended('openmuse-task-tenancy:'||tenant||':'||workspace||':'||principal,0))`
  ——同三元组串行、跨三元组（尤其跨公司）结构性互不相交；键派生函数导出供测试钉死。

## 4. 迁移（MT060，三步，注册于 migrate-test.ts TASKS 表尾）

1. `task_scope_tables`：建表 + 4 FK + CHECK + 索引（§1 形状）。
2. `task_scope_rls`：REVOKE/ENABLE/FORCE + data 租户臂 + restrictive 主体自读臂 +
   operator 上下文读/插/删 + operator 扫描臂（app.scan_sweep）+ 最小 GRANT。
3. `legacy_task_backfill`：幂等回填——
   `INSERT … SELECT` 从 `openmuse_tasks` × `enterprise_principals` ×
   `enterprise_workspace_memberships`，**仅当该 owner principal 恰有唯一一条
   workspace membership 行（状态不计）** → attribution='backfill'；零条或 ≥2 条 = 歧义/
   无归属 → 不写行（受控隔离，Spec §9.2「不按猜测分配」逐字执行）；已回填行
   ON CONFLICT DO NOTHING；`WHERE NOT EXISTS` 防重。MT117 持执行权；本票在专用测试库
   真实 apply 以证明行为与 preview 一致。

授权窄缝（3 处，brief 预授权「纯追加」）：migrate-test.ts += MT060 任务块 + TASKS 注册 1 行；
migration-tool.test.ts += allowlist "MT060" + 裁决注释（ruling #5 第 19 次先例）；
src/db/schema/index.ts += barrel 1 行（字母序 personal-bot < **plugins** < … 插入位）。

## 5. TDD 计划

RED：新建 `tests/multitenancy/openmuse-tasks.test.ts` + `support/openmuse-tasks.ts`
（真实 provision + 真实 resolver/gate/MT041/MT059 + 主通道任务行缝；缺 env 显式 skip）。
首跑预期整组红：模块缺失（import 失败）+ 迁移未注册（beforeAll generate MT060 失败）。

GREEN：schema 文件 + 服务模块 + 迁移注册落地 → 聚焦全绿。REFACTOR：不改行为的收敛
（重复判定合并、注释收敛），聚焦+全量复跑。

## 6. 变异自证计划（每安全分支 ≥1：注入→聚焦捕获→字节复原→复绿）

| 变异 | 打击面 | 预期捕获者 |
| --- | --- | --- |
| MUT-1 范围判定 | readTask/cancelTask 的三元组第二道防线拔掉（只信 RLS 租户臂）→ 同公司跨团队/他人任务可见 | AC1「同公司跨团队上下文不可见 / 他人任务不可见」 |
| MUT-2 租约隔离 | claim 前把 workspace 逐字比对放宽（只比 tenant）→ 跨团队/跨公司租约可认领/复用 | AC2「跨范围认领被拒 + 持有人行零变化」 |
| MUT-3 重建信任 hint | resolveForExecution 改信 payload/入参 hint 的 tenant → 伪造提示被执行面采纳 | AC4「伪造 hint 仍按权威行执行（canary 零采纳）」 |
| MUT-4 回填猜测 | backfill 唯一性判定放宽（取第一行 membership）→ 歧义任务被猜测归属 | AC3「双团队成员任务保持隔离零行」 |

## 7. 边界与披露（诚实边界）

- 路由/装配不接（MT016/MT022/MT059 同例）：服务面供下游接线票复用；`src/index.ts`、
  `openmuse-tasks/routes.ts` 零改动。
- 回填执行权在 MT117；本票交付迁移 + 只读 preview + 测试库 apply 证明。
- pin 双写（协会行 + MT041 pin）非原子（两服务各自事务）；失败序披露见 §1。执行面以
  协会行为权威重建，MT041 pin 缺失时租约面响亮拒绝，不会以无租约状态静默执行。
- 既有队列 key（task id / task:uuid）全局唯一、无跨公司碰撞面；本票不改 key 语法
  （work/queue.ts 冻结消费）；范围隔离由执行面重建（AC4）承担，与 MT042 同构。
- RECTIFIED 冻结面偏差（唯一一处）：entry-context.test.ts:191 环境令牌 w14int→w15b_test
  （wave14-integration §4-2 / MT073-brief 同款先例；协调方问询 msg_fc967b9d608d 30 分钟
  无应答后按 brief 两条硬性规定交集执行；双哈希披露 verification/02–03）。
