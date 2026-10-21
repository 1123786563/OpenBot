# 02：租户隔离、身份与权限实施计划

> **面向执行 Agent：** 使用 `subagent-driven-development` 或 `executing-plans` 按任务执行，读取本册及总计划后开始。步骤以复选框跟踪；当前仅授权编写计划，未授权编码、安装、数据库操作、部署或 Git 提交。

**目标：** 在统一基线 `enterprise-mvp-v0.2`（2026-10-09）的前提下，保留 TypeScript/Hono/Bun 控制平面和现有认证体系，建立显式租户身份、数据库纵深隔离、资源授权以及与旧业务路由隔离的企业 API。

**架构：** 认证只证明用户身份；身份目录证明其 Principal 和租户成员关系；服务端签发只在进程内可构造的 Scope；业务数据库事务设置局部上下文并受 RLS 约束。资源读取由 PostgreSQL 权威 ACL 与进程内 TypeScript 授权服务决定，并在一个短的 `READ COMMITTED` 事务内锁定、复核成员/ACL/策略版本后返回受限元数据。

**技术栈：** 当前 Hono、Bun、Drizzle ORM、PostgreSQL、Better Auth、Zod。Go 仅为候选执行运行时，不是本册控制平面；授权规则随应用制品版本化发布，不增加外部授权服务、策略语言或 SDK。

**规范性索引（enterprise-mvp-v0.2，2026-10-09）：** M指[总计划00](../../plans/superpowers/2026-10-09-enterprise-ai-00-master.md)，其§1为决策、§4为共同wire契约、§6为门禁唯一注册；总体依据见[总体方案](../../specs/superpowers/2026-10-09-enterprise-ai-platform-design.md)。发现冲突须修文档而不是绕过。本册只实现租户/身份/资源范围，03–06待编写，不声称其实现完备。

**本次已确认修订：** 当前整个 MVP 不引入 OpenFGA/OPA，不部署对应服务，不维护策略包、外部模型或自动后备实现；未来引入外部引擎必须另行 ADR、设计和批准。MVP 本地 Authz 只决定资源 `read`，工具 `ActionPolicy` 由 04 以确定性 TypeScript 实现；二者不能互相冒充。本轮总体方案与 00/01/02 同步修订，评审报告为修订前问题快照，不改变其历史行号。

## 全局约束

- “一个数据域一个写入方。”成员和资源 ACL 以 PostgreSQL 为权威来源，TypeScript 授权服务读取权威快照，不持有另一份授权数据。
- “同一产品，两类部署”。私有化也使用显式 tenant_id，不以单租户为由关闭授权。
- “应用连接不能是超级用户、BYPASSRLS 角色或具有绕过能力的所有者。”
- “连接池中租户上下文在事务内设置、事务结束清除；无 tenant context 默认拒绝；后台任务同样遵守。”
- “平台管理员身份不自动授予租户业务内容访问权。”
- “缓存、对象路径、索引、事件、队列、日志查询都携带租户边界”。本册定义约定，实际存储消费者由后续分册接线验收。
- 不接受用户提交的 actorId、principalId、role、tenantId 或 forwardedProps 作为权威身份。
- 不自动根据邮箱域、同名组织、租户包或部署级管理员名单为用户加入租户。
- 不改写用户现有前端/i18n、源代码、锁文件或 `.gitignore`；本轮只同步总体方案和00/01/02文档，不创建后续分册或执行其中命令。
- 所有测试身份、文档和数据库均为隔离测试资源，不使用生产库和真实租户材料。
- 本册代码和 SQL 是待执行实现内容，不是已经编译、运行或通过测试的声明。测试参数是建议配置，不是实测性能。

---

## 1. 本册范围、前置与独立完成标准

### 1.1 纳入

- T1：租户、主体、成员、空间和资源 ACL 数据模型（MVP 不建 Project 表）；身份目录查询；数据库角色与 RLS；迁移与离线开通及资源/ACL 受控 CLI 闭环。
- T2：会话验证、Scope、单事务资源读取、本地资源 `read` 授权决策、撤权竞争处理、跨租户负向测试。
- T3：独立企业应用、独立启动入口、受保护资源查询、认证桥接、健康检查、路由隔离与交接；公开 API 与内部运行/工具路由分离。

### 1.2 不纳入

Go 控制平面迁移、重写 Better Auth、所有历史业务数据的自动迁移、公开注册与自动加入组织、成员管理前端、支付套餐、完整运行账本、长期委托凭证、对象存储服务实现。本册为这些后续能力提供必要权限契约，不声称它们已经实现。

### 1.3 可独立验收的结果

启动独立企业 API，合法用户能选择自己所属租户并读取自己明确有权限的资源元数据；其他租户、非成员、已撤权用户、部署级管理员绕过尝试均被拒绝。只运行企业服务时不要求 Intelligence、Go 运行时或模型端点存在。

T1/T2 不依赖 R1–R4。T3 的集成测试使用真实 PostgreSQL、本地授权实现和隔离身份环境；启动和测试均不需要外部授权服务配置。单元测试可替代数据库依赖，但不能将替身结果登记为真实 RLS、撤权或认证链路通过。

## 2. 已核对的代码接缝

| 现有位置 | 事实 | 计划约束 |
|---|---|---|
| `server/src/auth/guards.ts:7-32` | AuthService 返回认证 user，AuthenticatedActor 带部署级 role | 企业认证复用 AuthService，不用 admin/user 推导租户权限 |
| `server/src/auth/guards.ts:55-90` | createRequireUser 同时要求部署级角色 | 新 enterprise guard 单独检查租户成员；不更改旧 guard 语义 |
| `server/src/auth/index.ts:163-185` | createAuth 当前接受完整 DeploymentConfig | 缩小所需配置的类型，不构造假的 Intelligence 配置 |
| `server/src/auth/index.ts:320-355` | Better Auth 使用数据库适配器及 SSO 配置加密 | 保留该实现，身份数据连接与业务数据连接分开 |
| `server/src/auth/index.ts:356-368` | OAuth Token 加密已启用 | 不重写加密，不返回账号表或令牌 |
| `server/src/db/schema/core.ts:64-177` | users/accounts/user_roles 为已有全局身份数据 | 新 tenant membership 另建，不在 users 上追加唯一 tenant_id |
| `server/src/auth/scim.ts:63-102` | 撤销与 offboard 当前具有部署级语义 | MVP 不把全局 SCIM 连接直接共享为多企业目录；先人工确定连接归属 |
| `server/src/db/client.ts:197-238` | createDatabase(url,options)；显式地址；清除 DATABASE_URL | 在建立第一个连接前一次读取所有连接配置 |
| `server/src/db/schema/json.ts:20-29` | 必须使用本地 jsonb 类型避免双重序列化 | 新 JSON 字段同样从 `./json` 导入 |
| `server/drizzle.config.ts:20-42` | Schema 显式清单 | 新 Schema 必须同时加入清单与 schema/index.ts |
| `server/tests/support/database.ts:10-47` | 测试库必须显式配置，不允许应用 openbot 库 | 测试没有库就失败，不能 skip 掩盖安全缺口 |
| `server/src/config.ts:1259-1263` | loadConfig 构造全平台依赖 | 企业入口不调用 loadConfig；只复用独立身份配置解析 |

上述是局部只读证据，不是全量安全审计。已看到 `users.groups` 在不同文件注释中存在历史差异，实施时按当前 SCIM 实际行为验证，不能只引用旧注释判断已接通或不存在。

## 3. 文件与职责

本册列出的生产文件是目标清单，不保证当前不存在；实施前先核对已有代码并局部修改。本轮仅修改四份既有文档，不创建生产代码或03–06分册。所有片段为接口/算法骨架，完整Schema、导入、类型、日志和错误映射由相应步骤实现并测试，不能把未定义helper当成已有库能力。

| 路径 | 职责 |
|---|---|
| `shared/enterprise/contracts.ts` | 可公开 DTO，不含 Scope、凭证或权限引擎配置 |
| `server/src/db/schema/enterprise-tenancy.ts` | tenants/principals/memberships/workspaces（MVP 不建 Project） |
| `server/src/db/schema/enterprise-authz.ts` | resources/grants/security_events；独立全局identity_events审计域 |
| `server/src/enterprise/contracts.ts` | Scope、Directory、ResourceReader、Authz 接口 |
| `server/src/enterprise/errors.ts` | 稳定安全错误 |
| `server/src/enterprise/tenancy/directory.ts` | 用认证用户 ID 查询自身 Principal 和成员关系 |
| `server/src/enterprise/tenancy/scope.ts` | 构造 Scope，拒绝缺失/暂停/撤销成员 |
| `server/src/enterprise/tenancy/transaction.ts` | 同一 DB 事务内局部上下文及 epoch 复核 |
| `server/src/enterprise/tenancy/provision.ts` | 运维开通、暂停成员，事务审计和幂等 |
| `server/src/enterprise/authz/repository.ts` | 资源与 ACL 权威快照、版本复核 |
| `server/src/enterprise/authz/service.ts` | 本地读取授权：同租户、显式 ACL、动作白名单与受支持策略版本 |
| `server/src/enterprise/tenancy/routes.ts` | 当前 scope、空间与资源元数据 API |
| `server/src/enterprise/config.ts` | 独立启动配置，禁止单用户后门 |
| `server/src/enterprise/app.ts` | 仅企业路由和认证路由白名单 |
| `server/src/enterprise/bootstrap.ts` | 对象参数 DI，多个最小权限连接池 |
| `server/src/enterprise/index.ts` | 启动、依赖检查、信号与资源清理 |
| `server/scripts/enterprise-provision.ts` | 租户成员/资源/ACL离线CLI，默认dry-run |
| `server/scripts/enterprise-identity-provision.ts` | 独立全局principal创建/暂停CLI，独立凭证与身份审计 |
| `server/src/enterprise/auth-route-profile.ts` | 经锁定SDK及真实登录测试批准的编译期认证路由集合 |
| `server/ops/enterprise/roles.sql` | DBA 执行的无密码 NOLOGIN 能力角色定义；RLS custom migration 是唯一可执行策略来源 |
| `server/tsconfig.enterprise-tests.json` | 新域、enterprise runtime 与新测试的类型检查 |
| `server/tests/enterprise/tenancy/` | T1–T3 单元、真实数据库、协议与 HTTP 测试 |

后续实施的既有文件改动限身份/config、Schema导出/Drizzle清单、server/package及实际CI入口中调用企业类型检查的最小变更；精确CI文件在执行前定位确认，不顺带改无关流水线。本轮不修改这些源文件。迁移编号由journal生成，本册不改旧createApp位置参数或挂旧业务路由。

## 4. 类型、错误与命名合同

### 4.1 `shared/enterprise/contracts.ts`

```ts
export type TenantRole = "tenant_admin" | "member" | "auditor";
export type TenantSummary = { id: string; name: string; role: TenantRole };
export type ScopeView = { tenantId: string; principalId: string; role: TenantRole };
export type ResourceView = { id: string; workspaceId: string; kind: string; revision: number };
```

### 4.2 `server/src/enterprise/contracts.ts`

```ts
import type { Database } from "../db/client";
import type { ResourceView, TenantRole } from "../../../shared/enterprise/contracts";
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Membership = {
  tenantId: string; principalId: string; tenantName: string;
  role: TenantRole; epoch: number;
  tenantStatus: "active" | "suspended";
  principalStatus: "active" | "suspended";
  memberStatus: "active" | "suspended";
};
export interface Directory {
  listForUser(userId: string): Promise<Membership[]>;
}
export type Scope = Readonly<{
  tenantId: string; principalId: string; userId: string;
  role: TenantRole; epoch: number;
}>;
export type ResourceSnapshot = {
  id: string; tenantId: string; workspaceId: string; kind: string;
  revision: number; aclEpoch: number; policyRevision: string;
  active: boolean; locallyAllowed: boolean;
};
export type AuthorizationInput = { scope: Scope; resource: ResourceSnapshot; action: "read" };
export interface Authz { check(input: AuthorizationInput): Promise<boolean>; }
export interface ResourceReader {
  readAuthorizedResource(scope: Scope, resourceId: string): Promise<ResourceView>;
}
```

业务库事务类型从现有 Database 派生，不新造不同驱动的事务。`Scope` 的 TypeScript readonly 不构成可信边界；T2 用 WeakSet 记录本进程合法 Scope，并在真实事务中重新检查数据库 epoch。

### 4.3 `server/src/enterprise/errors.ts`

```ts
export class EnterpriseError extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 500 | 503) {
    super(code);
  }
}
```

统一含义：无会话401；未选/非法租户400；非成员/暂停403；不可见资源404；操作幂等/更新版本冲突409；可识别依赖超时/不可用、损坏授权状态或未知策略503；其他程序错误500。数据库/认证适配器按已识别驱动错误码映射EnterpriseError，不用错误消息正则猜类别；所有未知错误失败关闭。对外错误含code/request_id/retryable/安全summary，默认不自动重试；本册只读503是否可重试可由稳定错误细分，不能诱导工具重试。日志用服务器生成关联ID、稳定内部原因分类，绝不输出原始DB报错、凭证、正文或用户提供的request-id字符串。

## 5. T1：数据域、身份目录与数据库隔离

MVP 身份模型固定为：自然人 `principal` 绑定现有认证 `user`，个人会话由人类 principal 发起；短期受控调度只能携带经批准、可撤销、限时委托，不伪造用户或创建服务账号。共享会话、独立非人 principal、Project/空间角色继承均为二期，不得在本册或实现中隐式加入。

### T1-A：建立可迁移 Schema

**文件：** 新增两个 Schema 文件；修改 Schema 导出与 Drizzle 清单；测试 `server/tests/enterprise/tenancy/schema.test.ts`。

**消费：** 既有 `users.id` 与本地 jsonb。
**产出：** 下列导出表。复合键、索引和检查约束以列出的精确组合生成。

- [ ] **1. 编写 Schema 注册失败测试。**

```ts
import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { enterpriseTenants, enterpriseWorkspaces } from "../../../src/db/schema";
test("enterprise tenancy tables are exported", () => {
  expect(getTableName(enterpriseTenants)).toBe("enterprise_tenants");
  expect(getTableName(enterpriseWorkspaces)).toBe("enterprise_workspaces");
});
```

- [ ] **2. 从仓库根运行目标测试，确认因尚未导出而失败。**

```bash
bun test server/tests/enterprise/tenancy/schema.test.ts
```

- [ ] **3. 创建 `enterprise-tenancy.ts`，不向现有 users 加租户字段。**

```ts
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";
const stamp = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const enterpriseTenants = pgTable("enterprise_tenants", {
  id: text("id").primaryKey(), name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  policyRevision: text("policy_revision").notNull().default("tenancy-v1"),
  createdAt: stamp(),
}, t => [check("enterprise_tenant_status", sql`${t.status} in ('active','suspended')`)]);
export const enterprisePrincipals = pgTable("enterprise_principals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  status: text("status").notNull().default("active"), createdAt: stamp(),
}, t => [uniqueIndex("enterprise_principal_user").on(t.userId),
  check("enterprise_principal_status", sql`${t.status} in ('active','suspended')`)]);
export const enterpriseMemberships = pgTable("enterprise_memberships", {
  tenantId: text("tenant_id").notNull().references(() => enterpriseTenants.id),
  principalId: text("principal_id").notNull().references(() => enterprisePrincipals.id),
  role: text("role").notNull(), status: text("status").notNull().default("active"),
  epoch: integer("epoch").notNull().default(1), createdAt: stamp(),
}, t => [primaryKey({columns:[t.tenantId,t.principalId]}),
  check("enterprise_member_role", sql`${t.role} in ('tenant_admin','member','auditor')`),
  check("enterprise_member_status", sql`${t.status} in ('active','suspended')`),
  check("enterprise_member_epoch", sql`${t.epoch} > 0`)]);
export const enterpriseWorkspaces = pgTable("enterprise_workspaces", {
  tenantId: text("tenant_id").notNull().references(() => enterpriseTenants.id),
  id: text("id").notNull(), name: text("name").notNull(), createdAt: stamp(),
}, t => [primaryKey({columns:[t.tenantId,t.id]})]);
```

- [ ] **4. 创建 `enterprise-authz.ts`。**

```ts
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { enterpriseMemberships, enterpriseTenants, enterpriseWorkspaces } from "./enterprise-tenancy";
export const enterpriseResources = pgTable("enterprise_resources", {
  tenantId: text("tenant_id").notNull(), id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(), kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  aclEpoch: integer("acl_epoch").notNull().default(1),
}, t => [primaryKey({columns:[t.tenantId,t.id]}),foreignKey({
  columns:[t.tenantId,t.workspaceId],
  foreignColumns:[enterpriseWorkspaces.tenantId,enterpriseWorkspaces.id],
}),check("enterprise_resource_status",sql`${t.status} in ('active','deleted')`),
check("enterprise_resource_versions",sql`${t.revision}>0 and ${t.aclEpoch}>0`)]);
export const enterpriseResourceGrants = pgTable("enterprise_resource_grants", {
  tenantId: text("tenant_id").notNull(), resourceId: text("resource_id").notNull(),
  principalId: text("principal_id").notNull(), action: text("action").notNull(),
}, t => [primaryKey({columns:[t.tenantId,t.resourceId,t.principalId,t.action]}),
  foreignKey({columns:[t.tenantId,t.resourceId],foreignColumns:[enterpriseResources.tenantId,enterpriseResources.id]}),
  foreignKey({columns:[t.tenantId,t.principalId],foreignColumns:[enterpriseMemberships.tenantId,enterpriseMemberships.principalId]}),
  check("enterprise_grant_action",sql`${t.action}='read'`)]);
export const enterpriseSecurityEvents = pgTable("enterprise_security_events", {
  tenantId: text("tenant_id").notNull().references(()=>enterpriseTenants.id),
  id: text("id").notNull(), operationId: text("operation_id").notNull(),
  actor: text("actor").notNull(), kind: text("kind").notNull(),
  details: jsonb("details").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [primaryKey({columns:[t.tenantId,t.id]})]);
export const enterpriseIdentityEvents = pgTable("enterprise_identity_events", {
  id: text("id").primaryKey(), operationId: text("operation_id").notNull(),
  actor: text("actor").notNull(), principalId: text("principal_id").notNull(),
  kind: text("kind").notNull(), details: jsonb("details").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
});
```

`enterprise_identity_events`是独立全局身份审计域，不使用空tenant或任意租户承载；仅离线identity operator追加/读取，API无权限。所有安全事件以id=operationId保证幂等；details经strict事件Schema校验后读取，不直接访问未解析JSON属性。补membership `(principal_id,tenant_id)`和安全事件 `(tenant_id,created_at,id)`索引；现有principal.userId唯一索引已覆盖身份查找，不盲目重复建索引。以真实规模和EXPLAIN验证目录、ACL及撤权查询。

MVP 的 `read` 授权不是任意动作。执行、编辑、发布、下载和审批动作由后续模块扩展模型并增加测试，不能把本册 read 映射成全部允许。

- [ ] **5. 注册 Schema，生成迁移并检查没有删除旧表。**

向 `schema/index.ts` 追加 `export * from "./enterprise-tenancy"; export * from "./enterprise-authz";`；向 Drizzle schema 数组追加两个精确路径。`db:generate` 原脚本加载 `.env`，本册测试操作不用它，使用下一任务隔离迁移入口。

- [ ] **6. 复跑注册测试和 server 类型检查。**

```bash
bun test server/tests/enterprise/tenancy/schema.test.ts
bun run --cwd server typecheck
```

### T1-B：受限角色、RLS 与安全测试库

**文件：** 新建 `server/ops/enterprise/roles.sql`、`server/scripts/enterprise-test-db.ts`、`server/tests/enterprise/tenancy/rls.test.ts`；新增由 Drizzle 分配编号的普通迁移和唯一可执行的 RLS custom migration。不再维护独立的 `policies.sql` 文件，避免与 custom migration 双份漂移；RLS custom migration 是唯一可执行策略来源。

**产出：** 目录查询、业务读取、离线授权操作互不共享数据库角色；API 不持有迁移凭证。

#### 角色合同

| 能力角色（NOLOGIN） | 最小权限 | 持有者 |
|---|---|---|
| `ob_ent_directory` | 当前认证 user 对应的 principal、membership、tenant 只读 | Enterprise API 目录连接 |
| `ob_ent_data` | 当前scope的空间/资源/本人grants读取 | Enterprise API业务连接 |
| `ob_ent_operator` | 指定租户内 membership/workspace/resource/ACL 的受控增改，安全事件追加；不得写全局 principal 绑定/状态 | 独立离线租户运维进程；API 不加载 |
| `ob_ent_identity_operator` | 全局 principal 创建/暂停与已批准绑定修复；仅离线、独立审批和全局身份审计 | 身份/平台运维；租户 operator 不可继承 |
| 身份数据库角色 | 现有 Better Auth 所需身份表访问（按认证工厂权限枚举）；不授予新企业业务表 | 独立认证连接 |
| 迁移所有者 | DDL、角色授权、备份恢复 | 发布/DBA，不能进入业务运行环境 |

- [ ] **1. 编写实际数据库拒绝测试，依赖缺失必须失败。**

```ts
import { expect, test, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import { testDatabaseUrlFrom } from "../../support/database";
const address = testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.ENTERPRISE_TEST_DATA_DATABASE_URL });
const database = createDatabase(address, { max: 1 });
afterAll(async () => { await database.$client.close(); });
test("data role sees no rows without local context", async () => {
  const rows = await database.execute(sql`select id from enterprise_resources`);
  expect(rows).toHaveLength(0);
});
test("data role cannot truncate a tenant table", async () => {
  await expect(database.execute(sql`truncate enterprise_resources`)).rejects.toThrow();
});
```

使用由 G0 配置的受限登录账号，不要用超级用户运行后以“没有发生泄漏”作为证据。加一条 catalog 测试核对 `rolsuper=false`、`rolbypassrls=false`、无 owner role 可切换成员关系。

- [ ] **2. DBA 在专用测试实例建立角色，禁止写入密码。**

```sql
CREATE ROLE ob_ent_directory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_data NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE ob_ent_identity_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator;
```

角色已经存在时先比对属性，不忽略异常。DBA 通过环境批准的账号系统创建不同 LOGIN 用户并仅授予一个能力角色；API登录用户不能是 operator、迁移owner或角色管理员。保留数据库默认权限不代表正确，应逐表检查 PUBLIC 没有绕过授权。

- [ ] **3. 创建测试迁移执行器，命令不能隐式加载生产 `.env`。**

```ts
import { testDatabaseUrl } from "../tests/support/database";
const url = testDatabaseUrl();
const mode = process.argv[2];
if (!new Set(["generate","migrate","custom"]).has(mode ?? "")) {
  throw new Error("Use generate, migrate or custom");
}
const command = mode === "custom"
  ? ["bun","--no-env-file","x","--no-install","drizzle-kit","generate","--custom","--name=enterprise_tenancy_rls","--config=drizzle.config.ts"]
  : ["bun","--no-env-file","x","--no-install","drizzle-kit",mode!,"--config=drizzle.config.ts"];
const child = Bun.spawn(command, {
  cwd: new URL("../",import.meta.url).pathname,
  env: { PATH:process.env.PATH, HOME:process.env.HOME, DATABASE_URL:url },
  stdout:"inherit",stderr:"inherit",
});
process.exit(await child.exited);
```

此脚本只用于明确的隔离测试库；`--no-install` 禁止下载未锁定依赖。若所锁定 Bun 不支持指定 CLI 参数，直接停止并按其 help 修正，不能删除安全参数然后对默认数据库执行。实际生产迁移另由批准的发布作业注入目标，不复用 test helper。

```bash
bun --no-env-file server/scripts/enterprise-test-db.ts generate
bun --no-env-file server/scripts/enterprise-test-db.ts custom
```

- [ ] **4. 写入目录域 RLS。**

```sql
ALTER TABLE enterprise_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_self ON enterprise_principals FOR SELECT TO ob_ent_directory
USING (user_id = nullif(current_setting('app.user_id',true),''));
CREATE POLICY data_self ON enterprise_principals FOR SELECT TO ob_ent_data
USING (id = nullif(current_setting('app.principal_id',true),'')
 AND user_id = nullif(current_setting('app.user_id',true),''));

ALTER TABLE enterprise_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_memberships ON enterprise_memberships FOR SELECT TO ob_ent_directory
USING (EXISTS (SELECT 1 FROM enterprise_principals p WHERE p.id=enterprise_memberships.principal_id));
CREATE POLICY data_membership ON enterprise_memberships FOR SELECT TO ob_ent_data
USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')
 AND principal_id=nullif(current_setting('app.principal_id',true),''));

ALTER TABLE enterprise_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_tenants ON enterprise_tenants FOR SELECT TO ob_ent_directory
USING (EXISTS (SELECT 1 FROM enterprise_memberships m WHERE m.tenant_id=enterprise_tenants.id));
CREATE POLICY data_tenant ON enterprise_tenants FOR SELECT TO ob_ent_data
USING (id=nullif(current_setting('app.tenant_id',true),''));
GRANT SELECT ON enterprise_principals,enterprise_memberships,enterprise_tenants TO ob_ent_directory,ob_ent_data;
```

无目录→tenant→member→directory 递归循环：principal 仅对当前 user；membership 子查询 principal；tenant 子查询 membership。所有未限定的列在实际迁移中用目标表名限定，避免关联到内层同名列造成恒真。

- [ ] **5. 写入业务域 RLS，表名来自固定清单，不来自请求。**

```sql
DO $policy$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_workspaces',
    'enterprise_resources','enterprise_resource_grants','enterprise_security_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_data ON %I FOR SELECT TO ob_ent_data USING
      (tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t);
  END LOOP;
END $policy$;
CREATE POLICY self_grants ON enterprise_resource_grants AS RESTRICTIVE
FOR SELECT TO ob_ent_data
USING (principal_id=nullif(current_setting('app.principal_id',true),''));
GRANT SELECT ON enterprise_workspaces,enterprise_resources,
 enterprise_resource_grants TO ob_ent_data;
```

security_events 不授予 data SELECT；保留策略不等于获得表权限。RLS 只作为租户纵深边界，资源级细粒度控制由 T2 执行；允许 data查询同租户资源元数据不代表允许 API原样返回所有元数据。

- [ ] **6. 写入离线 operator 的显式策略与最小授权。**

```sql
CREATE POLICY operator_tenants ON enterprise_tenants TO ob_ent_operator
USING (id=nullif(current_setting('app.tenant_id',true),''))
WITH CHECK (id=nullif(current_setting('app.tenant_id',true),''));
DO $operator$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_memberships','enterprise_workspaces',
    'enterprise_resources','enterprise_resource_grants','enterprise_security_events'] LOOP
    EXECUTE format('CREATE POLICY operator_scope ON %I TO ob_ent_operator USING
      (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK
      (tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t);
  END LOOP;
END $operator$;
GRANT SELECT,INSERT,UPDATE ON enterprise_tenants,enterprise_memberships,
 enterprise_workspaces,enterprise_resources TO ob_ent_operator;
GRANT SELECT,INSERT,DELETE ON enterprise_resource_grants TO ob_ent_operator;
GRANT SELECT,INSERT ON enterprise_security_events TO ob_ent_operator;
CREATE POLICY operator_principal_lookup ON enterprise_principals FOR SELECT TO ob_ent_operator
USING (id=nullif(current_setting('app.operator_principal_id',true),''));
GRANT SELECT (id,user_id,status) ON enterprise_principals TO ob_ent_operator;
CREATE POLICY identity_principal_read ON enterprise_principals FOR SELECT TO ob_ent_identity_operator USING (true);
CREATE POLICY identity_principal_create ON enterprise_principals FOR INSERT TO ob_ent_identity_operator WITH CHECK (true);
CREATE POLICY identity_principal_status ON enterprise_principals FOR UPDATE TO ob_ent_identity_operator USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON enterprise_principals TO ob_ent_identity_operator;
GRANT UPDATE (status) ON enterprise_principals TO ob_ent_identity_operator;
ALTER TABLE enterprise_identity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_identity_events FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_audit ON enterprise_identity_events TO ob_ent_identity_operator
USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON enterprise_identity_events TO ob_ent_identity_operator;
REVOKE ALL ON enterprise_identity_events FROM PUBLIC,ob_ent_directory,ob_ent_data,ob_ent_operator;
```

operator 可以选择租户，是显式离线特权操作，不能作为公开管理 API 的通用连接。它不访问用户密码/Token；由 DBA/审批流程给已有认证 userId开通，不根据邮箱猜测归属。

- [ ] **7. 应用迁移并执行 RLS测试。**

```bash
bun --no-env-file server/scripts/enterprise-test-db.ts migrate
bun test server/tests/enterprise/tenancy/rls.test.ts
```

错误须区分角色/Schema缺失、连接失败、表权限拒绝、RLS拒绝和复合FK拒绝，不把环境失败记为安全通过。无context测试前，用受控fixture角色确认A/B资源确实存在，并证明对应受限角色在合法context下得到非空正向结果；再移除context断言无行。

分别验收：data角色UPDATE/TRUNCATE因表权限拒绝；operator在合法A context下将A资源tenant_id改为B（B/workspace真实存在）因WITH CHECK拒绝；同A tenant下引用仅在B存在的workspace因复合FK拒绝。记录驱动SQLSTATE/对象而非只匹配toThrow；禁止给data临时加写权限来让测试成立。另测目录只列本人、不能SET ROLE owner/identity_operator、不能DDL、权限清除后同连接复用。

### T1-C：显式开通与版本化撤权

**文件：** `tenancy/provision.ts`、`server/scripts/enterprise-provision.ts`、`server/tests/enterprise/tenancy/provision.test.ts`。
**接口：** `provisionMember(db:Database,input:ProvisionInput):Promise<void>`；`ProvisionInput={tenantId,tenantName,principalId,userId,role,operator,operationId}`，所有ID为服务端配置或已批准运维输入。另提供严格、受控的 `createWorkspace/createResource/grantRead/revokeRead`，均要求 `operationId`、固定锁顺序、epoch 递增和同事务审计；不得让 API 使用 operator 连接补洞。

- [ ] **1. 写相同操作重放不增加 epoch 的数据库测试。**

```ts
const input = {tenantId:"test-a",tenantName:"Test A",principalId:"p-a",userId:"fixture-user-a",
  role:"member" as const,operator:"test-operator",operationId:"open-member-a"};
await provisionMember(operatorDatabase,input);
await provisionMember(operatorDatabase,input);
const rows = await operatorDatabase.transaction(async tx => {
  await tx.execute(sql`select set_config('app.tenant_id',${input.tenantId},true)`);
  return tx.select().from(enterpriseMemberships);
});
expect(rows.find(r=>r.principalId==="p-a")?.epoch).toBe(1);
```

该测试文件从现有测试库helper构建独立operatorDatabase并关闭连接；`fixture-user-a` 必须通过现有身份测试fixture在专用库中真实建立，缺少身份不得静默创建假生产用户。

- [ ] **2. 实现开通事务。**

`provisionMember(db,input):Promise<void>`按以下完整算法实现，替代旧的部分字段重放示例：

1. 用strict ProvisionInput Schema验证全部字段，role限定TenantRole；对规范化字段/操作类型生成确定性payload摘要，不忽略tenantName/userId/operator等字段。摘要算法和序列化版本在本文件冻结。
2. 开启READ COMMITTED事务，局部设置app.tenant_id与app.operator_principal_id；按tenant独占→principal共享→membership独占→operation独占取得T2-B定义的键，禁止事务内网络调用。
3. 读取 `(tenant_id,id=operationId)` 安全事件，strict解析details中的payload_digest与结果。操作类型/完整摘要不同返回IDEMPOTENCY_CONFLICT；相同直接返回原结果，不重新授予已经撤销的成员。
4. principal必须预先存在、userId绑定一致且active；该绑定由独立身份CLI创建，租户operator仅有指定主体的SELECT能力。缺主体不得创建假用户、修改全局绑定或调用身份operator。
5. 新建tenant前验证输入；已存在tenant必须name相同且active，否则冲突。建立membership时仅允许首次插入；已存在必须role相同且active，否则冲突，不自动更新/重激活。
6. 同事务追加security_event（id=operationId、操作类型、operator、完整payload摘要、最小结果引用），提交成员和审计。任何Schema/RLS/审计失败整体回滚，不吞错误。以同操作并发、异payload、主体暂停和审计失败测试证明。

重放只返回原结果，不恢复后来暂停的成员；已有tenant名称不匹配、主体暂停、成员角色不匹配均冲突，不能onConflictDoUpdate隐式更改。全局身份CLI另建 `server/scripts/enterprise-identity-provision.ts`，仅读取 `ENTERPRISE_IDENTITY_OPERATOR_DATABASE_URL`，支持create-principal/suspend-principal；principal独占→全局operation独占，同事务写enterprise_identity_events。双向user/principal绑定冲突拒绝，暂停幂等且不恢复。绑定修复不提供普通CLI命令，须另经DBA专项批准、排空/撤销与全局审计。

- [ ] **3. 暂停成员与 ACL 修改采用固定锁顺序并递增版本。**

```ts
await tx.execute(sql`set transaction isolation level read committed`);
await tx.execute(sql`select set_config('app.tenant_id',${tenantId},true)`);
await lockShared(tx,lockKey("tenant",tenantId));
await lockShared(tx,lockKey("principal",principalId));
await lockExclusive(tx,lockKey("membership",tenantId,principalId));
await lockExclusive(tx,lockKey("operation",tenantId,operationId));
// Before mutation, validate any existing event against the complete normalized payload.
await tx.execute(sql`select 1 from enterprise_memberships
 where tenant_id=${tenantId} and principal_id=${principalId} for update`);
await tx.execute(sql`update enterprise_memberships set status='suspended',epoch=epoch+1
 where tenant_id=${tenantId} and principal_id=${principalId} and status='active'`);
await tx.insert(enterpriseSecurityEvents).values({tenantId,id:operationId,operationId,
 actor:operator,kind:"membership.suspended",details:{principalId}});
```

上段为暂停事务的写入骨架：任何查询前设置READ COMMITTED及上下文，锁后读取事件并校验完整payload；重复直接返回旧结果。ACL操作先按T1-C命令表取tenant/principal/membership/resource/operation advisory锁，必要行锁在之后获取，实际grant变化才提升acl_epoch并同事务审计。禁止只锁行而绕过读方advisory协议，也禁止无变化重放重复升epoch。

- [ ] **4. CLI 默认只输出脱敏计划，只有 `--apply --operation-id` 才写入。**

输入 JSON 使用 Zod `.strict()` 校验；环境仅读取 `ENTERPRISE_OPERATOR_DATABASE_URL`，不回退 `DATABASE_URL`。可执行命令模式为 `provision-member`、`suspend-member`、`create-workspace`、`create-resource`、`grant-read`、`revoke-read`，分别调用受控函数；不支持任意SQL或任意表。每个命令必须提供唯一 `--operation-id`，重放按完整 payload 幂等，冲突拒绝。全局 principal 创建/暂停/绑定修复不在此 CLI，必须走独立 `ob_ent_identity_operator` 离线审批路径并写全局身份审计。

```ts
// Dispatch contract; each branch parses its own strict schema before calling the handler.
const handlers = { "provision-member": provisionMember, "suspend-member": suspendMember,
  "create-workspace": createWorkspace, "create-resource": createResource,
  "grant-read": grantRead, "revoke-read": revokeRead };
// Reject unknown commands; dry-run never opens a write transaction.
// --apply dispatches only to the selected typed handler, not always provisionMember.
```

CLI参数解析使用按command区分的strict联合Schema，handler表仅说明分发，不用宽泛any调用；dry-run不执行写事务。输出不包含连接串、会话、凭证、邮箱或全部成员。下列函数和测试属于同一T1-C，不是未定义后续任务：

| 命令/函数 | 受控输入（均含operator/operationId） | 同事务条件与结果 |
|---|---|---|
| create-workspace / createWorkspace | tenantId、workspaceId、name | active tenant，tenant共享锁→operation独占；同ID异内容409，创建及审计原子 |
| create-resource / createResource | tenantId、workspaceId、resourceId、批准kind | tenant共享→resource独占→operation独占；验证同租户workspace，初始revision/aclEpoch为1，创建与审计原子 |
| grant-read / grantRead | tenantId、resourceId、principalId | tenant共享→principal共享→membership共享→resource独占→operation独占；主体/成员/资源active；仅read；实际新增grant才升aclEpoch |
| revoke-read / revokeRead | 同上 | 同样锁顺序，撤销允许处理已暂停成员；删除匹配grant，实际改变才升aclEpoch；不存在grant为可审计幂等结果 |
| suspend-member / suspendMember | tenantId、principalId | tenant共享→principal共享→membership独占→operation独占；状态变化才升epoch |

所有命令在READ COMMITTED事务内设置tenant及需查主体的app.operator_principal_id；锁后读事件并核对完整规范化payload/操作类型，重复仅返回原结果，不重新授予后来撤销的权限。同operationId不同payload即使指向不同资源也必须冲突。事件id=operationId，业务变更＋审计一起提交，失败回滚。ACL写、资源删除/版本更新统一锁同一resource；禁止仅更新grant或绕过锁协议。未列的角色改变、重激活、任意SQL均不提供通用入口。

验收先用身份CLI建立principal，再租户CLI建成员/workspace/resource、grant-read，真实HTTP读取成功；revoke-read后同一cookie读取404。测试权限不足、全局审计/RLS、同操作并发、异payload、跨租户FK、审计失败、撤权后旧grant操作重放不复权。真实生产执行须另行授权。

- [ ] **5. 验证重放、冲突、缺少用户、跨租户引用、暂停后epoch变化、审计失败回滚。**

命令：`bun test server/tests/enterprise/tenancy/provision.test.ts`。T1退出要求所有迁移可重放于干净隔离库、既有表无删除、API角色无法调用operator能力。
## 6. T2：可信 Scope、事务与资源授权

### T2-A：认证身份映射与 Scope

**文件：** `contracts.ts`、`errors.ts`、`tenancy/directory.ts`、`tenancy/scope.ts`；测试 `scope.test.ts`、`directory.test.ts`，均位于本册目录规划的 enterprise 路径。

**消费：** AuthService 验证得到的 userId，不能取 body/header.userId。
**产出：** `resolveScope(directory:Directory,userId:string,selector:string|undefined):Promise<Scope>`；`assertScope(scope:Scope):void`。

- [ ] **1. 写非成员与暂停成员拒绝测试。**

```ts
import { expect, test } from "bun:test";
import type { Directory, Membership } from "../../../src/enterprise/contracts";
import { resolveScope, assertScope } from "../../../src/enterprise/tenancy/scope";
const row: Membership = {tenantId:"a",principalId:"p",tenantName:"A",role:"member",epoch:1,
 tenantStatus:"active",principalStatus:"active",memberStatus:"active"};
test("selector cannot create membership",async()=>{
 const directory: Directory={listForUser:async()=>[row]};
 await expect(resolveScope(directory,"u","b")).rejects.toThrow("TENANT_FORBIDDEN");
});
test("suspended membership is denied",async()=>{
 const directory: Directory={listForUser:async()=>[{...row,memberStatus:"suspended"}]};
 await expect(resolveScope(directory,"u","a")).rejects.toThrow("TENANT_FORBIDDEN");
});
test("a plain object cannot impersonate a verified scope",()=>{
 expect(()=>assertScope({tenantId:"a",principalId:"p",userId:"u",role:"member",epoch:1}))
  .toThrow("UNVERIFIED_SCOPE");
});
```

- [ ] **2. 运行 `bun test server/tests/enterprise/tenancy/scope.test.ts`，确认缺少实现导致 RED。**
- [ ] **3. 实现 Scope，不使用全局当前租户变量。**

```ts
import type { Directory, Scope } from "../contracts";
import { EnterpriseError } from "../errors";
const issued = new WeakSet<object>();
export async function resolveScope(directory: Directory,userId:string,selector:string|undefined):Promise<Scope> {
 if (!userId || userId==="dev-local-user") throw new EnterpriseError("AUTH_REQUIRED",401);
 if (!selector || !/^[A-Za-z0-9_-]{1,128}$/.test(selector)) throw new EnterpriseError("TENANT_REQUIRED",400);
 const rows=await directory.listForUser(userId);
 const member=rows.find(r=>r.tenantId===selector);
 if (!member || member.tenantStatus!=="active" || member.principalStatus!=="active" || member.memberStatus!=="active") {
  throw new EnterpriseError("TENANT_FORBIDDEN",403);
 }
 const scope:Scope=Object.freeze({tenantId:member.tenantId,principalId:member.principalId,
  userId,role:member.role,epoch:member.epoch});
 issued.add(scope);
 return scope;
}
export function assertScope(scope:Scope):void {
 if (!issued.has(scope)) throw new EnterpriseError("UNVERIFIED_SCOPE",403);
}
```

序列化反序列化的 scope不会保留信任。后台Worker必须以服务认证与实际成员/委托重新产生Scope；不导出 `issueScopeUnsafe` 来绕过测试。

- [ ] **4. 实现 Directory，解决“先有权限才能查成员”的循环。**

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { enterpriseMemberships as m,enterprisePrincipals as p,enterpriseTenants as t } from "../../db/schema";
import type { Directory, Membership } from "../contracts";
import { z } from "zod";
const Member=z.object({tenantId:z.string(),principalId:z.string(),tenantName:z.string(),
 role:z.enum(["tenant_admin","member","auditor"]),epoch:z.number().int().positive(),
 tenantStatus:z.enum(["active","suspended"]),principalStatus:z.enum(["active","suspended"]),
 memberStatus:z.enum(["active","suspended"])});
export function createDirectory(db:Database):Directory {
 return {async listForUser(userId:string):Promise<Membership[]> {
  return db.transaction(async tx=>{
   await tx.execute(sql`select set_config('app.user_id',${userId},true)`);
   const rows=await tx.select({tenantId:m.tenantId,principalId:p.id,tenantName:t.name,
    role:m.role,epoch:m.epoch,tenantStatus:t.status,principalStatus:p.status,memberStatus:m.status})
    .from(p).innerJoin(m,eq(m.principalId,p.id)).innerJoin(t,eq(t.id,m.tenantId))
    .where(and(eq(p.userId,userId),eq(p.status,"active")));
   return z.array(Member).parse(rows);
  });
 }};
}
```

此连接仅有目录角色，且 userId 来自认证服务。禁止在同一连接池先 `SET app.user_id` 再用另一个连接查询；只能 `set_config(...,true)` 与查询在同一事务。

- [ ] **5. 用真实目录角色验证同一自然人可列出两个租户，但另一用户看不到该列表。**

```ts
const first=await directory.listForUser("fixture-user-a");
const second=await directory.listForUser("fixture-user-b");
expect(first.map(r=>r.tenantId).sort()).toEqual(["test-a","test-b"]);
expect(second.map(r=>r.tenantId)).toEqual(["test-b"]);
```

fixture通过T1开通，本测试不从客户端输入覆盖directory结果。把 unknown角色、损坏epoch、账号删除等作为失败，而非自动降级成member。

### T2-B：局部事务、连接复用与版本复核

**文件：** `tenancy/transaction.ts`、`authz/repository.ts`；测试 `transaction.test.ts`、`repository.test.ts`。`repository.ts` 仅保留事务内查询辅助函数，不导出中间快照或双阶段读取接口。
**接口：** `withTenant<T>(db:Database,scope:Scope,fn:(tx:Tx)=>Promise<T>):Promise<T>`；`createResourceReader(db:Database,authz:Authz):ResourceReader`。显式READ COMMITTED；索引使用T1-A列出的主键、principal.userId唯一索引和membership反向辅助索引。用实际数据规模及EXPLAIN核对选择性、RLS/关联查询开销，不把小表选择顺序扫描一律误判失败。SQL必须有tenant谓词且满足权限约束，查询计划不是授权证明。

`ResourceReader.readAuthorizedResource(scope,id)` 是唯一公开读路径：在单一 `READ COMMITTED` 短事务内执行 withTenant、resource 共享 advisory 锁、当前成员/ACL/策略核对、本地 Authz 和受限元数据读取；不暴露双阶段读取 API。

- [ ] **1. 写同连接先A后B、事务回滚与伪造Scope测试。测试夹具必须至少包含两个租户、一个真实可读资源和一个真实无 read grant 资源；任何空表、空数组或仅 `.every()` 的结果均先失败。**

```ts
const a=await resolveScope(directory,"fixture-user-a","test-a");
const b=await resolveScope(directory,"fixture-user-a","test-b");
const read=(scope:Scope)=>withTenant(dataDatabase,scope,tx=>
 tx.execute(sql`select tenant_id from enterprise_workspaces`));
const rowsA=await read(a); const rowsB=await read(b);
expect(rowsA.length).toBeGreaterThan(0); expect(rowsB.length).toBeGreaterThan(0);
expect(rowsA.every(r=>r.tenant_id==="test-a")).toBe(true);
expect(rowsB.every(r=>r.tenant_id==="test-b")).toBe(true);
await expect(withTenant(dataDatabase,a,async()=>{throw new Error("rollback-test");})).rejects.toThrow();
expect(await dataDatabase.execute(sql`select id from enterprise_resources`)).toHaveLength(0);
```

测试 `dataDatabase` 建为 `{max:1}` 强制连接复用。另一测试以 `{max:2}` 并行交错执行A/B，实际结果都必须带相应tenant；不能靠顺序调用掩盖全局变量串租户。

- [ ] **2. 使用事务级共享锁协调权限读取，避免给只读角色 UPDATE 权限。**

SELECT FOR SHARE需要额外表权限，因此本册使用事务级 advisory lock 协议：资源读与权限写使用相同键、固定顺序。锁对象顺序为 tenant→principal→membership→resource→operation；同一事务内所有键按此顺序、每一类多键按稳定字典序取得，禁止锁升级或业务域自行拼接键。全局principal创建/暂停只走principal→全局operation锁，不在之后申请tenant锁；租户级操作按 tenant→principal→membership…取得。所有成员、状态、策略、资源、ACL和操作审计写入必须遵守；直接DBA紧急写入需先停止服务/排空事务，不承诺绕过协议仍即时一致。

`transaction.ts` 导出：

```ts
export function lockKey(kind:string,...ids:string[]):string { return JSON.stringify(["enterprise",kind,...ids]); }
export async function lockShared(tx:Tx,key:string):Promise<void> {
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`);
}
export async function lockExclusive(tx:Tx,key:string):Promise<void> {
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
```

字符串hash碰撞只造成额外串行，不造成放行。禁止在等待模型、工具或其他网络操作时持有这些锁；本地授权规则本身不需要网络访问。

- [ ] **3. 实现作用域事务。**

```ts
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import type { Scope, Tx } from "../contracts";
import { EnterpriseError } from "../errors";
import { assertScope } from "./scope";
export async function withTenant<T>(db:Database,scope:Scope,fn:(tx:Tx)=>Promise<T>):Promise<T> {
 assertScope(scope);
 return db.transaction(async tx=>{
   await tx.execute(sql`set transaction isolation level read committed`);
   await tx.execute(sql`select set_config('app.tenant_id',${scope.tenantId},true),
    set_config('app.principal_id',${scope.principalId},true),set_config('app.user_id',${scope.userId},true)`);
  await tx.execute(sql`set local lock_timeout='2s'`);
  await tx.execute(sql`set local statement_timeout='5s'`);
  await lockShared(tx,lockKey("tenant",scope.tenantId));
  await lockShared(tx,lockKey("principal",scope.principalId));
  await lockShared(tx,lockKey("membership",scope.tenantId,scope.principalId));
  const rows=await tx.execute(sql`select m.epoch,m.role from enterprise_memberships m
   join enterprise_principals p on p.id=m.principal_id
   join enterprise_tenants t on t.id=m.tenant_id
   where m.tenant_id=${scope.tenantId} and m.principal_id=${scope.principalId}
    and p.user_id=${scope.userId} and m.status='active' and p.status='active' and t.status='active'`);
  const current=rows[0];
  if (!current || current.epoch!==scope.epoch || current.role!==scope.role) {
   throw new EnterpriseError("SCOPE_REVOKED",403);
  }
  return fn(tx);
 });
}
```

`lockShared/lockExclusive/lockKey` 同文件定义。不把 Tx 保存到全局，也不从回调返回尚未执行的查询或异步流；事务完成前必须消费所有DB结果。

- [ ] **4. 补强T1写入锁。**

读写锁以T1-C命令表为准：暂停成员tenant共享→principal共享→membership独占→operation独占；租户暂停/策略更新tenant独占→operation独占；全局principal操作principal独占→全局operation独占，不再取tenant锁；ACL操作tenant共享→principal共享→membership共享→resource独占→operation独占。所有写入口使用同一lockKey；资源自身更新/删除取tenant共享→resource独占→operation独占。多资源操作先确定全部键并排序，不在取operation锁后再取新资源锁。

```ts
await lockShared(tx,lockKey("tenant",tenantId));
await lockShared(tx,lockKey("principal",principalId));
await lockExclusive(tx,lockKey("membership",tenantId,principalId));
```

生效定义：暂停事务提交后，新取得保护锁的读取必须拒绝；提交前已经完成授权且在锁内读取的响应可能正在网络发送，不承诺收回已发送字节。外部写操作授权由后续工具域再次校验，不能凭本册只读快照执行。

- [ ] **5. 实现单事务授权读取，处理读事务中的撤权。**

`createResourceReader(db,authz)` 的 `readAuthorizedResource` 在单一 `READ COMMITTED` 的 withTenant 事务中取得 resource 共享锁，查询资源和当前 principal 的 grant，执行本地 Authz，并仅返回受限 `ResourceView`；缺资源、已删除或无 grant 返回404。具体查询：

```ts
const rows=await tx.execute(sql`select r.id,r.tenant_id as "tenantId",r.workspace_id as "workspaceId",
 r.kind,r.revision,r.acl_epoch as "aclEpoch",t.policy_revision as "policyRevision",
 (r.status='active') as active,exists(select 1 from enterprise_resource_grants g
  where g.tenant_id=r.tenant_id and g.resource_id=r.id
   and g.principal_id=${scope.principalId} and g.action='read') as "locallyAllowed"
 from enterprise_resources r join enterprise_tenants t on t.id=r.tenant_id
 where r.tenant_id=${scope.tenantId} and r.id=${resourceId}`);
```

使用Zod验证查询结果，与 contracts 精确一致。事务中先复核成员 epoch/状态，再锁 resource；锁内查询必须同时要求 active、locallyAllowed 和当前 policyRevision。不得把客户端输入或旧快照传入授权判断。

```ts
const resource=ResourceSchema.parse(rows[0]);
const allowed=await authz.check({scope,resource,action:"read"});
if (!allowed) throw new EnterpriseError("RESOURCE_NOT_FOUND",404);
return {id:resource.id,workspaceId:resource.workspaceId,kind:resource.kind,revision:resource.revision};
```

查询结果必须在事务内用 Zod 解析，不允许 `as ResourceSnapshot` 跳过 DB 结果检查；`authz.check` 保持 Promise 接口但只运行本地确定性规则，不发网络请求：

```ts
const ResourceSchema=z.object({id:z.string(),tenantId:z.string(),workspaceId:z.string(),kind:z.string(),
 revision:z.number().int().positive(),aclEpoch:z.number().int().positive(),policyRevision:z.string(),
 active:z.boolean(),locallyAllowed:z.boolean()});
```

`readResourceRows(tx:Tx,scope:Scope,id:string)`为repository.ts私有辅助函数，执行上面的固定参数化SQL并返回原始行；resourceId参数取id。查询结果用ResourceSchema在锁内解析；缺行404，Schema损坏映射AUTHORIZATION_STATE_INVALID/503，不暴露原始DB结果。工厂接线如下：

```ts
export function createResourceReader(db:Database,authz:Authz):ResourceReader {
 return {
  readAuthorizedResource:(scope,id)=>withTenant(db,scope,async tx=>{
   await lockShared(tx,lockKey("resource",scope.tenantId,id));
   const rows=await readResourceRows(tx,scope,id);
   const resource=rows[0] ? ResourceSchema.parse(rows[0]) : null;
   if(!resource||!resource.active||!resource.locallyAllowed)throw new EnterpriseError("RESOURCE_NOT_FOUND",404);
   if(!await authz.check({scope,resource,action:"read"}))throw new EnterpriseError("RESOURCE_NOT_FOUND",404);
   return {id:resource.id,workspaceId:resource.workspaceId,kind:resource.kind,revision:resource.revision};
  }),

 };
}
```

ResourceReader 在同一事务内完成成员 epoch、资源共享锁、当前 ACL、策略版本和本地 Authz 检查后才投影 ResourceView；不向路由暴露中间快照，也不允许业务组装双阶段读取。公开基址固定为 `/api/enterprise/v1`；内部 listener 固定为 `/internal/enterprise/v1`，包括 `runtime/validate`、`tool-invocations/prepare`、`tool-invocations/{operation_id}/execute`。本册不把公开 `createEnterpriseApp` 挂到内部或遗留 `/api/agent-tools/call`。

- [ ] **6. 跑授权后撤权的双连接屏障竞态测试。**

使用两个真实连接和可控制屏障（仅测试依赖注入钩子，不由HTTP开放）：读方取得resource共享锁并暂停，启动撤权事务，确认其无法完成锁获取，再释放读方，读事务可返回已授权数据，撤权随后提交；第二路径撤权先持独占锁，读方等待，撤权提交后读方读取新事实并404。设置测试总deadline，不靠固定sleep判断顺序。另测两方异常回滚、成员epoch改变403；策略切到已实现兼容版本按新规则判断，只有未知版本503。先证明非空可读fixture，不能靠空.every()通过。

### T2-C：本地 TypeScript 授权服务

**文件：** 新建 `server/src/enterprise/authz/service.ts`；测试 `server/tests/enterprise/tenancy/authorization.test.ts`，并扩展既有 `repository.test.ts`、`app.test.ts`。

**消费：** T2-A 产生的可信 Scope、T2-B 在同一事务内读取的受限资源事实。
**产出：** `createAuthz():Authz`、`SUPPORTED_POLICY_REVISIONS`；不需要任何外部客户端、Token、URL 或网络请求。

**授权链路：** 验证会话 → 查询成员并签发 Scope → 单一 `READ COMMITTED` withTenant 事务锁定 resource → 查询当前 ACL/成员 epoch/策略版本 → 本地规则检查 → 返回允许的元数据。`locallyAllowed` 必须来自同一事务的数据库查询，禁止把用户 body/state 转成授权事实或拆出双阶段读取。

- [ ] **1. 写显式授权、管理员不绕过及默认拒绝测试。**

```ts
import { expect,test } from "bun:test";
import type { AuthorizationInput, Membership } from "../../../src/enterprise/contracts";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import { createAuthz } from "../../../src/enterprise/authz/service";
async function authorizedInput():Promise<AuthorizationInput> {
 const member:Membership={tenantId:"a",principalId:"p",tenantName:"A",role:"tenant_admin",epoch:1,
  tenantStatus:"active",principalStatus:"active",memberStatus:"active"};
 const scope=await resolveScope({listForUser:async()=>[member]},"u","a");
 return {scope,action:"read",resource:{id:"r",tenantId:"a",workspaceId:"w",kind:"document",
  revision:1,aclEpoch:1,policyRevision:"tenancy-v1",active:true,locallyAllowed:true}};
}
test("explicit ACL permits a valid same-tenant read",async()=>{
 expect(await createAuthz().check(await authorizedInput())).toBe(true);
});
test("tenant admin cannot bypass a missing ACL",async()=>{
 const input=await authorizedInput();input.resource.locallyAllowed=false;
 expect(await createAuthz().check(input)).toBe(false);
});
test("other tenants and deleted resources are denied",async()=>{
 const input=await authorizedInput();
 expect(await createAuthz().check({...input,resource:{...input.resource,tenantId:"b"}})).toBe(false);
 expect(await createAuthz().check({...input,resource:{...input.resource,active:false}})).toBe(false);
});
test("a copied scope is no longer trusted",async()=>{
 const input=await authorizedInput();
 await expect(createAuthz().check({...input,scope:{...input.scope}})).rejects.toThrow("UNVERIFIED_SCOPE");
});
test("unsupported action cannot inherit read permission",async()=>{
 const input=await authorizedInput();
 const malformed={...input,action:"write"} as unknown as AuthorizationInput;
 expect(await createAuthz().check(malformed)).toBe(false);
});
test("unknown policy revision is unavailable, not allowed",async()=>{
 const input=await authorizedInput();input.resource.policyRevision="unrecognized-revision";
 await expect(createAuthz().check(input)).rejects.toThrow("POLICY_REVISION_UNSUPPORTED");
});
```

测试中的 Directory 与资源是本地单元夹具，只证明规则；真实成员撤销、ACL撤销和数据库错误仍由集成测试证明。所有正向夹具必须非空且先证明可读，再验证拒绝；仅负向测试绕过 TypeScript 类型模拟非法动作，生产代码不能用类型断言绕过输入校验。

- [ ] **2. 运行目标测试确认 RED。**

```bash
bun test server/tests/enterprise/tenancy/authorization.test.ts
```

首次应因新实现缺失而失败；依赖或测试环境不可用不能登记为预期行为失败。

- [ ] **3. 实现本地规则，不引入可配置的宽松授权模式。**

```ts
import type { Authz } from "../contracts";
import { EnterpriseError } from "../errors";
import { assertScope } from "../tenancy/scope";
type LocalRule = (input: import("../contracts").AuthorizationInput) => boolean;
const policyRules: ReadonlyMap<string,LocalRule> = new Map<string,LocalRule>([
 ["tenancy-v1", ({scope,resource,action}) => action==="read" &&
   scope.tenantId===resource.tenantId && resource.active===true && resource.locallyAllowed===true],
]);
export const SUPPORTED_POLICY_REVISIONS: readonly string[] = Object.freeze([...policyRules.keys()]);
export function createAuthz():Authz {
 return {async check({scope,resource,action}) {
  assertScope(scope);
  if(action!=="read" || scope.tenantId!==resource.tenantId ||
   resource.active!==true || resource.locallyAllowed!==true) return false;
  if(!Number.isSafeInteger(resource.revision)||resource.revision<1||
   !Number.isSafeInteger(resource.aclEpoch)||resource.aclEpoch<1) {
   throw new EnterpriseError("AUTHORIZATION_STATE_INVALID",503);
  }
   const rule=policyRules.get(resource.policyRevision);
   if(!rule) throw new EnterpriseError("POLICY_REVISION_UNSUPPORTED",503);
   return rule({scope,resource,action});
 }};
}
```

MVP仅支持 `read` 和显式资源ACL，不因 `tenant_admin`、`auditor` 或部署admin角色跳过grant；成员角色只用于明确的管理域规则，不隐式授予内容访问。`Authz`维持Promise接口以保持调用契约，但本地实现不发HTTP、不读环境变量、不维护另一份ACL、不缓存positive决策。

`policyRules` 是随应用发布的确定性规则映射，初始只实现tenancy-v1，SUPPORTED_POLICY_REVISIONS只读派生，不能任意追加标签。将来新规则须有独立函数/测试；先发布同时实现旧新规则的制品并完成全部副本兼容检查，再在tenant独占锁内切换policy_revision，排空旧副本后退役旧规则。回退须先保证数据库期望版本被回退制品支持；不能退回过时授权语义或未知版本自动放行。滚动混合版本和停机应急回退均需测试，不新增策略包服务。

- [ ] **4. 验证非法布尔值与授权版本，不使用JavaScript真值放行。**

追加到同一个 `authorization.test.ts`，复用上文实际定义的 `authorizedInput`：

```ts
test("truthy strings cannot grant access",async()=>{
 const input=await authorizedInput();
 const malformed={...input,resource:{...input.resource,locallyAllowed:"true"}} as unknown as AuthorizationInput;
 expect(await createAuthz().check(malformed)).toBe(false);
});
test("invalid ACL epoch is not a successful decision",async()=>{
 const input=await authorizedInput();input.resource.aclEpoch=0;
 await expect(createAuthz().check(input)).rejects.toThrow("AUTHORIZATION_STATE_INVALID");
});
```

本地授权异常与数据库异常都不得捕获后返回true。已拒绝资源仍统一404；不能确认授权状态时503。未知策略只影响相关资源请求，不伪装为数据库或外部服务故障。

- [ ] **5. 在真实数据库链路验证撤权，不删除 T2-B 的最终复核。**

使用 T2-B 的真实非空 Scope/资源夹具：在两个连接屏障下分别验证读先锁定、撤权等待，以及撤权先提交后 `readAuthorizedResource` 返回404；成员 epoch 变更返回403，未知 policy revision 返回503。数据库不可用时 HTTP 请求503且不返回资源；不能以事务外旧的本地允许结果直接返回数据。

- [ ] **6. 复跑单元与集成测试，保留审计要求。**

```bash
bun test server/tests/enterprise/tenancy/authorization.test.ts
bun test server/tests/enterprise/tenancy/repository.test.ts
bun test server/tests/enterprise/tenancy/app.test.ts
```

角色、成员、ACL变更仍按T1-C与T2-B事务写入security_events和epoch；授权实现变简单不改变这项验收。相关敏感动作的操作审计由对应后续领域实现，本册不增加一次查询必写多份重复账本。

- [ ] **7. 交接本地唯一实现，不创建外部适配器占位文件。**

T3直接调用 `createAuthz()`。启动配置、readiness、测试环境和CI中不再要求任何授权服务地址、凭证、模型ID或策略引擎进程。本地数据库与身份链路仍是必要依赖；没有外部权限组件不等于允许跳过真实隔离测试。

### T2-D：跨域隔离合同交接

**文件：** `shared/enterprise/contracts.ts`、本册末尾验收表；测试 `scope-keys.test.ts`。

- [ ] 定义纯函数 `scopedKey`，放在共享包时使用纯JSON编码，不依赖Node Buffer，供Web/App共同复用：

```ts
export function scopedKey(tenantId:string,kind:string,id:string):string {
 return JSON.stringify([tenantId,kind,id]);
}
```

需要对象路径或缓存键的服务端适配器再对整体编码base64url，不能对不同段采用不同拼接规则。

- [ ] 写键碰撞失败测试，再实现上述函数并运行 `bun test server/tests/enterprise/tenancy/scope-keys.test.ts`：

```ts
import { expect,test } from "bun:test";
import { scopedKey } from "../../../../shared/enterprise/contracts";
test("tenant keys cannot collide through separators",()=>{
 expect(scopedKey("a:b","c","d")).not.toBe(scopedKey("a","b:c","d"));
 expect(scopedKey("a","document","r")).not.toBe(scopedKey("b","document","r"));
});
```
- [ ] 把以下接口边界交给后续分册：对象路径是定位不是授权；检索候选在进入重排/模型前必须完成ACL；Run事件每次订阅及续流复核Scope；后台任务不可序列化Scope冒充已验证。

本册只交付合同和键测试。对象签名下载、检索过滤、运行取消与凭证撤销的实际效果必须由03–06测试，不能在02标为通过。
## 7. T3：独立企业 API 与实际启动

### T3-A：会话、租户选择与资源查询的路由接线

**文件：** `server/src/enterprise/app.ts`、`tenancy/routes.ts`；测试 `server/tests/enterprise/tenancy/app.test.ts`。
**消费：** AuthService、Directory、ResourceReader、Authz；不消费部署级 RoleRepository。
**产出：** `createEnterpriseApp(deps:EnterpriseDependencies):Hono`。

```ts
import type { AuthService } from "../auth/guards";
import type { Authz, Directory, ResourceReader } from "./contracts";
export type EnterpriseDependencies = {
 auth:AuthService; directory:Directory; resources:ResourceReader; authz:Authz;
  allowedOrigins:ReadonlySet<string>;
  logRedactedSecurityError:(event:{requestId:string;status:number;code:string})=>void;
  authRoutes:ReadonlySet<string>;
  isDraining:()=>boolean;
  ready:()=>Promise<boolean>;
};
```

`authRoutes` 的元素是精确的 `METHOD pathname`，由运维配置已验证的登录/回调端点，不是请求传入。禁止 `*`、前缀匹配或直接公开全部 Better Auth插件端点；SCIM、SSO注册、组织管理及桌面账户连接不能默认暴露在共享企业入口。

- [ ] **1. 写未登录与遗留入口不可达测试。**

```ts
import { expect,test } from "bun:test";
import { createEnterpriseApp } from "../../../src/enterprise/app";
const auth={handler:async()=>new Response(null,{status:204}),api:{getSession:async()=>null}};
const app=createEnterpriseApp({auth,directory:{listForUser:async()=>[]},
 resources:{readAuthorizedResource:async()=>{throw new Error("not reached");}},
 authz:{check:async()=>false},allowedOrigins:new Set(),authRoutes:new Set(),
 logRedactedSecurityError:()=>{},isDraining:()=>false,ready:async()=>true});
test("no session cannot select a tenant",async()=>{
 expect((await app.request("/api/enterprise/v1/tenants")).status).toBe(401);
});
test("legacy and unapproved auth routes are not mounted",async()=>{
 for(const path of ["/api/agents","/api/agent-tools/call","/api/admin/status","/api/auth/scim/v2/Users"]){
  expect((await app.request(path)).status).toBe(404);
 }
});
```

- [ ] **2. 运行目标测试得到RED。**

```bash
bun test server/tests/enterprise/tenancy/app.test.ts
```

- [ ] **3. 创建只用于企业域的用户中间件与根路由。**

```ts
import { Hono } from "hono";
import { EnterpriseError } from "./errors";
import { resolveScope } from "./tenancy/scope";
import { mountTenantRoutes } from "./tenancy/routes";
import type { Scope } from "./contracts";
export type EnterpriseVariables={userId:string;scope:Scope};
export function createEnterpriseApp(deps:EnterpriseDependencies) {
 const app=new Hono<{Variables:EnterpriseVariables}>();
  app.onError((error,c)=>{
   const requestId=crypto.randomUUID();
   c.header("x-request-id",requestId);
   const known=error instanceof EnterpriseError;
   const status=known?error.status:500;
   const code=known?error.code:"INTERNAL_ERROR";
   deps.logRedactedSecurityError({requestId,status,code});
   return c.json({error:{code,request_id:requestId,retryable:false,
    summary:status>=500?"服务暂不可用":"请求未获允许"}},status);
  });
  app.use("*",async(c,next)=>{
   c.header("Cache-Control","no-store");c.header("X-Content-Type-Options","nosniff");
   if(deps.isDraining() && !c.req.path.startsWith("/health/")) {
    throw new EnterpriseError("SERVICE_DRAINING",503);
   }
   await next();
  });
 app.get("/health/live",c=>c.json({status:"live"}));
 app.get("/health/ready",async c=>{
  const ready=await deps.ready();return c.json({status:ready?"ready":"unavailable"},ready?200:503);
 });
 app.all("/api/auth/*",async c=>{
  const key=`${c.req.method} ${c.req.path}`;
  if(!deps.authRoutes.has(key)) return c.notFound();
  return deps.auth.handler(c.req.raw);
 });
 const api=new Hono<{Variables:EnterpriseVariables}>();
 api.use("*",async(c,next)=>{
  if(!["GET","HEAD","OPTIONS"].includes(c.req.method)){
   const origin=c.req.header("origin");
   if(!origin||!deps.allowedOrigins.has(origin)) throw new EnterpriseError("ORIGIN_DENIED",403);
   if(!c.req.header("content-type")?.startsWith("application/json")) throw new EnterpriseError("JSON_REQUIRED",400);
  }
  const session=await deps.auth.api.getSession({headers:c.req.raw.headers,query:{disableCookieCache:true}});
  if(!session?.user.id||session.user.id==="dev-local-user") throw new EnterpriseError("AUTH_REQUIRED",401);
  c.set("userId",session.user.id);
  await next();
 });
 api.get("/tenants",async c=>{
  const rows=await deps.directory.listForUser(c.var.userId);
  return c.json({items:rows.filter(r=>r.tenantStatus==="active"&&r.principalStatus==="active"&&r.memberStatus==="active")
   .map(r=>({id:r.tenantId,name:r.tenantName,role:r.role}))});
 });
 api.use("*",async(c,next)=>{
  c.set("scope",await resolveScope(deps.directory,c.var.userId,c.req.header("x-openbot-tenant")));
  await next();
 });
 mountTenantRoutes(api,deps);
 app.route("/api/enterprise/v1",api);
 return app;
}
```

文件中同时定义或导入上文 EnterpriseDependencies；`/tenants` 在Scope中间件前注册，解决首次选择租户问题。对认证端点的CSRF依赖现有认证实现，不能把企业JSON要求覆盖OIDC/SAML回调；认证allowlist须在真实登录测试中验证，未列出的端点默认404。

MVP采用同源Web，不增加泛域CORS。App/服务账号后续使用不同认证路由，不通过“允许缺失Origin”绕过Web写请求检查。

- [ ] **4. 实现资源端点，不返回未授权快照。**

```ts
import type { Hono } from "hono";
import type { EnterpriseDependencies,EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";
export function mountTenantRoutes(app:Hono<{Variables:EnterpriseVariables}>,deps:EnterpriseDependencies):void {
 app.get("/scope",c=>c.json({tenantId:c.var.scope.tenantId,
  principalId:c.var.scope.principalId,role:c.var.scope.role}));
 app.get("/resources/:id",async c=>{
  const scope=c.var.scope;
  const id=c.req.param("id");
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new EnterpriseError("RESOURCE_NOT_FOUND",404);
  const view=await deps.resources.readAuthorizedResource(scope,id);
  return c.json(view);
 });
}
```

MVP不公开未经授权的资源计数或全量列表。`/scope`仅是刚完成验证的成员视图，不能被客户端缓存后当作后续操作凭证。资源详情只返回元数据；文档正文在05中独立鉴权。

- [ ] **5. 写“部署admin也不得跨租户”的HTTP测试。**

```ts
const adminAuth={handler:async()=>new Response(null,{status:204}),api:{getSession:async()=>({user:{id:"u",email:"test-only",role:"admin" as const}})}};
const member={tenantId:"a",principalId:"p",tenantName:"A",role:"member" as const,epoch:1,
 tenantStatus:"active" as const,principalStatus:"active" as const,memberStatus:"active" as const};
const protectedApp=createEnterpriseApp({auth:adminAuth,directory:{listForUser:async()=>[member]},
 resources:{readAuthorizedResource:async()=>{throw new Error("not reached");}},
 authz:{check:async()=>false},allowedOrigins:new Set(),authRoutes:new Set(),
 logRedactedSecurityError:()=>{},isDraining:()=>false,ready:async()=>true});
expect((await protectedApp.request("/api/enterprise/v1/scope",{headers:{"x-openbot-tenant":"b"}})).status).toBe(403);
expect((await protectedApp.request("/api/enterprise/v1/scope",{headers:{"x-openbot-tenant":"a"}})).status).toBe(200);
```

- [ ] **6. 复跑路由测试，再通过真实DB验证已登录用户撤权后的下次请求返回403。**

测试保持同一已登录session，不通过登出制造假象；scope由每次成员查询重建。断开测试业务库连接导致资源请求503、live仍200、ready应503；不因数据依赖故障重新启动全部服务。另测租户策略版本不受支持时资源请求503，其他可用租户不受影响。

### T3-B：拆出认证配置，保持旧路径兼容

**文件：** 修改 `server/src/config.ts`、`server/src/auth/index.ts`；新增 `server/src/enterprise/config.ts`；测试 `config.test.ts`、`auth-config-compat.test.ts`。

**接口：** `loadIdentityConfig(environment:Record<string,string|undefined>):AuthConfig|undefined`；`AuthBootstrapConfig=Pick<DeploymentConfig,"auth"|"keyEncryptionKey">`。

- [ ] **1. 写独立身份配置不要求Intelligence的测试。**

测试使用已有 `server/tests/support/environment.ts` 中的测试配置，不打印或保存真实环境：构造仅含已验证身份提供方测试字段的对象，`loadIdentityConfig`能返回AuthConfig；缺少secret时抛已有配置错误。旧 `loadConfig` 必须仍维持原有运行时配置校验，不放宽它。

- [ ] **2. 在 config.ts 新增薄包装，复用现有解析函数。**

```ts
export function loadIdentityConfig(environment:Environment):AuthConfig|undefined {
 return authConfig(environment,oauthClient(environment,"GOOGLE"));
}
```

- [ ] **3. 在 auth/index.ts 缩小参数类型，不改认证逻辑。**

```ts
export type AuthBootstrapConfig=Pick<DeploymentConfig,"auth"|"keyEncryptionKey">;
```

把createAuth配置参数缩为AuthBootstrapConfig，原调用方结构兼容；逐字段编译检查，禁止as DeploymentConfig掩盖缺依赖。类型收窄不会消除工厂内数据库/SSO依赖，必须实施以下身份连接权限合同：

| 现有依赖 | 企业身份连接所需边界 | 真实测试 |
|---|---|---|
| users / accounts / sessions及已启用认证机制的验证记录 | 按实际认证适配器操作给最小读写列/表；OAuth令牌保持现有加密 | 首登、二次登录、刷新/登出/失效，禁止输出令牌 |
| user_roles | 现有首登hook所需最小读取/插入；部署角色不转成租户权限 | 首登角色写入可用，admin跨租户仍拒绝 |
| enterprise_settings与SSO配置读取 | 列出实际键/行访问；优先只读投影/窄接口，不授予任意旧业务表 | 登录/回调及设置读取在受限角色下可用 |
| revoked_access | 认证连接只读；新登录与旧session验证都查撤销 | 保持同cookie撤销后拒绝 |
| SCIM、SSO注册、组织/桌面管理插件 | 共享入口禁用相应路由和初始化副作用；若工厂需要写权限则拆出窄认证bootstrap，不能扩大DB角色 | 危险路由配置失败，禁用插件不影响批准身份配置 |

实现前从当前工厂及选定插件枚举实际表/列，产出grant清单并在真实受限角色下验收；只写“身份表访问”不够。需要拆依赖时保持旧createAuth调用方回归兼容；新helper在本任务定义，不隐含授权改整个认证系统。

- [ ] **4. 定义独立配置，无默认开发身份，不要求外部授权服务配置。**

配置实现采用以下可测试合同，不在未核对认证SDK路由前硬编码一组猜测的登录/回调路径：

```ts
export type RedactedSecurityError = { requestId:string; status:number; code:string };
export function assertNoDevelopmentIdentity(env:Record<string,string|undefined>):void {
 for (const key of ["OPENBOT_SINGLE_USER","OPENBOT_DEV_NO_AUTH"]) {
  const value=env[key]?.trim().toLowerCase();
  if(value && value!=="0" && value!=="false") throw new Error(`${key} forbidden in enterprise entry`);
 }
}
export function selectAuthRoutes(selected:unknown, compiled:ReadonlySet<string>):ReadonlySet<string> {
 if(!Array.isArray(selected) || selected.length===0 ||
    selected.some(v=>typeof v!=="string" || !compiled.has(v))) {
  throw new Error("INVALID_AUTH_ROUTE_SELECTION");
 }
 return new Set(selected as string[]);
}
```

`loadEnterpriseConfig(env)`必须返回port/hostname、auth、keyEncryptionKey、三个独立DB URL、allowedOrigins、authRoutes、shutdownGraceMs。依次执行：

1. 调用assertNoDevelopmentIdentity；复用loadIdentityConfig与既有密钥格式校验；认证缺失停止启动。显式验证端口/停机窗口为有界正整数，DB配置一次读取完再打开连接。
2. 在新 `auth-route-profile.ts` 中为批准的身份配置提供编译期路由集合（精确method＋canonical pathname＋请求类别），由锁定SDK及真实OIDC/SAML登录/回调/会话/登出测试生成审查依据；配置只能选择其子集且必须含该配置的必需路由。不得从env扩展编译期集合。
3. 编译期集合必须排除SCIM、SSO注册、组织管理、桌面账户连接、通配路径；危险配置测试失败关闭。匹配前统一路径规范化，拒绝含编码分隔符、重复斜杠、点段或非规范路径，不把请求参数当认证配置。
4. allowedOrigins来自已校验的精确origin集合，不接受泛域CORS。认证callback单独使用原认证实现的state/nonce/CSRF验证，不套用企业JSON写请求要求。
5. 验证受控身份场景真实可登录；不通过则限制试点，不临时公开整个 `/api/auth/*` 来跑通。配置不承担日志DI；`logRedactedSecurityError`由bootstrap组装，明确类型，不通过隐式any或请求正文输出秘密。

补充配置校验：三个DB必须指向同一批准的数据库、登录角色不同且符合角色合同；URL不能出现在日志；keyEncryptionKey复用现有格式验证，不能把非空当作合格密钥。实际实现将config.ts现有 `keyEncryptionKey` 函数作为有名导出复用，不复制另一套密钥算法。本地策略版本在 `authz/service.ts` 中随代码冻结，不从请求或环境变量选择授权实现；旧外部授权配置即使残留，也不应被读取或触发网络访问。

本册禁止公开SCIM和SSO注册；authRoutes只允许已核对的登录、回调、会话与登出路径。外部tenant的IdP自动入驻、按目录局部撤权与账号跨提供方合并需另做专项验收，MVP采用受控平台身份源＋人工租户成员授权。

- [ ] **5. 运行身份配置与旧认证回归，确认未去掉旧路径的检查。**

```bash
bun test server/tests/enterprise/tenancy/config.test.ts
bun test server/tests/enterprise/tenancy/auth-config-compat.test.ts
bun test server/tests/guards.test.ts
bun run --cwd server typecheck
```

### T3-C：bootstrap、ready与进程生命周期

**文件：** `bootstrap.ts`、`index.ts`；测试 `bootstrap.test.ts`；新增 `server/tsconfig.enterprise-tests.json`。

**产出：** `bootstrapEnterprise(config:EnterpriseConfig):Promise<{app:ReturnType<typeof createEnterpriseApp>;beginDrain:()=>void;close:()=>Promise<void>}>`；index只调用这些生命周期方法，不共享隐式全局状态。

- [ ] **1. 写启动失败也关闭已建立连接的测试。**

在bootstrap定义 `DatabaseFactory=(url:string)=>Database` 的可注入参数，测试第三次连接抛异常，断言前两个假客户端各关闭一次；不把连接失败吞掉后继续监听端口。

- [ ] **2. 组装真实依赖，配置先读取、连接后建立。**

```ts
const config=loadEnterpriseConfig(process.env);
const {app,beginDrain,close}=await bootstrapEnterprise(config);
const server=Bun.serve({hostname:config.hostname,port:config.port,fetch:app.fetch});
let closing=false;
async function shutdown():Promise<void> {
 if(closing)return;
 closing=true;
 beginDrain();
 const timer=setTimeout(()=>{void server.stop(true);},config.shutdownGraceMs);
 try { await server.stop(false); }
 finally { clearTimeout(timer); await close(); }
}
function requestShutdown():void {
 void shutdown().catch(()=>{
  console.error("ENTERPRISE_SHUTDOWN_FAILED");
  process.exitCode=1;
 });
}
process.once("SIGTERM",requestShutdown);
process.once("SIGINT",requestShutdown);
```

`beginDrain():void`由bootstrap闭包拥有，同步置draining=true，使ready立即false、拒绝新的业务请求；不能由index访问未定义的readyState。stop(false)先停止接纳并排空；只有shutdownGraceMs到期才stop(true)，未排空/关闭失败记录脱敏错误并非零退出。数据库连接关闭也需受部署终止期限约束；强停会留下未知结果，不能声明提交已撤销。D4的terminationGracePeriod必须大于应用排空/清理预算；测试长请求、重复信号、超时及close异常。

`bootstrap.ts` 必须按下列依赖组装，不加载Go/Intelligence模块：

```ts
const authDb=createDatabase(config.authDatabaseUrl,{max:2});
const directoryDb=createDatabase(config.directoryDatabaseUrl,{max:2});
const dataDb=createDatabase(config.dataDatabaseUrl,{max:4});
const isRevoked=async(email:string)=>{
 const rows=await authDb.select({email:revokedAccess.email}).from(revokedAccess)
  .where(eq(revokedAccess.email,email.trim().toLowerCase())).limit(1);
 return rows.length>0;
};
const baseAuth=createAuth({auth:config.auth,keyEncryptionKey:config.keyEncryptionKey},authDb,isRevoked);
const auth:AuthService={handler:req=>baseAuth.handler(req),api:{getSession:async options=>{
 const session=await baseAuth.api.getSession(options);
 if(!session||await isRevoked(session.user.email))return null;
 return session;
}}};
 const directory=createDirectory(directoryDb);
 const authz=createAuthz();
 const resources=createResourceReader(dataDb,authz);
const close=async():Promise<void>=>{
 const results=await Promise.allSettled([authDb.$client.close(),directoryDb.$client.close(),dataDb.$client.close()]);
 if(results.some(r=>r.status==="rejected"))throw new Error("ENTERPRISE_DATABASE_CLOSE_FAILED");
};
```

上述连接数是本册验证默认值，生产以压测为准。文件导入 `eq`、既有 `revokedAccess`、`AuthService`。新登录与每次验证旧session都检查既有部署拒绝列表，不能只在登录时检查；租户成员暂停仍由Scope检查，不通过全局邮箱拒绝列表撤销另一个租户成员。实际实现使用try/catch维护已打开连接数组，即使第二/第三次创建失败也执行close。本地Authz不持有数据库连接或网络客户端；Directory和dataDb不读取账号Token。

- [ ] **3. 开启监听前验证数据库角色属性与Schema，不仅执行SELECT 1。**

```sql
SELECT current_user,r.rolsuper,r.rolbypassrls
FROM pg_roles r WHERE r.rolname=current_user;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
 pg_has_role(current_user,c.relowner,'MEMBER') AS can_assume_owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('enterprise_principals','enterprise_memberships','enterprise_tenants',
   'enterprise_workspaces','enterprise_resources','enterprise_resource_grants');
```

缺表、RLS关闭、FORCE关闭、可成为 owner、API拥有 operator/identity-operator 角色均阻止启动。身份DB只验证不拥有企业数据/角色权限，不要求身份表已有RLS。连接角色设置对照T1合同逐项测试；仅 NOSUPERUSER 不足以证明不能 SET ROLE 到 owner。

- [ ] **4. 就绪检查仅检查实际依赖，不调用外部权限服务。**

启动时完成本地授权模块构造、数据库角色和Schema校验；readiness只探测身份、目录和业务数据库的连接与必要表访问，不读取客户正文。它不证明所有租户策略版本都受支持；某租户策略版本不兼容由该资源请求503与可观测记录处理，不能为了健康检查跨租户枚举全部数据。

实现为bootstrap内部闭包，导入既有 `sql`；数据库探针使用 `LIMIT 0` 验证表可访问而不返回行。缓存的是健康状态，不是授权决策：

```ts
let draining=false;
const beginDrain=()=>{draining=true;};
const logRedactedSecurityError=(event:{requestId:string;status:number;code:string}):void=>{
 console.error(JSON.stringify({request_id:event.requestId,status:event.status,code:event.code}));
};
let checkedAt=0;
let lastReady=false;
async function checkDependencies():Promise<boolean> {
 if(draining)return false;
 if(Date.now()-checkedAt<1000)return lastReady;
 try {
  await Promise.all([
   authDb.transaction(async tx=>{
    await tx.execute(sql`set local statement_timeout='1s'`);
    await tx.execute(sql`select id from users limit 0`);
   }),
   directoryDb.transaction(async tx=>{
    await tx.execute(sql`set local statement_timeout='1s'`);
    await tx.execute(sql`select tenant_id from enterprise_memberships limit 0`);
   }),
   dataDb.transaction(async tx=>{
    await tx.execute(sql`set local statement_timeout='1s'`);
    await tx.execute(sql`select id from enterprise_resources limit 0`);
   }),
  ]);
  lastReady=true;
 } catch {lastReady=false;}
 checkedAt=Date.now();return lastReady;
}
const app=createEnterpriseApp({auth,directory,resources,authz,
  allowedOrigins:config.allowedOrigins,authRoutes:config.authRoutes,
  logRedactedSecurityError,ready:checkDependencies,isDraining:()=>draining});
return {app,beginDrain,close};
```

这段位于 `bootstrapEnterprise` 内部；依赖构造和启动角色校验必须在返回之前成功，角色校验失败先close再抛。数据库临时故障保持live但ready=false；故障时业务请求照常失败关闭，不依赖健康缓存来判断权限。当前不新增探针worker；数据库连接获取超时也必须在执行环境验证，不能以SQL超时代替连接超时。

- [ ] **5. 增加独立启动和测试类型检查命令。**

server/package.json仅追加：

```json
{
 "dev:enterprise":"bun --no-env-file --watch src/enterprise/index.ts",
 "start:enterprise":"bun --no-env-file src/enterprise/index.ts",
 "typecheck:enterprise":"tsc --noEmit -p tsconfig.enterprise-tests.json"
}
```

`server/tsconfig.enterprise-tests.json`：

```json
{
 "extends":"../tsconfig.base.json",
 "compilerOptions":{"types":["bun"]},
  "include":["src/enterprise/**/*.ts","tests/enterprise/**/*.ts", "scripts/enterprise-*.ts", "../shared/enterprise/**/*.ts"]
}
```

测试直接导入的既有文件由编译器追踪，不把全部旧测试的历史类型错误纳入本次重构。新增脚本中的顶层await必须具备import或export，不能形成全局脚本污染。

- [ ] **6. 在清除所有Intelligence与模型配置的隔离进程中启动，完成真实HTTP验收。**

```bash
bun run --cwd server typecheck:enterprise
bun test server/tests/enterprise/tenancy/bootstrap.test.ts
bun run --cwd server start:enterprise
```

启动前配置由安全环境注入，不把密钥写进命令行或计划。最后一条是待执行的长驻服务，执行时以前台日志/后台进程管理工具控制；不要在计划编写阶段启动。

## 8. 迁移、发布与回退

### 8.1 执行顺序

1. DBA在隔离实例建立能力角色与对应登录用户；验证数据库实例归属；全局身份操作另用 `ob_ent_identity_operator` 离线审批并审计。
2. 在空测试库生成并应用普通 Schema 迁移，再应用唯一 RLS custom migration；检查旧表无 drop、索引和查询计划符合验收。
3. 建立批准的测试身份、租户、成员、workspace、resource 和正向/负向 ACL 夹具，测试角色不接触生产数据。
4. 固定 `enterprise-mvp-v0.2`、本地规则版本集合和应用镜像摘要，跑允许/拒绝、版本兼容/未知拒绝与双连接撤权测试；不部署外部授权组件。
5. 部署独立 Enterprise API；公开入口只路由 `/api/enterprise/v1` 与批准的认证白名单；内部入口独立 listener `/internal/enterprise/v1`，仅供 `runtime/validate`、`tool-invocations/prepare`、`tool-invocations/{operation_id}/execute`，本册不实现其业务逻辑。
6. 用同一 cookie 验证授权与撤权；旧 `/api/*`、公开 `createEnterpriseApp` 不得挂内部路径或遗留 `/api/agent-tools/call`；网络矩阵由 03/04/06 完成。
7. 按 M §6 的 G0-R/G0-T/G1a/G1b/G2 门禁执行；本册只提供租户前置证据，不能替 03–06 声称完备或授予生产准入。

### 8.2 历史数据

MVP不自动回填旧表或把旧用户加入所有租户。映射必须列资源tenant、来源、审批人与冲突处理，不明归属隔离待确认，不填公共租户。当前不支持跨租户共享；未来专项批准后仍须显式授权，不根据相同botId/邮箱推导。

### 8.3 回退

关闭新增企业入口并暂停新任务，先 ready=false 再排空，保留新增表与审计；应用回退不执行 DROP、不移除 RLS、不将权限角色改成超级用户。回退旧单租户应用必须恢复原先明确部署边界，不能把多租户流量直接转发给旧接口。恢复必须以总体方案 §18.3 的独立安全水位为准：密钥与身份→数据库/对象→撤权/删除事实重放→索引/工作流对账→开放业务；旧备份本身不能推断新撤权。未达到可信水位时关闭内容读取、检索和工具调用，不猜测放行。

## 9. 集成测试、验收矩阵与责任

| 验收ID | 场景 | 预期 | 证据文件/任务 |
|---|---|---|---|
| TEN-01 | 无会话访问企业接口 | 401，未查询业务资源 | app.test.ts / T3-A |
| TEN-02 | 有会话但未选租户 | 租户目录可见自身；scope400 | scope.test.ts / T2-A |
| TEN-03 | 伪造tenant选择器 | 403，不改变Scope | scope.test.ts |
| TEN-04 | 全局admin访问非成员租户 | 403，不继承管理权限 | app.test.ts |
| TEN-05 | 单一连接A/B切换与回滚 | 无串租户；事务后无上下文 | transaction.test.ts |
| TEN-06 | 业务角色原始SELECT无context | 无行；不是连接错误 | rls.test.ts |
| TEN-07 | 跨租户外键、UPDATE、TRUNCATE | 分别得到 FK、RLS、表权限拒绝；非空夹具 | rls.test.ts |
| TEN-08 | 目录请求查询其他用户 | RLS只返回当前认证user映射 | directory.test.ts |
| TEN-09 | 成员暂停但cookie仍有效 | 下一次读取403 | provision/app集成 |
| TEN-10 | 读/撤权双连接屏障竞争 | 共享锁与独占锁有序；撤权先提交则404，无内容 | repository.test.ts / T2-B |
| TEN-20 | 受控资源/ACL CLI 闭环 | create workspace/resource、grant/revoke read 均有 operationId、epoch、审计和严格输入 | provision.test.ts / T1-C |
| TEN-11 | 成员epoch/策略版本改变 | 旧Scope403；未知策略503；受支持新策略按对应规则判断 | repository.test.ts / T2-B |
| TEN-21 | 全局身份与租户 operator 分离 | tenant operator 无 principal 写权限；identity operator 离线且全局身份审计 | rls/provision.test.ts / T1-B/T1-C |
| TEN-12 | 不支持的动作/非法布尔值；未知策略/损坏版本 | 动作和布尔值拒绝；无法确认状态时503 | authorization.test.ts / app.test.ts |
| TEN-13 | 相同ID出现在不同租户 | 资源定位键、缓存键不同 | scope-keys.test.ts |
| TEN-14 | 未批准auth/旧管理/旧工具端点 | Enterprise入口404 | app.test.ts |
| TEN-15 | 未配置Intelligence/Go/模型或外部授权服务 | Enterprise以本地Authz独立启动 | config.test.ts / bootstrap.test.ts |
| TEN-16 | API可SET ROLE到owner或operator | 启动失败 | bootstrap/rls测试 |
| TEN-17 | 开通重试与payload冲突 | 同内容幂等，异内容冲突 | provision.test.ts |
| TEN-18 | 同邮箱不同身份来源、目录撤销 | 不自动加租户、不继承他人成员 | 身份专项门禁 |
| TEN-19 | 身份/目录/业务数据库中断 | 受影响请求503，ready503，live保持200，不返回缓存的允许结果 | bootstrap.test.ts / app.test.ts |
| TEN-22 | 安全错误可定位 | 500/503 分类稳定，含 request_id，日志仅脱敏接口字段 | app.test.ts / T3-A |
| TEN-23 | 恢复安全水位 | 未达到 §18.3 水位时内容/检索/工具保持隔离 | recovery drill / G2 |

TEN-18若因现有身份链接行为无法证明安全，限制MVP为受控统一身份源，禁止开放多企业IdP自动注册；该限制必须写进试点交付范围，不能以租户RLS掩盖身份混淆风险。

后端负责人确认接口和Schema；安全负责人确认威胁与角色；QA记录真实测试输出；SRE确认网络和角色部署。本文不触发独立验证Agent，也没有任何“已通过”的测试结论。03–06 当前待编写；本册只记录可交接的租户前置合同，不把用户文档授权当作代码执行授权。

### 9.1 检查命令

```bash
bun test server/tests/enterprise/tenancy
bun run --cwd server typecheck:enterprise
bun run --cwd server typecheck
bun run format:check
bun run lint
bun run test:ci
```

根 `test:ci` 仅保留项目脚本定义的最低数量门槛，不把新增 case 转成脆弱的精确总数；CI 必须显式调用 `typecheck:enterprise`，并覆盖 enterprise 全部测试及现有 runtime tests。任何数量变化只记录实际执行证据。格式检查失败时只修本次触碰文件；不运行全仓库自动格式化覆盖用户的前端变更。

### 9.2 证据字段

每项记录 `case_id、git_commit、fixture_revision、database_role、policy_revision、authz_implementation、command、exit_code、result、limitations`；本册 `authz_implementation` 固定为 `local-ts`。result只有实际执行后才填写pass/fail；计划阶段留在清单未勾选状态，不创建伪PASS报告。

不保存session cookie、数据库URL、任何服务Token或客户正文。资源ID和路径中的敏感信息按审计规则脱敏。

## 10. 后续分册交接

| 接收方 | 可直接依赖的接口 | 仍必须自己完成 |
|---|---|---|
| 01 Go验证 | Directory、resolveScope、可信principal/tenant映射 | 运行断言升级、服务身份、Go上下文验证；本册不延长旧断言有效期 |
| 03 Run/模型 | Scope、withTenant、ResourceReader、公开/内部路由边界 | 运行账本、审批恢复、预算、短期能力、服务/委托身份；当前分册待编写 |
| 04 插件/沙箱 | 租户键、资源 read 前置、内部 `tool-invocations` 路由占位 | 确定性 TS ActionPolicy、危险参数审批、operationId/回执、非可信代码隔离；当前分册待编写 |
| 05 知识/专家 | 资源 ID/ACL epoch 与单事务授权读取 | Chunk ACL、索引删除、引用下载、专家发布权限；当前分册待编写 |
| 06 交付 | createEnterpriseApp、独立启动、ready/角色门禁 | 真正 Ingress 隔离、SLO、备份恢复、移动端与服务账号认证；当前分册待编写 |

Scope不能写进队列后直接恢复为可信对象。后续Runtime/Worker请求需重新认证、查成员和绑定run，再进入withTenant。用户/Agent访问权限和平台服务账号身份必须区分，不能把本册Web中间件拿去验证所有服务调用。

## 11. 实施顺序与提交边界

建议执行顺序：T1-A→T1-B→T1-C→T2-A→T2-B→T2-C→T2-D→T3-A→T3-B→T3-C→集成验收。每个子任务完成失败测试、最小实现、正反向验证和差异审查后才进入下一项；较长SQL/schema步骤按文件分批，不一次性无测试落下全册代码。

当前只交付计划。以后获准实施时可在当前会话逐任务执行，或对互不共享文件的独立任务采用受控委派。Git提交、角色创建、迁移和生产发布仍需要各自的用户授权；不因计划里有命令就自动执行。

## 修订记录（2026-10-09，enterprise-mvp-v0.2）

| 评审问题 | 本册修订章节 |
|---|---|
| T-01 | §1、T1-C、§9：补齐 workspace/resource/grant/revoke 的受控 CLI、operationId、epoch 与审计闭环 |
| T-02 | §1、T1-A、§10：移除 Project 表/SQL/测试，固定 Tenant→Workspace→Resource，MVP 无继承/共享，read 显式 ACL |
| T-03 | T2-C：由单常量改为确定性支持版本集合，tenancy-v1 初始，旧新规则兼容窗口，未知拒绝 |
| T-04–T-06 | T3-A/T3-B：拒绝 OPENBOT_SINGLE_USER、OPENBOT_DEV_NO_AUTH；认证工厂权限枚举；编译期 allowlist 只能取子集并拒绝危险路径 |
| T-07 | §4、T2-B/T2-C/T3-A：唯一 `ResourceReader.readAuthorizedResource` 单一 READ COMMITTED 事务，移除双阶段 API |
| T-08 | T1-B、T2-B、§9：真实非空夹具、双连接屏障、固定锁顺序与 READ COMMITTED，区分表权限/RLS/FK |
| T-09 | T1-B/T1-C：租户 operator 与 `ob_ent_identity_operator` 分离；principal 绑定冻结；全局身份操作独立审计 |
| T-10 | T3-C、§8：ready=false→限时排空→非强制停止→连接关闭 |
| T-11 | §4、T3-A/T3-C、§9：500/503+request_id/脱敏日志、索引计划、唯一 custom migration、enterprise/runtime 类型检查和最低 CI 门槛 |
| X-03/X-04/X-06 | §1、T3-A、§8、§10：公开/内部/遗留路由和 G0-R/G0-T/G1a/G1b/G2 仅作边界交接，03–06 待编写 |
| D-03 | §8.3、TEN-23：以总体方案 §18.3 独立安全水位恢复，旧备份不推断新撤权 |

## 12. 官方依据与限制

- [PostgreSQL 17：RLS、角色绕过、约束检查与竞态](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)

上述官方说明与认证/SCIM/Schema/DB接缝来自原文和此前评审，本轮仅按其证据修订文档，没有重新验证外部服务。RLS的自定义会话参数由可信应用设置，**不能防御已经完全控制应用进程或拥有其数据库凭证的攻击者**；因此还需要参数化SQL、无任意SQL入口、凭证隔离和沙箱网络边界。高敏租户的独立库/独立部署单元由后续部署方案提供。

本册没有实际执行数据库迁移、编译、单元测试、外部授权服务调用或生产部署。文档内的验收标准是待验证要求，不是当前系统已具备能力的证明。
