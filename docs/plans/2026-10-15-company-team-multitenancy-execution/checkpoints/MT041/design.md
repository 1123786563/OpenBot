# MT041 设计 — 任务、运行、触发与租约固定原始归属与配置版本

Ticket：#84（MT041）。BASE f0520524。Spec §4.2「业务运行、用量、任务、产物及事件：固定记录
**或受约束关联**公司、团队、发起主体及业务对象，关联不得跨公司或跨团队漂移」；§6「任务保存
原始公司/团队归属及受限执行身份，Worker 根据服务器持久化记录验证执行资格，不能信任队列消
息中任意 tenant_id」「缓存键含实际归属及配置版本」；§11 A2/A8/A5。

## 1. 核心概念：执行归属（creation-time ownership pin）

每个后台执行单元（task / run / trigger）在**创建时**把归属固定为一行不可变事实：

```
job_ownership (kind, object_id) PK
  → tenant_id + workspace_id（复合 FK → enterprise_workspaces，公司一致性由 DB 约束证明）
  → principal_id（发起主体，FK → enterprise_principals）
  → created_at
```

- **创建一次，永不改写**：迁移不授予任何角色 UPDATE/DELETE（.operator 仅 INSERT+SELECT），
  DB 层结构性不可变；服务层 `pinJobOwnership` 对同一 (kind, objectId) 幂等（同归属返回
  existing、零写入），**不同归属选择标识的后续请求一律 `JOB_OWNERSHIP_MISMATCH` 拒绝且
  已存归属不变**（AC1：后续请求携带不同选择标识不改变它）。
- 业务对象经 `(kind, object_id)` **受约束关联**（FK → job_ownership），不复制归属列到
  既有业务表——expand-only，零既有表改动（与 Spec §4.2「固定记录或受约束关联」逐字一致）。
- kind 封闭词表 CHECK：`task | run | trigger`。租约不设独立 kind：租约只存在于已 pin 的
  job 之上（job_leases 复合 FK → job_ownership）。

## 2. 配置版本快照（AC3）

```
job_config_snapshots (id) PK
  (kind, object_id) → job_ownership（受约束关联）
  purpose ∈ creation | execution
  company_revision / override_revision（正在生效的配置版本标识）
  basis_digest（resolved document 的确定性 canonical JSON SHA-256）
  captured_at
```

- pin 时写 creation 快照（partial UNIQUE：(kind, object_id) WHERE purpose='creation'）；
  每次执行依据经 `recordJobExecutionBasis` 追加 execution 快照（append-only：无 UPDATE
  授权）。配置版本变化后，历史快照行不变 → **当时的执行依据可追溯**（ revisions 标识版本、
  digest 绑定内容）。
- basis 是服务入参（resolved document + 两级 revision），测试用真实 MT014
  `resolveRuntimeConfig` / `createRuntimeConfigService` 产出——不复制解析逻辑。

## 3. 租约模型（AC2）

```
job_leases (kind, object_id) PK
  tenant_id + workspace_id（复合 FK → enterprise_workspaces；RLS 臂 + 归属冗余列）
  (kind, object_id) → job_ownership（租约只存在于已 pin 的 job 上）
  claimed_by_kind ∈ worker | principal；claimed_by；lease_until；attempts；finished_at；last_error
```

- `claimJobLease`：读 pin（跨公司 → RLS 不可见）→ 归属三比（tenant+workspace 与 pin 逐字
  相等）→ 无租约/已释放/已过期 → 授予（attempts+1，DB 时钟 `now()+lease`）；他人活租约 →
  `JOB_LEASE_HELD`；本人活租约 → `held`（幂等）；本人/他人过期租约 → 重认领。**跨范围
  （跨公司或同公司跨团队）认领一律 `JOB_LEASE_SCOPE_MISMATCH`，零写入**。
- `renewJobLease` / `finishJobLease` / `releaseJobLease`：WHERE 带持有人匹配（+ 事务上下文
  租户臂），非持有人 `JOB_LEASE_NOT_HELD`；finish 置 finished_at 清 claim；release 清 claim
  立即回到可认领。执行者身份全局唯一（worker id / principal id），续约/完结在租户上下文下
  进行——跨公司主体连行都不可见（RLS），同公司跨团队由应用层比对拒绝（纵深防御，与
  not-found-semantics 同构：RLS 是事实层，注册表比对是第二道防线）。

## 4. 任务列表/详情只返回有权范围（AC4，含管理视图）

- 成员视图 `listJobs` / `readJob`：受信 Scope（`assertTrustedScope`）→ data 角色 + 事务本地
  app.* 上下文 + RLS（租户臂）→ 应用层 `workspace = scope.workspaceId AND principal =
  scope.principalId`（成员只看到**自己发起**、**所选工作范围**内的 job）。跨团队/跨公司/
  不存在 → 同一 canonical `RESOURCE_NOT_FOUND`（逐字节同消息，无存在泄漏；MT011 语义）。
- 管理视图 `listJobsForCompanyAdmin` / `readJobForCompanyAdmin`：真实 MT006 authorizer 签发
  的受信 CompanyAdminContext（`assertTrustedAdminContext`）→ 本公司全部 job（跨团队、跨发
  起主体）——管理元数据视图，不含个人内容正文；伪造上下文 `UNVERIFIED_ADMIN_CONTEXT`。
- 列表带 creation 快照（版本依据）一并返回；键集分页属下游接线票（D 披露）。

## 5. 事务纪律（与 MT008/MT011/MT014 同款）

受信身份对象（Scope / CompanyAdminContext）→ read committed + lock/statement timeout →
`set_config('app.*', …, true)` 事务本地 → 受限角色真实 RLS。写路径 operator 通道，读路径
data 通道。绝不回退默认公司/团队；缺上下文响亮拒绝。

## 6. 交付物

- 新 `server/src/db/schema/job-ownership.ts`（三表 + RLS 策略声明）
- 新 `server/src/enterprise/tenancy/job-ownership.ts`（pin/快照/租约/列表详情服务 + 哨兵码）
- 新 `server/tests/multitenancy/job-ownership.test.ts`（票面 Verification 指定路径）
- 新 `server/tests/multitenancy/support/job-ownership.ts`（夹具：真实 authorizer + 真实
  MT014 config service + 专用库三角色）
- 授权窄例外（brief 预授权三扩展点）：migrate-test.ts 追加 MT041 任务（tables + rls 两步）、
  migration-tool.test.ts 穷举断言追加 "MT041"（ruling #5 第 8 次）、schema barrel 排序位
  追加一行导出。
- 迁移链：base + MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→**MT041**。

## 7. 非目标

- 不改 openmuse_tasks / enterprise_runs / responsibilities / work_items 等既有表（归属经
  受约束关联；直接加列属后续接线票）。
- 不接 HTTP 路由（库层 seam，MT069/MT076 同边界）；不含平台扫描面（无租户上下文 → 零行，
  fail closed）；不做列表分页/游标。
- 不写 enterprise_security_events 审计（票面未要求；快照表即追溯记录）。
