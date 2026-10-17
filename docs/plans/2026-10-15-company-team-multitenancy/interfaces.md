# 共同 Interface 与执行约束

所有共同接口在首次拥有它的 Task 定义并导出；后续任务仅 import。本文是实施决定，不是当前已存在代码的声明。沿既有类型导入 `Database`、`Scope`、`TxClient`、`Directory`，禁止另造可绕过签发校验的 Scope。

## T01：测试、清单与迁移

```ts
type IsolationObservation = Readonly<{
  positiveControlPassed: boolean;
  denied: boolean;
  leakedRecords: readonly unknown[];
  forbiddenEffects: readonly unknown[];
}>;
interface DomainScenarioAdapter {
  run(scenarioId: string): Promise<IsolationObservation>;
}
type FixtureIdentity = "a1-member" | "a2-member" | "a1a2-member" | "a1-other" | "b1-member" | "multi-company" | "company-admin" | "platform-operator" | "worker";
interface IsolationFixture {
  readonly ids: Readonly<Record<string, string>>;
  requestAs(identity: FixtureIdentity, input: Readonly<{
    method: string; path: string; body?: unknown;
    tenantId?: string; workspaceId?: string;
  }>): Promise<Response>;
  queryRestricted(role: string, context: Readonly<{
    tenantId: string; principalId?: string; workspaceId?: string;
  }> | undefined, text: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  externalEffects(): readonly unknown[];
  dispose(): Promise<void>;
}
interface CoverageInventory {
  base: string;
  routes: readonly { method: string; path: string; source: string; taskId: string; classification: SurfaceClass }[];
  jobs: readonly { source: string; taskId: string; classification: SurfaceClass }[];
  tables: readonly { name: string; source: string; taskId: string; ownership: DataOwnership }[];
  unclassified: readonly string[];
}
type SurfaceClass = "company-workspace" | "company-management" | "global-auth" | "global-static" | "platform-operator" | "machine-delegation" | "personal-model";
type DataOwnership = "global" | "company" | "workspace" | "personal-in-workspace" | "derived" | "personal-model";
```

`IsolationDomain` 是 `tasks.json` 中后端任务的 test 字段联合类型。`createIsolationFixture(domain)` 使用专用测试数据库、真实公司团队记录、实际 factory 和受限角色；fixture 暴露命名身份 `a1-member/a2-member/a1a2-member/a1-other/b1-member/multi-company/company-admin/platform-operator/worker`，场景 Adapter 在其 Test 旁实现。

`registerIsolationDomain(domain: IsolationDomain, adapter: DomainScenarioAdapter): void` 注册真实域场景；`runIsolationScenario(domain: IsolationDomain, scenarioId: string): Promise<IsolationObservation>` 只调用该 Adapter。未注册、异常或跳过必须报错，不能返回预设成功。正向控制从实际允许请求/操作得出；拒绝、副作用与记录均从实际结果观察。

T17 的 Web 测试 helper、T21 的桌面 helper、T22 的子模块 helper 各自实现 `runClientIsolationScenario(client, scenarioId)` 并返回同一 Observation 形状，使用对应实际 renderer/transport，不跨仓库 import 不兼容的 React 工具链。T20 Rust test helper `test_company_context_case` 在其测试模块内通过实际 CompanyContext 命令得出结果。

迁移工具命令：`bun --no-env-file server/scripts/multitenancy/migrate-test.ts generate T02` 或 `migrate T02`（Task ID 必须在固定 allowlist）；运行根目录为本执行工作区。主库变量 `TEST_DATABASE_URL`、独立 KB 变量 `TEST_KB_DATABASE_URL`；调用子进程时映射为其专用配置所需 URL，不打印 URL/密码，不读取 root .env，不修改共享实例已有登录密码。专用 PostgreSQL 实例中执行既有 `enterprise-test-db.ts roles` 建角色，并核验全部 ENTERPRISE_TEST_* 指向同一专用测试实例。

每次仅生成当前 Task 的已声明 schema 变化；主库编号0110–0125已按 BASE0109分配，KB编号0001按BASE0000分配。若其他更新改变最大编号，执行前由主控重新编号并更新 Ledger；未通过审查的变更不生成后续迁移。snapshot/journal 通过锁定 drizzle 工具生成。

## T02/T03：公司请求、团队事实及资源访问

```ts
type CompanyRequestContext = Readonly<{ scope: Scope; workspaceId?: string }>;
type WorkspaceMember = Readonly<{
  tenantId: string; workspaceId: string; principalId: string;
  role: "workspace_admin" | "member"; epoch: number;
}>;
type ResourceAction = "read" | "run" | "write" | "delete" | "share" | "manage";
type ResourceAccess = Readonly<{
  tenantId: string; workspaceId: string; resourceId: string;
  principalId: string; action: ResourceAction;
  revision: number; aclEpoch: number; workspaceMemberEpoch?: number;
}>;
interface ResourceAuthorization {
  requireInTx(tx: TxClient, scope: Scope, resourceId: string,
    action: ResourceAction, selectedWorkspaceId?: string): Promise<ResourceAccess>;
}
```

请求选择头为 `x-openbot-tenant`、`x-openbot-workspace`。公司与团队选择列表是成员资格的结果，不是授权 token；无公司选择 TENANT_REQUIRED/400，需团队但未选择 WORKSPACE_REQUIRED/400，无资格403，对象不可见404。保持现有身份401和依赖不可用503语义，业务 DTO 不输出 raw DB error。

`resolveCompanyRequest` 先用已有 resolveScope 建真实 Scope；传入 workspace selector 时验证所属公司及成员。不要求按 ID 的个人资源读取一定有 selector，读取从资源实际归属授权；列表/创建必须显式指定团队。上下文不允许在进程级变量中保存。

`withWorkspace` 包含已有 withTenant 的公司成员重验与事务本地配置，再重验 Workspace Membership。团队暂停与更改 epoch 的写事务使用统一锁顺序。公司管理员管理团队名单走公司管理动作，不假装成为团队内容成员。

ResourceAccess 是当前事务获得的事实，不是可序列化给 Worker 的永久能力。团队公共只允许设计中该资源的 read/run；write/delete/share/manage 要所有权或明确管理/动作 Grant。新策略 workspace-v1 才启用公共规则；既有 tenancy-v1/conversations-v1 不变。

`bindScopedDomain` 绑定不可变上下文并使用 factory 创建只供该作用域的业务 facade；它不偷偷创建跨请求 AsyncLocalStorage，也不持有跨网络调用事务。每个 facade 方法使用本地授权事务做读写，外部步骤使用固定调用上下文并在敏感动作前重验。

## T04：业务配置

```ts
type CompanyRuntimeConfig = Readonly<{
  tenantId: string; workspaceId?: string; configurationRevision: string;
  modelRouteId: string; modelCredentialId?: string;
  threadNamespace: string; defaultAgentId?: string;
  tenantPackageRevision: string; capabilityPolicyRevision: string;
}>;
interface CompanyRuntimeResolver {
  resolve(scope: Scope, workspaceId?: string): Promise<CompanyRuntimeConfig>;
}
```

CompanyRuntimeDependencies 包含配置 repository、可用能力读取与只读缓存接口；不得含可任意变更环境或未授权凭据的逃生入口。模型/默认 Bot 是引用，不内联 secret。部署的服务连接/密钥仍由既有配置装配提供。

域专用 `Scoped*Dependencies` 明确包含 `database: Database`、`runtime: CompanyRuntimeConfig`、`authorization: ResourceAuthorization` 及原有 factory 需要的既有 port。域专用 Services 直接导出实际 factory 的 ReturnType；不重复仿制已有 Store methods。接口出现增量 DTO 字段时由拥有域的任务在原 types 文件定义，接入者使用导出的同一类型。

## T07/T09：凭据与知识

ScopedCredentialLease 固定 credentialId、tenantId、workspaceId（团队归属时）、principalId（个人归属时）、purpose、expiry；只能交给服务器现有 transport，API 不返回解密 secret。CredentialPurpose 为 model/connector/agent/mcp/mcp_oauth_client/mcp_user_token/site-login；ConnectorCallbackContext 固定 tenantId/workspaceId/userId/connectionId/purpose/stateExpiry，验证后不能切换目标。

KnowledgeAccess 固定 tenantId/workspaceId/principalId/允许 kbIds/版本；KnowledgeQuery/Result 沿既有 knowledge/types.ts。普通业务检索必须有受限允许集合，不将空集合解释为全公司；专门平台维护角色的语义分开。跨主库与KB库的授权不会被声称为单库复合 FK。

## T10/T11：任务及执行

```ts
type ExecutionContext = Readonly<{
  jobId: string; tenantId: string; workspaceId: string;
  principalId: string; userId: string; initiatorKind: "human" | "delegated";
  configurationRevision: string; occurrenceId: string;
}>;
type ExecutionOwnership = Readonly<{
  tenantId: string; workspaceId: string; principalId: string; runId: string;
}>;
```

ExecutionContext 从持久任务读取并检查公司/团队、业务主体及原有委托；服务认证单独验证。ExecutionOwnershipVerifier 使用现有签名/能力验证路径校验输入并给出可信记录，不能只检查字段形状。`verifyExecutionOwnership` 对验证失败拒绝，返回记录必须与实际运行一致。

T11 导出所有原有 agent/runtime 适配器所用的同一 wire 合同，TS/Go/Python 的 golden/negative tests 绑定该合同。产生的用量 occurrence 不带可任意替换的余额账户，由T15按已固定业务上下文解析。

## T12–T16：业务资源、删除与计费

ArtifactAccess/ShareAccess 沿已有产物及分享 DTO，增加归属/受众/动作/到期/撤销校验事实；share token 不替代公司成员资格。CompanyDeletionManifest 记录 tenantId、目标 principalId、明确对象清单、调用授权/摘要/版本，不能用 userId 任意补扫其他公司；全局 self-account deletion 保持独立明确授权。

```ts
type CompanyBillingAccount = Readonly<{kind: "company"; accountId: string; tenantId: string; externalCustomerId: string}>;
type PersonalBillingAccount = Readonly<{kind: "personal"; accountId: string; userId: string; externalCustomerId: string}>;
type BillingAccount = CompanyBillingAccount | PersonalBillingAccount;
type UsageOccurrence = Readonly<{
  occurrenceId: string; accountId: string; accountKind: BillingAccount["kind"];
  tenantId?: string; workspaceId?: string; userId: string;
  botId?: string; runId?: string; modelId?: string;
}>;
```

公司调用必须含对应 tenant/workspace；个人 Bifrost 授权继续绑定个人，不提供“改扣公司”参数。accountId/externalCustomerId 区分公司和个人命名空间；原账户余额只能迁一次。金额、精度、尾差及未知费用保留各自已批准规则。Billing DTO 不包含付款人的私密材料；公司财务查询是独立管理动作。

CompanyManagementAction 为 members-read/members-write/workspaces-manage/runtime-config/billing-read/billing-manage/audit-read；auditor 仅能在明确管理规则内获得只读权限，不因此获得所有内容。`requireCompanyManagement` 不能凭旧 deployment admin role 放行其他公司。域 DTO 的字段沿当前业务types，不扩大支付或账号删除语义。

## T17–T22：客户端

Selection/OpenMuseCompanySelection/DesktopCompanySelection 的字段按各 Task 原 Interface，generation 是客户端响应防混用机制，不是服务端权限。客户端选择与 authority/user 绑定；每一在途请求/订阅捕获自己的冻结选择。

`scopeQueryKey` 固定返回 `["company-workspace", userId, tenantId, workspaceId, feature, args]`；generation 用于结果验收，不代替完整 key。切换完成前停止旧订阅与乐观更新；旧 generation 不渲染/回滚到新范围。同源作用域 Header 白名单覆盖审核业务路径，绝不加到第三方 URL 或模型个人 Key 请求。

T20 的 Rust CompanyContext/CompanyContextError 无 secret 字段；set/clear 命令实现后T21消费，不由前端 Agent 修改原生业务实现。

## T23–T26：观测、迁移和门禁

TraceBusinessContext 与 UsageOccurrence 使用相同公司/个人归属；不存在的 Opik/Bifrost 集成不在本任务制造功能，但实际启用路径必须提交相同保证证据。

BackfillManifest 包含源部署ID、根对象→公司/团队映射、子关联、外部存储映射、余额映射、未归属记录、源版本及hash；BackfillResult包含应用记录、核验结果、进度、失败/隔离对象。ReadinessReport包含每项schema/role/入口/外部资源/余额迁移结果与 `ready:boolean`，任何未知、未分类、未验证项为false。

AcceptanceReport包含 `release:boolean`、候选检查点hash、正向与拒绝结果、覆盖率、skips、失败、外部证据、Review/OCR报告路径与完整范围。它不是部署命令，不能自动迁移或发布。

