# MT005 前置：新栈授权 seam 识别报告

- 日期：2026-10-15。工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-seam-id`
- HEAD：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与 dag-ledger 记录的 main `f0520524` 一致；任务文本中的哈希 `…a69c8f…` 与 git 实际 `…a692c8f…` 有一位之差，本报告以 git 实际值为准）。
- 性质：**只读分析**，未修改任何代码；本文件是本任务唯一写入物。结论供 dag-ledger「授权 seam 落点变化」条目回写与 MT005（#48 team-eligibility）实施前侦察使用；本任务无 Ledger 写回授权，回写由主控执行。

---

## 1. `resolveScope`：名称澄清、签名、实现位置与全部调用点

### 1.1 关键澄清：当前 HEAD 上 `resolveScope` 是两个不同的东西

**（a）同名但与租户授权无关：proactive 投递范围解析器。**
`ProactiveEngineDeps.resolveScope`（`server/src/proactive/engine.ts:53-57`）签名为：

```ts
resolveScope(ownerUserId: string, channelId: string, agentId: string): Promise<ProactiveScope | null>
```

它回答「该用户是否仍有这条 Bot 频道」，`ProactiveScope = { ownerUserId, channelId, agentId, threadId }`（`server/src/proactive/engine.ts:39-44`）。实现在 `server/src/index.ts:2875-2891` 的 `deliveryScopeFor`（查 person 未撤销 → actor → channel.active 且 bot 属于该频道），注入点 `server/src/index.ts:2983`（`resolveScope: deliveryScopeFor`）。dag-ledger 同步记录中「`resolveScope` 现位于 `server/src/index.ts`」指的就是这一处。**它与 MT005 的公司/团队授权 seam 无关，仅是命名碰撞，实施时不要混淆。**

**（b）MT005 真正关心的授权 seam：tenancy `ScopeResolver`。**
旧栈 `resolveScope(directory, userId, selector): Promise<Scope>`（git `24813ab4:server/src/enterprise/tenancy/scope.ts:21-24`，WeakSet 信任 + `assertScope`）已随文件删除。新栈把该职责拆为：

- 契约：`ScopeResolver.resolve(request) / resolveForThread(request, threadId): Promise<PlatformScope>`（`server/src/enterprise/contracts.ts:57-60`）。
- 实现：`createScopeResolver(database, options)`（`server/src/enterprise/tenancy/store.ts:82-146`）。身份来自 `options.authenticate(request)`（服务端 session 层，`AuthenticatedRequestIdentity`，`store.ts:22-27`），tenant/workspace 只是 header 选择子（`store.ts:90-94`，注释明确「selectors only; the database membership determines authority」）。
- 信任机制等价保留：`issuedScopes = new WeakSet<object>()`（`store.ts:44`）+ `assertTrustedScope(scope)`（`store.ts:46-49`，失败抛 `UNVERIFIED_SCOPE`）；签发时 `Object.freeze` 并登记（`store.ts:135-145`、`store.ts:436-445`）。scope 形状为 `PlatformScope { tenantId, workspaceId, principalId, actorId, memberEpoch, aclEpoch, entrypoint }`（`server/src/enterprise/contracts.ts:40-48`）。**注意新 scope 不含 `role`**（旧 Scope 含 role/epoch，git `24813ab4:…/scope.ts:36-43`）——与 interfaces.md T02 `WorkspaceMember.role` 的映射见 §4。

### 1.2 调用点清单（grep 全仓，`rg resolveScope|createScopeResolver|assertTrustedScope|\.resolve\(|resolveForThread`，排除 node_modules/dist）

**tenancy 侧（MT005 的 seam）：**

| 符号 | 位置 |
| --- | --- |
| `createScopeResolver` 定义 | `server/src/enterprise/tenancy/store.ts:82` |
| 生产装配（唯一） | `server/src/index.ts:788-806`（`authenticate` → `resolveRequestActor`（`index.ts:591`）；`selectTenant`/`selectWorkspace` 读 header，见 §4.3 header 名差异） |
| `scopes.resolve` | `server/src/enterprise/conversations/routes.ts:137`（GET /）、`:149`（POST /） |
| `scopes.resolveForThread` | `server/src/enterprise/conversations/routes.ts:173`、`:196`；`server/src/enterprise/runs/runner.ts:264`、`:276`、`:336`、`:775`（admission/isRunning/stop/connect 均先解析 scope 再进 RunService） |
| `assertTrustedScope`（信任校验，等价旧 `assertScope`） | `store.ts:46`（定义）；调用：`conversations/store.ts:25`；`conversations/service.ts:385,421,553,1043,1159,1178`；`runs/service.ts:77,136,205,281,292,308,318,322,326,356,366,402,409,413,421,425,429`；`runs/events.ts:304,359`；`runs/model-route-rebind.ts:61`；`runs/model-route-catalog.ts:335,386`；`experts/version-catalog.ts:174,228,258`；`models/budget.ts:378,396,477` |

**proactive 投递侧（同名不同物）：** `engine.ts:53`（接口）、`engine.ts:234,364,408,450`（调用）、`index.ts:2875`（实现 `deliveryScopeFor`）、`index.ts:1665`、`index.ts:2983`（注入）、`index.ts:5392,5408`（`scopeFor: deliveryScopeFor`，delivery authenticated/webhooks）、测试 stub `server/tests/proactive.test.ts:316,430`。

**测试内直接构造 resolver（本工作树 prior-art）：** `server/tests/enterprise/tenancy.integration.test.ts:27-30`（import `createScopeResolver/createResourceReader`），`:86-96` 起真实装配使用。

---

## 2. 事务内租户上下文设置与成员重验的现行机制（`withTenant` 等价物）

### 2.1 旧机制基线（git `24813ab4:server/src/enterprise/tenancy/transaction.ts`）

旧 `withTenant(database, scope, fn)`：`assertScope` → `beginOperation`（READ COMMITTED）→ `set_config('app.tenant_id'/'app.principal_id'/'app.user_id', …, true)`（事务本地）→ `lock_timeout 2s`/`statement_timeout 5s` → tenant→principal→membership 三把共享 advisory 事务锁 → 活链路 + `epoch`/`role` 与 scope 一致性重验，失败 `SCOPE_REVOKED`（旧 transaction.ts `withTenant` 及常量段）。新栈删除了该文件，**没有单一全局 `withTenant` 导出**；等价机制被内联复制到两处：

### 2.2 等价物 A：`createConversationStore().transaction(scope, op)`（读写字务的标准形状）

`server/src/enterprise/conversations/store.ts:21-99`，顺序为：

1. `assertTrustedScope(scope)`（`:25`，只接受本进程签发的 scope）；
2. `data.transaction` 内先 `set transaction isolation level read committed`、`set local lock_timeout='2s'`、`set local statement_timeout='5s'`（`:27-29`）；
3. `set_config('app.tenant_id', …), set_config('app.principal_id', …), set_config('app.user_id', …)`，全部 `is_local = true`（`:30-31`）；
4. 三把 `pg_advisory_xact_lock_shared(hashtextextended(key))`，键为 `["enterprise", "tenant"|"principal"|"membership", …ids]` JSON（`:32-45`）；
5. 成员重验：membership/principal/tenant 全 `active` + workspace 存在 + `epoch == scope.memberEpoch`，且 `principal.user_id == scope.actorId`（`:46-84`），否则 `throw new Error("SCOPE_REVOKED")`（`:85`）；
6. 通过后才执行业务 `operation(tx)`。

服务层调用点（业务事务全部经它）：`server/src/enterprise/conversations/service.ts:386,475,570,596,704,930,1056,1161,1180`。**这是 MT005 `withWorkspace` 应包裹/扩展的现成形状。**

### 2.3 等价物 B：`createResourceReader().readAuthorizedResource`（资源读取）

`server/src/enterprise/tenancy/store.ts:457-580`：`assertTrustedScope`（`:462`）→ 事务 + 隔离/超时（`:464-467`）→ **四**把共享锁（tenant/principal/membership/resource，`readLockKeys` `store.ts:582-595`）→ 三项 `set_config`（`:473-475`，注释「Transaction-local settings are defense in depth for RLS and are cleared on commit」）→ 成员重验含 `epoch !== scope.memberEpoch` 抛 `SCOPE_REVOKED`（`:477-507`）→ resource + grant LEFT JOIN，无 active 资源或无 grant 抛 `RESOURCE_NOT_FOUND`（`:509-548`）→ `authz.check`（`:549-564`，见 §3）。

### 2.4 只设上下文、不做完整成员重验的内联路径（MT005 视角为「部分 seam」，需知晓而非复用为判定位）

- `experts/version-catalog.ts:179,234,262`、`runs/model-route-catalog.ts:344,392`：仅 `set_config('app.tenant_id', …, true)` 后走 RLS；
- `conversations/mastra-intent-reconciler.ts:59-63`：tenant + user/principal；
- `tenancy/provision.ts:74,157,347,474`：operator 离线通道，`app.tenant_id + app.operator_principal_id + app.operation_id (+ app.resource_id)`。

### 2.5 `app.*` settings 的设置点与连接池复用清理

- **设置点**：全部经 `select set_config(name, value, true)`（`is_local = true`）。grep 全仓（`server/src`）**不存在任何 `set_config(..., false)` 会话级写入**（验证命令见 §7）。
- **清理机制**：不依赖显式 `RESET`/`reset_config`/`DISCARD ALL`（全仓无）；清理 = 事务本地性本身——COMMIT/ROLLBACK 即清除，连接归还池时上下文不可能残留。`store.ts:473` 的注释明确此设计（defense in depth, cleared on commit）。`resolve()`（`store.ts:88-146`）与 `resolveForThread` 的目录/数据两段事务（`store.ts:148-206`、`:210-443`）同样全部事务本地。
- **池复用证据**：drizzle+Bun SQL 池来自 `createDatabase`（`server/src/db/client.ts:192-228`，`max` 可钉住池大小）；MT002 fixture 的连接复用泄漏用例正是用 `max: 1` 池连续复用同一后端连接验证无残留（i6-review2-mt131 `server/tests/multitenancy/support/fixture.ts`：`openVerified` 用 `{ max: 1 }`、`runRestrictedQuery` 注释「Context settings are transaction-local … commit and rollback both clear them; nothing session-level is ever written」）。

---

## 3. 资源授权判定的现行集中点

### 3.1 判定服务：`createAuthz()`（本地确定性策略，唯一集中点）

`server/src/enterprise/authz/service.ts:31-56`。输入 `AuthorizationInput { scope, resource: AuthorizedResourceFacts, action }`（`:10-15`，`action` 当前类型仅 `"read"`，`:14`）。判定为纯函数：`action==="read"` + `resource.active` + `resource.locallyAllowed` + tenant/workspace/principal 三重相等 + `revision`/`aclEpoch` 为正 safe integer（`:33-49`）。

**策略版本**：`SUPPORTED_POLICY_REVISIONS = Object.freeze(["tenancy-v1"])`（`service.ts:25-27`）；版本不识别抛 `POLICY_REVISION_UNSUPPORTED`（`service.ts:50-52`）——fail-closed 而非回退。`tenancy-v1` 的来源是 `enterprise_tenants.policy_revision` 列默认值（`server/src/db/schema/enterprise-tenancy.ts:25`）。

**不确定/需标注**：interfaces.md T02 写「既有 tenancy-v1/conversations-v1 不变」，但 **`conversations-v1` 在本工作树 grep 全仓不存在**（仅 `authz.integration.test.ts:80` 用 `"future"` 测不支持版本拒绝）。`conversations-v1` 属于旧计划词汇，新栈未落地；MT005 不得臆造该版本，workspace-v1 归 MT008。

### 3.2 Grant 数据与 RLS 兜底

- **Grant 表**：`enterprise_resource_grants`（`server/src/db/schema/enterprise-tenancy.ts:231-288`），PK (tenant, resource, principal, **action**)，check 约束 **`action = 'read'`**（`:260`）。interfaces.md 的 `ResourceAction = read|run|write|delete|share|manage` **尚无 DB 支持**——扩 action 是 MT008（workspace-v1）范围，MT005 只做成员资格判定（Scope boundary 一致）。
- **判定消费点**：`authz.check` 唯一调用点是 `readAuthorizedResource`（`store.ts:549-564`）；`locallyAllowed` 来自该事务内 grant LEFT JOIN（`store.ts:517-535`）。「PostgreSQL 是 ACL 单一权威」原则延续（旧 enterprise-authz.ts 头注释，git `24813ab4`）。
- **合同缝已备但未接线**：`PlatformRunnerDeps.resourceReader / loadAuthorizedAgent`（`server/src/enterprise/contracts.ts:400-408`）为合同声明；当前 runner 装配 `createProductionRunnerComposition`（`runs/runner.ts:885-910`）**未注入** resourceReader，生产代码无消费者，仅测试使用（`tests/enterprise/tenancy.integration.test.ts:252-360`）。MT005 可把它作为 `ResourceAuthorization` 的现有合同挂点（标注：这是观察，不是既有行为）。
- **RLS 兜底（policy pin 在 `current_setting('app.*', true)`）**：
  - `enterprise-tenancy.ts`：7 表全 `enableRLS()`，policy 行 `:33-52`（tenants）、`:72-86`（principals）、`:119-144`（memberships）、`:162-176`（workspaces）、`:207-226`（resources，operator 写需 `app.resource_id`）、`:261-286`（grants，operator 读 pin `app.operator_principal_id`）、`:305-314`（security events pin `app.operation_id`）；
  - `enterprise-conversations.ts:22-23`（`scoped()` helper）、`:81-88,130-137,160-167`；`enterprise-runs.ts:107-114,165-172,226-233,303-310,351-358,432-439`；`enterprise-model-routes.ts:40-46`；`enterprise-expert-versions.ts:37-44`。
- **受限角色与连接能力验证**：`server/src/enterprise/tenancy/connections.ts` —— 角色名 `ob_ent_directory/ob_ent_data/ob_ent_operator`（`:4-6`），branded `DirectoryDatabase/DataDatabase/OperatorDatabase`（`:11-21`），pg_roles 能力目录查询与 `verify*/assert*`（`:39-208`，NOLOGIN capability + 独立 login + 无升级成员 + 无 enterprise 物主/权限）。生产装配：`index.ts:711-745`（`enterpriseCapabilities`，`verifyDirectoryDatabase/verifyDataDatabase` `:726-731`，任一失败整个 enterprise 能力为 null，绝无宽松替身）。

---

## 4. MT005（team-eligibility）建议落点与 interfaces.md T02 契约映射

### 4.1 T02 类型/接口 → 新栈文件映射

| interfaces.md T02 | 新栈落点 | 状态与说明 |
| --- | --- | --- |
| `Scope`（沿既有类型导入） | `PlatformScope`，`server/src/enterprise/contracts.ts:40-48` | 已存在。**差异**：无 `role` 字段；`userId` 改名 `actorId`；epoch 拆为 `memberEpoch/aclEpoch`。MT005 不改 Scope 形状（签发信任靠 WeakSet，已满足「只有签发入口能产生 Scope」验收） |
| `TxClient` | 旧独立类型已删；现为 drizzle 事务回调参数内联类型（如 `conversations/store.ts:14-18`） | MT005 新代码沿用该写法，不必复活 `TxClient` 导出 |
| `CompanyRequestContext { scope; workspaceId? }` | 建议**新建** `server/src/enterprise/tenancy/company-request.ts`：`resolveCompanyRequest(request)` = `scopes.resolve(request)` + workspace selector 归属校验 | 新建（约 80–150 行）。不要放进程级变量（interfaces.md 明令） |
| `WorkspaceMember`（workspace_admin/member + epoch） | 依赖 MT004 的 workspace membership 表；**本工作树无此表**（`db/schema/` 无 workspace_memberships；`enterprise-tenancy.ts` 仅 tenants/principals/memberships/workspaces/resources/grants/security_events） | **阻塞事实**：MT004 未集成进本栈。MT005 开工前须确认 MT004 交付已合入，否则团队资格校验无表可查（不得用 fixture 的「per-team grant 冒充成员关系」作为生产语义，那是 MT002 前的临时事实，见 fixture 头注释 Current-shape note） |
| `ResourceAccess` / `ResourceAuthorization.requireInTx` | 建议**新建** `server/src/enterprise/tenancy/resource-authz.ts`；内部提取 §2.2/§2.3 的共同模式（信任校验→事务→上下文→锁→成员重验→判定） | 新建（约 150–250 行 + 测试）。现该模式在 `conversations/store.ts:21-99` 与 `store.ts:457-507` 各内联一份，MT005 是第三消费者，应提炼为共享 seam 而非再拷贝 |
| `withWorkspace`（含 withTenant 重验 + workspace 重验） | 包裹 `createConversationStore.transaction` 形状；`set_config` 增加 `app.workspace_id`（i6-review2-mt131 fixture 的 `RestrictedQueryContext.workspaceId` 已预留该 key 及 set_config 写法） | 修改 `conversations/store.ts` 或经 resource-authz.ts 统一 |
| 策略版本 | `SUPPORTED_POLICY_REVISIONS`（`authz/service.ts:25-27`） | MT005 **不改**（tenancy-v1 不变；workspace-v1 归 MT008）。若 MT005 仅校验资格不扩 action，无需动 authz |
| 选择头 | 现读 `x-openbot-tenant-id` / `x-openbot-workspace-id`（`index.ts:802-804`） | **冲突**：interfaces.md T02 规定 `x-openbot-tenant`、`x-openbot-workspace`；i6-review2-mt131 fixture 亦用后者。需主控定夺改 header 还是改契约（见 §6-1） |

### 4.2 建议修改面预估（文件级清单）

**修改（现有文件）：**

1. `server/src/enterprise/tenancy/store.ts` —— `resolve()` 拆分错误码（现缺 workspace 也抛 `TENANT_REQUIRED`，`store.ts:94`；T02 要求 `WORKSPACE_REQUIRED/400`）；如 T02 要求，`resolve` 接受可选 workspace 并校验归属（或全部移入 company-request.ts，store.ts 仅最小改动，约 20–60 行）。
2. `server/src/index.ts` —— header 名（若定夺统一为 `x-openbot-tenant/x-openbot-workspace`，`:802-804` 两行）+ `company-request`/`resource-authz` 装配（`:788-806` 附近，约 10–30 行）。
3. `server/src/enterprise/conversations/store.ts` —— 若采用共享 seam，改走 resource-authz.ts 提供的事务模板（等价重构，行为不变）。
4. `server/src/enterprise/contracts.ts` —— 仅当 MT005 需要导出 `CompanyRequestContext` 类合同（或放 tenancy 层自有 types；倾向后者，约 0–20 行）。

**新建：**

5. `server/src/enterprise/tenancy/company-request.ts`（§4.1）。
6. `server/src/enterprise/tenancy/resource-authz.ts`（§4.1）。
7. `server/tests/multitenancy/team-eligibility.test.ts` + `server/tests/multitenancy/support/`（fixture 移植，见 §5；MT002/MT004 集成后）。

**不动（明确边界）**：`authz/service.ts`、`provision.ts`、`connections.ts`、RLS schema、proactive 侧 `resolveScope`。

**总量估计**：生产代码 ~300–500 行净变化 + 测试 ~400–700 行；单 code agent 上下文可完成，符合 Ticket 粒度约束。

### 4.3 锁顺序（T02「统一锁顺序」）

现行两处顺序：`tenant → principal → membership`（`conversations/store.ts:32-45`）与 `tenant → principal → membership → resource`（`store.ts:582-595` readLockKeys；operator 侧再含 operation，`provision.ts` 锁段）。MT005 引入 workspace 资格后建议顺序 `tenant → principal → membership → workspace → resource`（workspace 键插在 membership 与 resource 之间），并同步两处 + resource-authz.ts；advisory 键沿用 `["enterprise", kind, ...ids]` JSON（hashtextextended）。

---

## 5. 受限角色与 RLS 在测试中的启用方式

**本工作树不存在 `server/tests/multitenancy/`（已核实）。** MT002 fixture 按 dag-ledger 记录在 `/Users/wuyongjun/orca/workspaces/OpenBot/i6-review2-mt131/server/tests/multitenancy/support/fixture.ts`（只读参考，路径及行为如下；集成回本栈时以 MT002 验收交付为准）：

- **角色启用**：`createIsolationFixture(domain)` 打开三条受控连接 `openVerified(url, verifyDirectoryDatabase|verifyDataDatabase|verifyOperatorDatabase)`，每池 `{ max: 1 }`（连接复用泄漏用例的前提）；`RESTRICTED_ROLES = ["directory","data","operator"]`，`queryRestricted(role, context, text, values)` 在事务内按 `RestrictedQueryContext` 逐项 `set_config('app.tenant_id'/'app.principal_id'/'app.user_id'/'app.workspace_id'/'app.operation_id', …, true)` 后执行参数化 SQL——RLS 与越权断言全部在真实受限角色下得出，无 mock。
- **真实请求缝**：`requestAs(identity, input)` 用 WeakMap 把 Request 绑定到 fixture 身份作 `authenticate`，selector 读 `x-openbot-tenant` / `x-openbot-workspace`，走**真实** `createScopeResolver(...).resolve` → `createResourceReader(...).readAuthorizedResource`；错误映射表含 `AUTH_REQUIRED/TENANT_REQUIRED/WORKSPACE_REQUIRED/TENANT_FORBIDDEN/SCOPE_REVOKED/RESOURCE_NOT_FOUND/THREAD_SCOPE_NOT_FOUND/DATA_DATABASE_UNAVAILABLE`。
- **撤权真实路径**：`suspendCompanyMembership` 走 `provision.suspendMembership`（真实 epoch bump + 审计事件）。
- **环境变量**：`server/tests/support/enterprise-database.ts:9-11`（`ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL`）、`ENTERPRISE_TEST_SETUP_DATABASE_URL`/`TEST_DATABASE_URL`（`:37-39`）。
- **角色供给脚本（本工作树已有）**：`server/scripts/enterprise-test-db.ts`（migrate/provision 模式：CREATE ROLE login + `GRANT <capability> TO <login>`，`:215-238`；capability 为 NOLOGIN 的 `ob_ent_*`）；`server/scripts/migrate.ts:57-58`（生产侧 NOLOGin capability 角色名）；preflight：`server/scripts/enterprise-role-preflight.ts:12-14`、`server/tests/enterprise/enterprise-role-preflight.test.ts`。

**本工作树可直接当 prior-art 的等价测试**（fixture 移植前的写法参照）：

- `server/tests/enterprise/tenancy.integration.test.ts:48-96`（三角色 openVerified + 真实 resolver/reader + 撤权/无 grant 拒绝断言 `:252-360`）；
- `server/tests/enterprise/tenancy-rls.integration.test.ts:505-639`（事务内 set_config 后 RLS 放行/拒绝断言、grant 撤销、owner 转移防护）；
- `server/tests/enterprise/tenancy-connections.test.ts`、`authz.integration.test.ts:22,80`（policy 版本拒绝）。

---

## 6. 不确定项与需协调决策（明确标注，非猜测）

1. **选择头命名冲突**：现行 `x-openbot-tenant-id`/`x-openbot-workspace-id`（`index.ts:802-804`）vs interfaces.md T02 与 MT002 fixture 的 `x-openbot-tenant`/`x-openbot-workspace`。MT005 开工前需主控定夺（改代码或修订契约），二者取一，不得双读兼容了事。
2. **`conversations-v1` 策略版本在本栈不存在**（grep 无果）；interfaces.md「既有 tenancy-v1/conversations-v1 不变」中的 conversations-v1 属旧计划词汇。MT005 只须保持 tenancy-v1 不变。
3. **MT004/MT002 未集成进本工作树**：无 workspace membership 表、无 `server/tests/multitenancy/`。MT005 的 Blocked-by 状态在 facts 上仍成立；本报告的 `WorkspaceMember` 映射以「MT004 交付合入后」为前提。
4. **`PlatformScope` 无 `role`**：interfaces.md `WorkspaceMember.role`（workspace_admin|member）无法从 scope 读取，只能在事务内查表得出（与 T02「ResourceAccess 是事务内事实」一致）；但企业成员角色枚举目前是 `tenant_admin|member|auditor`（`enterprise-tenancy.ts:111-113` check），workspace_admin 是新枚举值，随 MT004 schema 落地。
5. **缺 workspace 选择子的错误码**：现行 `TENANT_REQUIRED` 双义（`store.ts:94`）；T02 要求拆出 `WORKSPACE_REQUIRED/400`。fixture 错误表已预留映射，改动点见 §4.2-1。
6. **`ResourceReader` 合同未被生产消费**（§3.2）：MT005 将 `requireInTx` 接到 runner/资源路径时是「首接」，需在验收中给出正向+越权证据，而非假设已有调用方。
7. 哈希差异（§0）：任务文本 HEAD 尾段与 git 实际值一位之差，已按 git 实际核对，不影响结论。

## 7. 证据索引（可复核命令）

- `git log -1 --format=%H`；`git show 24813ab4:server/src/enterprise/tenancy/scope.ts`、`…/transaction.ts`、`…/db/schema/enterprise-authz.ts`（旧栈基线）
- `grep -rn "resolveScope\|deliveryScopeFor" --include=*.ts .`（§1.2 全部调用点）
- `grep -rn "set_config" server/src | grep -v ", true)"` → 空（无会话级写入）；`grep -rn "reset_config\|DISCARD ALL\|RESET ALL" server/src` → 空
- `grep -rn "conversations-v1\|tenancy-v1" server/src server/tests`（§3.1）
- `grep -rn "app\.tenant_id\|app\.principal_id\|app\.user_id\|app\.workspace_id\|app\.operation_id\|app\.resource_id\|app\.operator_principal_id" server/src`（§2/§3 settings 面）
- i6-review2-mt131（只读）：`server/tests/multitenancy/support/fixture.ts`、`scenarios.ts`；契约：`/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy/docs/plans/2026-10-15-company-team-multitenancy/interfaces.md`（T02 段）；Ticket：`…/docs/tickets/multitenancy/tickets/MT005-team-eligibility-authz.md`；Ledger：`…/docs/plans/2026-10-15-company-team-multitenancy/dag-ledger.md`「2026-10-15 第二次同步」节。
