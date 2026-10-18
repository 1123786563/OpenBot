# MT122 设计 — 部署主入口请求上下文 + 作用域工厂（Issue #165）

## 0. 事实源与前置核验

- BASE f0520524（= prereq-manifest BASE，领取时逐项复算 107/107 哈希一致、BASE=HEAD）。
- `server/src/index.ts`=6ca171dc…、`server/src/app.ts`=c18817e3… 与 brief 谨慎边界逐字一致。
- 前置 MT014 / MT005 / MT041 已 verified 并集成于本树（runtime-config.ts / scope-gate.ts+store.ts /
  job-ownership.ts 均在树且迁移链 16 任务全部 apply 到专用库）。
- 基线复现：`bun test server/tests/multitenancy/` = **990 pass / 0 fail / 38 文件**（verification/00）。
- 专用容器：`mt122-impl-pg`（pgvector/pgvector:pg16 @ 127.0.0.1:55567），库 openbot_enterprise_w14e
  （brief 的 w14e 命名）+ _assigned + openbot_kb_w14e；七变量 env（test-env.sh，0600）。

## 1. 问题

部署主入口（`createApp` 装配的 `/api/*` 业务面 + 内部入口）目前没有"从已认证身份建立请求上下文"
的装配：业务依赖（会话内频道、Bot、账单、投递…）全部来自启动时按单份部署配置构造的 store；
公司/团队作用域只在企业入口（`/api/enterprise/*`，自建 scopes.resolve）与流式入口（CopilotKit
runner 的 resolveForThread）存在。Issue #165 要求部署主入口每个 HTTP/内部入口从已认证身份建立
请求上下文，并经作用域工厂取业务依赖。

## 2. 与既有装配的边界（关键事实，决定实现形状）

- **web 客户端只在 `/api/enterprise/*` 路径携带选择头**（app/src/lib/client.ts `scopeSelection`：
  非 enterprise 路径刻意丢弃 x-openbot-tenant/x-openbot-workspace）。因此入口中间件在多租户模式
  下对"无选择头的业务请求"一律拒绝 = 打断全部已验证 legacy 面——那是 MT125（旧接口迁移）的范围。
- **企业管理面**（POST /api/enterprise/workspace-scope/admin/teams）只带 tenant 头（被建团队尚不
  存在，无 workspace 资格可言）——对它要求双选择头会破坏 MT006 已验证面。
- **机器入口**（trigger ingress、worker `/internal/routines/run`、desktop/provider-proxy、
  host-access）按设计无用户会话；其上下文来源是服务器持久化归属（trigger 行/任务 pin），属
  MT123+ 的接线。
- 结论（披露 D2）：MT122 交付**接缝与工厂 + 装配**；入口级"无选择头业务请求整面拒绝"随 MT125
  客户端选择头铺设一起落地。fail-closed 由本票在接缝处结构性保证（业务依赖只有一条获取路径，
  无上下文即拒绝；不存在默认范围）。

## 3. 交付形状

### 3.1 新文件 `server/src/enterprise/tenancy/entry-context.ts`

- `createDeploymentEntryContextFactory({ directory, data, authenticate })`：
  - HTTP 半边：`createScopeResolver(directory, { authenticate, selectTenant, selectWorkspace })`
    ——与企业入口（conversation routes 的 scopes）同一构造函数、同裁决 #1 选择头语义；
    **共享实现**（AC3）：签发 WeakSet、成员资格 DB 重验、AUTH_REQUIRED / TENANT_REQUIRED /
    WORKSPACE_REQUIRED / TENANT_FORBIDDEN / WORKSPACE_FORBIDDEN 全部继承自 store.ts。
  - 内部半边：同一 `createScopeResolver` 构造、进程内专用 authenticate（actorId 来自
    fromInternalIdentity 参数 = 服务器持久化身份；entrypoint="schedule"）；合成 Request 只在
    进程内存在、永不挂载到任何 HTTP 面；每次建立仍走同一 DB 成员资格重验（无成员资格的机器
    身份 TENANT_FORBIDDEN——机器上下文拒绝）。
  - 作用域工厂（AC2）：`fromRequest(request)` / `fromInternalIdentity({actorId,tenantId,workspaceId})`
    → `{ scope, runtimeConfig(), transaction(op) }`：
    - `runtimeConfig()` = MT014 `createRuntimeConfigService(data).resolve(scope)`（每请求按上下文
      解析；cacheKey 含归属与配置版本；无配置行 RUNTIME_CONFIG_NOT_FOUND，无默认回退）；
    - `transaction(op)` = MT005 `createWorkspaceGate(data).transaction(scope, op)`（事务内两级
      成员重验；事务体只触数据通道——AC4）。
  - 服务与 gate 由工厂一次构造、按 scope 逐请求绑定——不是每请求重建连接池，也不是启动单份配置。
- `requireEntryBusiness(context)`：业务依赖唯一读取面；未建立 → `ENTRY_CONTEXT_REQUIRED`
  （fail-closed 读取器，杜绝"路由绕过中间件拿默认依赖"）。
- `createDeploymentEntryContextMiddleware({ factory, multitenancy })`：装配用中间件
  （仅多租户模式挂载；关闭时不在装配里出现，legacy 启动逐字节不变）：
  1. `matchGlobalException(method, path)` 命中 → 放行（MT030 登记表 = 显式全局例外，R5）；
  2. `/api/enterprise/` 前缀 → 放行（企业入口自建上下文，同一共享签发；整面迁移在 MT125）；
  3. 无选择头 → 放行（legacy 面尚未消费本接缝；业务依赖缺席，消费即拒——MT125 铺设选择头）；
  4. 携带选择头 → `fromRequest` 建立：成功则 `context.set("entryBusiness", …)`；失败按
     canonical 码映射拒绝（AUTH_REQUIRED→401、*_REQUIRED→400、*_FORBIDDEN→403）——**显式
     选择失败绝不落回默认处理**（AC1 的入口级拒绝半边）。
- 不改 startup-checks.ts / global-exceptions.ts：本票未新增全局端点（trigger/worker 入口在
  `/api/events` 与 `/internal`，前者无选择头走 3、后者不在 /api/* 下）。

### 3.2 装配（最小改动）

- `index.ts`：enterpriseCapabilities IIFE 内，directory/data/scopes 在手，构造 factory
  （authenticate 复用传给 createScopeResolver 的同一闭包——同一会话解析）并放入返回值；
  createApp 的 coworker 对象追加 `entryContext`。多租户关闭/企业能力缺失 → factory 为 null，
  装配面无行为变化。
- `app.ts`：coworker 类型追加 `entryContext?`；usage-origin 中间件之后挂载
  `createDeploymentEntryContextMiddleware`（其后注册的全部业务路由经过它；此前注册的
  capabilities/auth/enterprise 面不经它——与它们各自的上下文建立方式一致）。

### 3.3 测试 `server/tests/multitenancy/entry-context.test.ts`（票面 Verification 命令）

真实 PostgreSQL（专用库三角色 + RLS），零授权 mock；缺 env 显式 skip。夹具
`support/entry-context.ts` 复用 `createRuntimeConfigFixture`（公司 A teams a1/a2、公司 B b1、
operator 通道写配置文档）+ directory/data 受限通道 + scopeless user + 无成员资格机器身份。

用例组：
- AC1 fail-closed：双选择头签发受信 scope；缺 tenant/缺 workspace → TENANT_REQUIRED /
  WORKSPACE_REQUIRED；跨公司 tenant → TENANT_FORBIDDEN；A 公司选 B 公司团队 →
  WORKSPACE_FORBIDDEN；中间件层"带选择头但建立失败"→ canonical 码拒绝、探针 handler 不达；
  无上下文消费 `requireEntryBusiness` → ENTRY_CONTEXT_REQUIRED（无任何默认依赖路径）。
- AC2 工厂按上下文：A/a1（公司默认模型 m1）vs A/a2（团队覆盖默认模型 m2）→ 同一请求路径两次
  建立得到**不同** runtimeConfig（cacheKey/defaultModel 随上下文）；同一 scope 两次请求 →
  业务对象为新实例（每请求构造）；配置文档深冻结。
- AC3 共享实现：工厂 scope 通过与企业入口同一 `assertTrustedScope`；伪造 scope 对象
  UNVERIFIED_SCOPE；拒绝码与企业入口 seam 同串（同一 store.ts 实现）。
- 内部入口：持久化归属身份建立成功（entrypoint=schedule，配置随上下文）；机器身份无成员资格 →
  TENANT_FORBIDDEN；内部身份越权选 B 公司 → TENANT_FORBIDDEN；HTTP 面拿机器请求走
  fromRequest → AUTH_REQUIRED。
- AC4：`business.transaction` + `runtimeConfig()` 执行期间包装 globalThis.fetch 计数 → 事务
  提交且 fetch 计数 0（测试包装证据）；静态扫描存档（verification/）。

### 3.4 变异自证（≥3，全部 KILLED）

- MUT1 默认范围 fail-closed：fromRequest 缺选择头时回退"默认公司/默认团队" → AC1 缺头用例失败。
- MUT2 工厂按上下文：工厂返回与 scope 无关的共享业务对象 → AC2 双上下文差异用例失败。
- MUT3 机器上下文拒绝：内部建立跳过 DB 成员资格重验 → 机器身份用例失败。

## 4. AC → 证明映射

| AC | 证明 |
|----|------|
| AC1 每入口建立上下文；缺上下文拒绝、无默认范围 | 夹具全拒绝码矩阵 + 中间件显式选择失败拒绝 + requireEntryBusiness 消费拒绝；MUT1 |
| AC2 依赖来自作用域工厂 | 双上下文 runtimeConfig 差异 + 每请求新实例 + 无配置行 RUNTIME_CONFIG_NOT_FOUND；MUT2 |
| AC3 与企业/流式入口一致 | assertTrustedScope 通过（同一签发 WeakSet）+ 伪造拒绝 + 同码；工厂即消费 createScopeResolver 构造函数 |
| AC4 事务不跨外部网络 | fetch 包装计数 0 + gate 事务（MT005）statement_timeout 既有面；静态扫描存档 |
