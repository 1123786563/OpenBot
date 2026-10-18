# MT042 设计 — 平台扫描作用域重建（Issue #85）

Ticket：#85（MT042）。BASE f0520524（prereq-manifest 107 项领取时复算）。前置 MT041
job-ownership verified（lease holder 语义）。Spec §6「机器认证与业务身份分开。任务保存原始
公司/团队归属及受限执行身份，Worker 根据服务器持久化记录验证执行资格，不能信任队列消息中
任意 tenant_id，也不能把序列化 Scope 当可信 Scope。平台扫描可发现所有公司的到期任务，但每
个任务的执行、产物和费用回到自己的作用域」；§5.3「公司范围机器读权限仅供明确平台任务，不
可提供给普通业务接口」；§11 A8。

## 1. 数据流（一条链，四段）

```
work_items(kind=enterprise.job.due, key="<jobKind>:<objectId>", payload=…)
   │ ① 到期发现：元数据认领（FOR UPDATE SKIP LOCKED，DB 时钟；SELECT 不含 payload 列）
   ▼
job_ownership 权威行（operator 通道 + app.scan_sweep='on' 事务本地上下文，MT042 新策略臂）
   │ ② 重建：pin 行 (tenant, workspace, principal) + principal→user（operator 臂）
   │    → 经真实签发入口 createScopeResolver.resolve（entrypoint="schedule"）产出受信 Scope
   ▼
job_leases（MT041 claimJobLease，executor={kind:"worker", id:<machine.id>}）
   │ ③ 租约：同 lease 纪律（HELD→跳过；granted/held→执行；失败→release）
   ▼
MT005 scope-gate（createWorkspaceGate.transaction(scope, tx => execute)）
   │ ④ 执行回调在 gate 事务内拿到 tx + 受信 scope；成功→finishJobLease+队列 finish；
   │    失败→releaseJobLease+队列 release；SCOPE/WORKSPACE_REVOKED→机器码拒绝
```

## 2. 四条验收的实现面

- **AC1（列表=元数据）**：扫描认领是本模块自有 SQL——只 SELECT
  kind/key/run_at/attempts，**payload 列结构性地不进入扫描面**；扫描产物类型没有载荷字段；
  执行回调不接收 payload。跨公司：认领在平台连接上无租户上下文（work_items 是平台队列表，
  非 RLS 租户域表）。
- **AC2（重建=权威行）**：队列消息的 payload 从未被读取——公司/团队字段只能是路由提示；
  作用域事实全部来自 job_ownership 权威行（RLS 后面）+ enterprise_principals 行
  （operator 逐主体臂），再经真实签发入口核验两级成员资格。消息提示错误 → 执行仍按权威行
  作用域进行（测试钉死）。
- **AC3（机器身份类型隔离）**：`MachineScanIdentity` 品牌类型 + WeakSet 信任标记
  （`issuedMachineIdentities`），`assertTrustedMachineIdentity` 门卫；签发入口
  `createMachineScanIdentity` 拒绝 `dev-local-user` 及一切用户形 id；机器身份喂给任何
  受信 Scope 消费面（MT041 列表、MT005 gate、resolver authenticate）→ `UNVERIFIED_SCOPE`
  / 目录查无此人；真实用户 Scope 喂给扫描入口 → `MACHINE_IDENTITY_REQUIRED`。机器执行者
  在 MT041 租约里是 `{kind:"worker"}` ——与 principal 执行者是既有封闭词表隔离。
- **AC4（反序列化拒绝）**：Scope 只能由 `createScopeResolver` 产出（WeakSet 对象身份标记
  ——MT005 既有事实，本票消费并钉死）；JSON round-trip / structuredClone 的副本一律
  `UNVERIFIED_SCOPE`；机器身份同理（clone 后不可再驱动扫描）。

## 3. 跨公司 deny 语义

机器路径全部确定性哨兵码（`SCAN_RECORD_MISSING / SCAN_ITEM_MALFORMED /
SCAN_SCOPE_UNRESOLVED / SCAN_SCOPE_REVOKED / SCAN_LEASE_MISMATCH / SCAN_EXECUTION_FAILED`），
拒绝理由不回显消息 payload / 提示值（测试断言 canary 不出现在任何拒绝输出）；用户可见面
维持 MT041 canonical `RESOURCE_NOT_FOUND`（只读消费，零改动）。租约层跨范围行为
（`JOB_LEASE_SCOPE_MISMATCH`、RLS 不可见与未 pin 不可区分）由 MT041 已 verified 测试钉死。

## 4. 迁移（MT042 任务，1 步）

`job_ownership_operator_sweep_read`：job_ownership 上为 ob_ent_operator 追加一条 SELECT
策略臂 `USING (current_setting('app.scan_sweep', true) = 'on')`——普通业务事务不设该上下文
（租户臂语义不变）；只有扫描服务在机器身份断言后的 operator 事务内以事务本地 set_config
打开。expand-only：不改任何既有表/策略/授权；无新表 → 无 schema 文件、无 barrel 改动。
关闭 MT041 D6（「平台扫描…需专用平台角色与策略」）——七变量 env 约束下不新增登录面，
以既有 operator 能力角色 + 显式上下文门控承载平台扫描读（记录为 D 类裁决）。

## 5. 冻结面（只读消费）

`job-ownership.ts`（服务+schema）、`scope-gate.ts`、`store.ts`（resolver/assertTrustedScope）、
`connections.ts`、`workspace-admin.ts`、`work/queue.ts`（offer/finish/release/renew 消费；
claim 不消费——它返回 payload，扫描面改用本模块元数据认领）。授权窄例外（brief 预授权同缝）：
`migrate-test.ts` 追加 MT042 任务 + `migration-tool.test.ts` 穷举断言追加 "MT042"
（ruling #5 沿例）。

## 6. 变异计划（每安全语义 ≥1 分支，全部捕获）

MUT1 扫描认领投递 payload（AC1 泄漏）；MUT2 pin 缺失仍重建（AC2 权威行）；MUT3 机器信任门
移除（AC3/AC4）；MUT4 dev-local-user 拒绝移除（AC3）；MUT5 scan_sweep 上下文未设（策略
臂悬空）；MUT6 成功不 finishJobLease（租约纪律）；MUT7 失败不 releaseJobLease；MUT8 gate
事务移除（回调无租户上下文）；MUT9 活租约不跳过（双重执行）；MUT10 撤权成员仍执行（签发
判定）；MUT11 key 解析不校验 jobKind；MUT12 拒绝理由回显消息值（零回显）。

## 7. 非目标

不改 work/queue.ts、不接 HTTP 路由/worker 进程装配（库层 seam）；不消费 work_items payload
内容（生产者侧入队接线属下游票）；不做执行依据快照记录（MT014 域）；不新增数据库登录角色
（七变量 env 约束）；不做扫描指标/重试退避策略（沿用队列 attempts 上限）。
