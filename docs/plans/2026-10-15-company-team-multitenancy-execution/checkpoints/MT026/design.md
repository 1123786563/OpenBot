# MT026 / Issue #69 设计（每公司 SSO/SCIM 隔离）

BASE f0520524；prereq manifest 46/46 复算通过；baseline 422 pass / 0 fail / 15 文件已复现。
专用容器 mt026-impl-pg（pgvector/pgvector:pg16，127.0.0.1:55481，端口预检空闲）。

## 领域模型（CONTEXT.md 术语）

- Tenant = 公司；SSO 配置与 SCIM 目录绑定都是**公司事实**，不是部署事实。
- SCIM 连接（connection key）：目录（Okta 等）侧的稳定标识；插件用 bearer token
  认证后得到该 key —— 这是**服务端已验证事实**，公司归属只能来自按该 key
  查出的**服务端持久绑定行**，绝不来自请求载荷。
- 成员资格（enterprise_memberships，PK (tenant, principal)）是全局身份之上的
  公司级事实；全局身份（users）与部署级 deny-list（revoked_access）不属于
  任何公司。

## 票面四验收 → 实现映射

### AC1 公司 A 的 SCIM 停用只影响公司 A；B 的资格与全局登录不受影响
`scim-directory.ts` `deprovisionMember(connectionKey, { userId })`：
- 绑定解析按 connection_key（RLS 臂：`connection_key = pin(app.scim_connection_key)`）
  —— 未知连接 → `SCIM_CONNECTION_NOT_BOUND`，零成员变更；已停用绑定 →
  `SCIM_CONNECTION_DEACTIVATED`，零写入。
- 单一 operator 事务（pin app.tenant_id = 绑定公司）：停用成员行（suspended、
  epoch+1）+ 逐行 pin app.resource_id / app.operator_principal_id 删除该公司
  资源授权行（撤权=删行范式）+ 绑定行记录 last_deprovision_* 事实 + 审计
  事件（本模块封闭集合）。
- 结构性不触碰：users 行（全局身份）、sessions、revoked_access（全局登录）、
  其他公司成员行/授权行。测试用 multi-company 身份逐项断言。

### AC2 SSO 配置读取与修改仅限该公司授权管理员；跨公司读取不可见
`sso-scim-config.ts` `createCompanySsoScimConfigService(operator)`：
- 全部方法只收受信 CompanyAdminContext（WeakSet 信任机制，复用
  workspace-admin 导出的类型与 assertTrustedAdminContext）——**API 形状上
  不存在租户参数**，跨公司读取在结构上不可表达。
- 事务内重验 tenant_admin + epoch（同 MT006 纪律）；漂移 → SCOPE_REVOKED。
- 无配置行 → `SSO_CONFIG_NOT_FOUND`（B 公司管理员读到 A 存在配置时也是同一
  代码——不可见语义）；写路径 advisory 锁 + 修订号递增；文档只存引用，
  绝不存秘密。
- 直接 RLS 反证：data/operator 角色 pin app.tenant_id=B 时 SELECT 不到 A 行。

### AC3 SCIM 请求不能创建或修改其他公司的成员关系
`scim-directory.ts` `provisionMember(connectionKey, { userId, role? })`：
- 租户永远来自绑定行；签名没有租户字段；输入对象若携带 tenantId 一律响亮
  拒绝（`TENANT_ATTRIBUTION_NOT_ACCEPTABLE`，防调用方改写归属）。
- 目录永不授予管理角色：role 只允许 'member'（`SCIM_ROLE_NOT_ASSIGNABLE`）。
- INSERT 策略 pin app.tenant_id = 绑定公司——其他公司成员行在 RLS 下
  结构上不可插入。已存在成员关系 → 零写入幂等报告；绝不改状态。

### AC4 身份绑定回调按服务端持久状态归属
`identity-binding.ts` `createIdentityBindingService(operator)`：
- `createIntent`：服务端生成不透明 state，落库（tenant_id + user_id + kind +
  过期时间）——归属在创建时持久化。
- `resolveIntent({ state, claimedTenantId? })`：按 state pin（RLS 臂
  `id = pin(app.identity_binding_state)`）读**持久行**，公司归属只来自行；
  回调声称的公司 ≠ 持久公司 → `IDENTITY_BINDING_TENANT_MISMATCH`（不消费，
  零改写）；成功一次性消费（consumed_at）；未知/已消费/过期分别响亮拒绝。

## 新文件（Ownership：全新优先）

| 文件 | 内容 |
|---|---|
| `server/src/db/schema/enterprise-sso-scim.ts` | 3 张新表（expand-only）：enterprise_sso_configs / enterprise_scim_directory_bindings / enterprise_identity_binding_intents |
| `server/src/enterprise/tenancy/sso-scim-config.ts` | AC2 配置管理 + SCIM 绑定登记/停用（公司管理面） |
| `server/src/enterprise/tenancy/scim-directory.ts` | AC1/AC3 目录反应 + 本模块封闭审计集合（不动 revocation.ts） |
| `server/src/enterprise/tenancy/identity-binding.ts` | AC4 绑定意图 |
| `server/tests/multitenancy/sso-scim-config.test.ts` | AC2 用例 |
| `server/tests/multitenancy/scim-directory.test.ts` | AC1/AC3 用例 |
| `server/tests/multitenancy/identity-binding.test.ts` | AC4 用例 |
| `server/tests/multitenancy/support/sso-scim.ts` | 共享夹具（隔离矩阵 + 受限角色 + 服务装配 + admin context） |

## 授权窄例外（先例可辨）

- `server/scripts/multitenancy/migrate-test.ts`：纯追加 MT026 任务注册（工具
  自声明契约；MT004→MT010 同款）。
- `server/tests/multitenancy/migration-tool.test.ts`：仅穷举断言追加 "MT026"
  （ruling #5 第 6 次先例，带裁决注释）。
- `server/src/db/schema/index.ts`：纯追加一行 barrel 导出（MT010/MT014 先例）。
- 不改 src/index.ts（本票无 HTTP 装配面）；不改 revocation/workspace-admin/
  admin-separation（只读消费其导出）。

## 复用判决（可消费先例）

- MT014 runtime-config：每公司配置行 + 修订号 + 严格文档解析 + 受限角色事务形状。
- MT007 revocation：撤权 = 删行/停用 + 同事务审计 + epoch 单调。
- MT075 admin-separation：不可见语义 + 封闭审计集合独立（本票审计类型
  `company_member.scim_{provisioned,deprovisioned,reprovisioned}`，写同一张
  enterprise_security_events 表，同一 RLS INSERT 策略）。
- MT006 workspace-admin：CompanyAdminContext 信任机制 + 事务内重验。

## 已知环境/边界裁决（写入报告 D 项）

- `enterprise_security_events` operator SELECT 需 app.tenant_id + app.operation_id
  双 pin（无法自由查询审计），故「管理员停用优先于目录恢复」改由**绑定行上的
  服务端持久事实**（last_deprovision_principal_id/epoch）裁决：仅当当前成员行
  epoch === SCIM 停用时所记 epoch 且 principal 匹配才允许 reprovision——
  期间任何一方（管理员恢复/再停用）动过成员行即拒绝（管理员决定优先）。
