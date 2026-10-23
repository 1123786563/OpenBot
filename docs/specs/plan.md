# OpenMuse Mobile × OpenBot Enterprise 全量实施计划

> 面向执行 Agent：按任务使用 `executing-plans` 执行；只有明确批准独立任务委派时使用 `subagent-driven-development`。进度由会话 SQL todos 跟踪，不使用 Markdown 复选框。计划已通过执行菜单批准，且用户明确批准双 worktree 隔离；数据库操作、生产部署、真实外部副作用与 Git 提交仍需另行批准。

**Goal:** 保留 OpenMuse 原生体验，以 OpenBot 独立企业入口提供身份、租户隔离、个人聊天、实时工具、Computer、工作台、Goals、PDF 和 Google/Microsoft 365 邮件日历，完成 M1–M3。

**Architecture:** OpenMuse 是唯一主移动项目，OpenBot 是唯一业务后端。Better Auth 证明用户身份，企业 Directory/Scope/ACL 决定租户资源权限；运行、工具、业务回执和调度继承现有企业控制平面。移动端使用独立企业 API 与兼容 CopilotKit RN 的企业 Runtime facade，不挂遗留业务或工具路由，不建立第二套 Worker 或状态所有者。

**Tech Stack:** React Native / Expo 54 起步、TypeScript、CopilotKit RN Headless / AG-UI、Better Auth Expo / SSO；OpenBot Hono/Bun、Drizzle/PostgreSQL、企业本地 TS Authz/ActionPolicy；复用企业运行与调度适配器。

**Spec / 规范依据:**

- [移动端集成规格](OpenMuse-Mobile-OpenBot-Backend.md)
- [企业总计划：决策、共同契约、门禁唯一注册](../plans/superpowers/2026-10-09-enterprise-ai-00-master.md)
- [企业租户与独立入口计划](../plans/superpowers/2026-10-09-enterprise-ai-02-tenancy.md)
- [企业运行候选计划](../plans/superpowers/2026-10-09-enterprise-ai-01-runtime.md)
- [OpenMuse 旧适配器说明](../../apps/openmuse/docs/OPENBOT-INTEGRATION.md)

发生冲突时，以企业总计划的安全契约为约束，先登记差异并取得修订批准；本计划不能自行降低 G1b/G2。

## 1. 已确认范围与默认行为

1. 全量细化 M1–M3，不只做 M1 或 API URL 替换。
2. 基于两个本地仓库当前状态；保护未提交改动，已有文件只做差量实现。
3. 企业多租户、SSO、租户隔离贯穿各阶段；先完成基础能力与门禁，再开放对应功能。
4. 使用独立 `/api/enterprise/v1` 入口；不以旧 `/api/channels`、Delivery、Computer 或 Runtime 直接承载企业租户。
5. Goals/Milestones、PDF、Mail/Calendar 在 OpenBot 补齐持久化与授权；不保留第二套 OpenMuse 业务后端。
6. Google 与 Microsoft 365 邮件/日历都在 M3；SSO 身份供应商与业务连接器授权彼此独立。
7. M1–M3 是个人会话，可选择多个已授权 Bot，但一个会话绑定一个 Bot。共享 Thread、多 Bot 群聊单列扩展，不混入本轮个人会话。
8. 离线只读当前用户/租户此前授权缓存，并保留草稿。恢复网络后重验身份、租户和权限，核对不明提交，再由用户确认发送；不自动重发写操作。
9. 本计划不要求重写 Go 控制平面、不引入 OpenFGA/OPA、不自动升级 Expo、不把规划假设记为测量结果。
10. 功能隐藏或禁用时显示明确原因；不使用 mock 数据、空数组或成功形态掩盖服务器失败。

## 2. 代码基线与已核对事实

| 项目 | 本次只读基线 | 影响 |
|---|---|---|
| OpenBot 初读 | `/Users/wuyongjun/trea/OpenBot`；HEAD `d49109b3da39b037c64f996757b6b54f14ff12a9` | 初读时多处企业、运行、插件、计费、移动认证未提交改动；执行前重新记录摘要，不认为 HEAD 覆盖工作区 |
| OpenBot 终检 | HEAD `6bd8525aa4ef1b6f9ccc24ede22008287e8c0f47` | 并发工作新增 `dddd443` 与 `6bd8525`；终检仍有 `server/src/enterprise/runtime/tool-invocations.ts`、`server/src/plugins/routes.ts` 改动。新提交未在本计划中重新作实现审计，不从提交标题推断前置已验收 |
| OpenMuse | `/Users/wuyongjun/trea/openmuse`；HEAD `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` | `.gitignore` 和未跟踪 `.copilotkit/` 已有改动；本计划不覆盖 |
| OpenMuse Mobile | Expo `~54.0.0`、RN `0.81.5`、CopilotKit RN `1.70.1` | 与 OpenBot Runtime `1.77.0`、AG-UI `1.0.1` 不可假定兼容 |
| 包管理器 | OpenMuse `pnpm@11.19.0`，Node `>=22`；OpenBot `bun@1.3.14` | 保持独立锁文件和工具链，不复制另一项目依赖集合 |
| 旧登录 | OpenMuse `App.tsx` 调自身 session，使用旧令牌 | 改为 OpenBot Better Auth，不桥接共享管理员令牌 |
| 旧会话 | `threads.tsx` 随机生成 Thread；`chat.tsx` 固定 `runtimeAgentId: "default"` | 改为服务端权威会话与 Bot/Thread 映射 |
| RN SDK | 已安装 Provider 有 `runtimeUrl`、同步 `headers`、`credentials`、错误回调 | Cookie 异步读取不能直接放进同步 headers 回调；身份更新须重建/更新 Provider |
| 旧适配器 | `packages/backends/src/openbot.ts` 钉旧 OpenBot commit，返回 Intelligence 描述符 | 可复用错误与校验理念，不能直接改造成“企业集成已完成” |
| 企业基础 | Scope/Directory/事务/资源 read 与部分 schema 已存在 | 尚不能证明公开企业 app/bootstrap、聊天、事件、Computer 全部接线 |
| 运行工具候选 | `enterprise/runtime/tool-invocations.ts` 明确是内存 fake | 只用于隔离协议测试，不能用于正式审批、账本或供应商执行 |
| 当前旧 API | `/api/me` 不提供企业成员列表；Delivery 按 actor 解析旧会话 | 企业成员查询、个人会话和消息需独立域实现 |
| 企业合同 | `/api/enterprise/v1`；选择头 `x-openbot-tenant`；内部 prepare/execute 分离 | 客户端只提交选择与提议，不提交可信 Scope、actor、签名、lease |
| PDF | OpenMuse 已有导入/检查/填表；旧集成说明不支持直接当聊天 PDF 上传 | 企业资产/PDF 工作流单独设计，不简单放宽旧 MIME 白名单 |
| 现有测试 | OpenMuse node:test/tsx，OpenBot bun:test | 优先复用 runner；企业新增测试必须纳入独立类型检查 |

上述能力事实来自本次逐文件读取时的源码，不是运行、认证、性能或安全测试通过的声明。并发提交可能推进 F01/F02，C00 必须重新核对最新实现与证据，已有行为只做差量和回归，不按初读状态重复建设。本次不运行构建、测试、服务或迁移。

## 3. 全局约束与状态所有者

- “一个数据域一个写入方。”企业业务不双写 OpenMuse PGlite 与 OpenBot PostgreSQL。
- “同一计划不得同时被旧轮询和新调度器执行。”
- “运行引用具体版本，不能在执行中解析 latest。”
- “平台管理员身份不自动授予租户业务内容访问权。”
- Native HTTP、Runtime、屏幕 WebSocket 都使用当前真实用户 Session，并验证当前租户权限。
- `x-openbot-tenant` 只是选择器；服务端从已验证 Session 与 Directory 生成 Scope。
- 身份与成员关系不同：SSO 成功不自动创建租户成员，不依据邮箱域自动入租。
- Resource `read` 不等于执行、审批、分享、发布或管理；未知动作和策略版本拒绝。
- 企业表、缓存、事件、队列、对象路径、下载与审计都携带租户边界；事务上下文不可泄漏到连接池。
- Intelligence Key、Agent/Computer Token、供应商 OAuth Token、内部短期能力都留在服务端。
- TS 运行域拥有 Run/事件/检查点；工具域拥有 operation/receipt；Node 编排和 Go 执行不直接写业务表。
- SDK 回合结束不等于业务 Run 成功；HTTP 202 不等于执行成功；`unknown` 必须核对。
- 自动化测试仅使用隔离测试库、账号、文件和供应商 sandbox。生产迁移、外发消息、真实写业务需单独批准。
- 执行前获取代码/数据库操作授权。提交 Git 需另行明确批准；不自动 stage 全工作区。

## 4. 任务分组、文件边界与依赖总览

这是一个全量主计划，不把多个子系统伪装成一个小改动。身份、运行、Computer、连接器、Goals、PDF 各自拥有独立契约、测试与验收；C02 必须产出子系统规格，获批后才编码该子系统。

路径记号：`OM/` = OpenMuse 仓库，`OB/` = OpenBot 仓库。下文新文件均为目标位置，执行时先核对是否已存在。业务实现按域集中；只有消费者需要的 DTO 才进入 shared，不生成一套无消费者的通用 SDK。

| ID | 独立可验收交付物 | 实际前置 |
|---|---|---|
| C00 | 双仓库基线与保护范围 | 无 |
| C01 | Native Auth/Runtime 兼容性候选 | C00 |
| C02 | 子系统规格、公开契约与门禁映射 | C00、C01 |
| F01 | 既有 T1–T3 企业身份/租户入口验收 | C00 |
| F02 | E/P/D 企业运行、工具、调度及最小企业 Web 交接 | C02、F01 |
| C03 | 移动 SSO、恢复、退出 | C01、C02、F01 |
| C04 | API Client、租户选择、缓存隔离 | C03、C02 |
| C05 | 企业 Bot/个人 Channel/Thread 后端 | F01、C02 |
| C06 | 移动 Bot 与会话导航 | C04、C05 |
| C07 | 企业消息、幂等提交、历史 | C05、F02 |
| C08 | 非流式移动聊天与草稿/核对 | C06、C07 |
| C09 | M1 集成验收 | C08 |
| C10 | 企业 CopilotKit Runtime facade 与持久事件 | C01、C02、C07 |
| C11 | Native 流式、Stop、重连与重放 | C08、C10 |
| C12 | 工具卡片、Frontend/Headless 契约 | C11、F02 |
| C13 | 企业审批闭环 | C12、F02 |
| C14 | 企业 Computer 授权网关与屏幕 | C05、F02 |
| C15 | 移动 Computer、浏览器与人工接管 | C04、C13、C14 |
| C16 | M2 集成验收 | C11、C13、C15 |
| C17 | Activity/任务/Routines/Responsibilities | C04、C07、F02 |
| C18 | Ideas/Proactive | C04、C07、F02 |
| C19 | Apps/Plugins/Skills/Memory | C04、F02 |
| C20 | 企业文件与安全产物访问 | C04、C14、F02 |
| C21 | Goal/Milestone 持久化与任务关联 | C17 |
| C22 | Google/Microsoft 连接器授权生命周期 | C19、F02 |
| C23 | Gmail/Google Calendar + M365 Mail/Calendar | C22、C13 |
| C24 | PDF 导入、检查、填表与回执 | C20、C13 |
| C25 | Workspace 统一数据适配与旧后端退役 | C17、C18、C19、C20、C21、C23、C24 |
| C26 | 全端/双部署/故障/性能/升级验收 | C09、C16、C25 |
| C27 | 门禁证据、发布与回滚交付 | C26 |

F01/F02 是与既有企业计划的交接任务，不复制其实现。缺失的企业分册、生产存储或授权能力应先补专项规格与批准，不由移动端 fake 顶替。

## 5. 公共契约草案与数据流

以下为 C02 要冻结的**拟新增**企业公开契约，不代表当前接口存在。内部 wire snake_case 合同继续遵守企业总计划；面向 App 的 DTO 使用 camelCase。

### 5.1 最小 DTO 与方法边界

```ts
type IdentityContext = {
  userId: string;
  tenantId: string;
  principalId: string;
  generation: number;
};
type PersonalSession = {
  channelId: string;
  botId: string;
  threadId: string;
  mode: "single";
};
type SubmitMessage = {
  clientMessageId: string;
  text: string;
  attachmentIds: string[];
};
type Submission = {
  messageId: string;
  runId: string;
  accepted: true;
};
type PublicRunEvent = {
  eventId: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
};
type OperationReceipt = {
  operationId: string;
  status: "not_submitted" | "submitted" | "succeeded" | "failed" | "unknown";
  receiptRef: string;
  reconciliationRequired: boolean;
};
```

这些类型不是响应校验；C02 同时提供 strict Zod Schema、脱敏样本和每种事件的判别联合，禁止把 `payload: unknown` 任意强转给 UI。

- `OpenBotApiClient.request<T>(path, schema, {method, body, signal})`：schema 解析输出，处理非 JSON/空 body/非 2xx；仅同源允许列表，写操作不自动重试。
- `TenantContext.select(tenantId)`：查有效成员，增加 generation，销毁旧 Runtime/socket，请求取消、清理缓存与草稿可见性，再挂新租户数据树。
- `ConversationService.create(scope, {botId, clientRequestId})`：服务器校验 Bot 可见及执行授权，服务器生成 Channel/Thread，幂等创建。
- `MessageService.submit(scope, channelId, input)`：同事务消息/Run/Outbox；唯一键包含 tenant/principal/channel/clientMessageId；同键不同内容 409。
- `MessageService.findSubmission(scope, channelId, clientMessageId)`：核对断网前提交，不创建新的业务 Run。
- `HistoryService.list(scope, channelId, cursor)`：授权分页、明确 message/run 归属与稳定顺序。
- `RunEventService.subscribe(scope, runId, afterSeq)`：持久事件重放与续流；订阅过程中撤权终止。
- `RuntimeFacade`：面向已冻结 SDK 的发现/Run/Connect/Stop/history 协议；对接上述服务，不能实例化第二个权威会话存储。
- `ComputerService`：按 Scope/Bot 校验访问、控制权、snapshotId、Policy 和 Audit；公开 DTO 不含私有端点。
- `ApprovalService.decide(scope, id, decision, previewDigest)`：独立 approve 权限、参数与策略绑定、原子消费，不由客户端直接 execute。

### 5.2 公开 API 分组

统一前缀 `/api/enterprise/v1`；路径在 C02 冻结前只是计划合同：

| 分组 | 方法与资源 | 关键限制 |
|---|---|---|
| 身份 | `GET /me`、`GET /tenants` | 租户目录不要求先选租户；业务接口要求选择器 |
| Bot/会话 | `GET /bots`、`GET/POST /channels`、`GET /channels/:id` | 列表/创建/详情独立授权；不暴露其他租户名称 |
| 消息 | `POST /channels/:id/messages`、`GET /channels/:id/submissions/:clientMessageId`、`GET /channels/:id/history` | 202 是接受；幂等冲突 409；不明结果查询 |
| Runtime | `/runtime` 下版本冻结的 SDK 路由 | Run/Connect/Stop/history 同一授权；不当作旧 Intelligence 的 URL 别名 |
| 事件 | `GET /runs/:id/events`、`GET /runs/:id`、`POST /runs/:id/cancel` | seq 重放、取消意图与终态区别 |
| 治理 | `/approvals`、`/routines`、`/responsibilities`、`/activity`、`/suggestions` | 读写/approve 权限分别判断 |
| 能力 | `/plugins`、`/skills`、`/memory`、`/connections` | 授权能力目录，不返回凭证 |
| Computer | `/computers/:botId/*` | 原则与既有 Computer 相同，企业 Scope 另行强制 |
| 业务 | `/goals`、`/tasks`、`/files`、`/pdf-jobs`、`/mail`、`/calendar` | 所有资源与操作携带服务端租户/主体归属 |

错误统一 `{error:{code,message,requestId,retryable}}`，语义包含 401 未登录/过期、400 缺选择器、403 未授权、404 受限资源不存在、409 幂等/版本冲突、413 大小、415 类型、422 内容、429 配额、503 不可用。不同错误不能被统一“重新登录”或“操作成功”吞掉。

### 5.3 关键流程

```text
Better Auth SSO → 服务端验证 Session → 用户所属租户列表
→ 用户选租户 → Directory/Scope → Bot 权限列表
→ 服务端创建个人 Channel/Thread → 提交稳定 clientMessageId
→ 消息 + Run + 预算 + Outbox → 企业执行适配器
→ 已持久化事件/工具回执 → 非流式历史或 Runtime facade → 原生 UI
```

消息只能从一种路径发起：M1 message submission 或 M2 facade Run。两者最终调用同一 MessageService/幂等域，不同时发请求“兜底”；接管、取消、审批不会生成第二次原始消息。

## 6. 每个编码任务的执行规则

每个任务完成一个可独立审查的测试循环：

1. 读取本任务相关最新变更、冻结 Schema、前置验收证据。
2. 在指定测试文件先加入下面列出的正向、拒绝、故障案例；预期失败须来自缺失行为，不来自缺依赖或环境。
3. 使用本任务最小测试命令观察失败；保存实际输出。
4. 按文件职责实现完整行为与必要接线；更新直接相关文档。
5. 重跑相同测试与相关类型检查；真实数据库、真机和供应商测试不能用 mock 通过替代。
6. 更新 SQL 状态与证据。需要 Git 提交时另行取得授权，只添加本任务文件。

测试示例中的拟新增导出必须由所属任务实现，不属于当前已有符号。后端集成测试通过 F01 的隔离企业 app/bootstrap 和 `testDatabaseUrl()` 创建数据库 fixture；fixture 只负责建立/清理专属测试记录，不禁用 RLS 或授权。受影响的已实现行为只做回归，不删除既有代码制造 RED。

## 7. 基线、兼容性与企业前置

### C00：冻结双仓库与保护范围

**文件：** 读取双方 manifest/lockfile、相关源码差异、企业 00/01/02 与移动规格；在会话 artifacts 保存脱敏 baseline，不改 `.gitignore`。

**步骤：**

1. 记录两仓库 HEAD、分支、相关文件摘要、未提交改动归属。
2. 确认隔离执行工作区与批准的测试资源；不得直接复制含 `.env`/凭证的工作目录。
3. 记录依赖/工具链/文档版本与未通过门禁；划分旧 API 与企业 API。
4. 输出保护清单、覆盖矩阵、当前能力状态 `implemented/unverified/missing`，不将组件存在记为已验收。

**验收：** 可重建代码基线且不损坏用户改动；所有后续任务能判断当前代码与历史文档差异。

### C01：验证 Native Auth 与 Runtime 兼容候选

**文件：** `OM/apps/mobile/package.json`、`app.json`、`src/openbot/compatibility.ts`；`OM/apps/mobile/test/openbot-compatibility.test.ts`；隔离 SDK 对照 fixture。参考 `OB/mobile/src/auth.ts`，不整体复制 Expo 55 manifest。

**输出：** 锁定 Expo/Better Auth/CopilotKit/AG-UI 组合与 RN Provider 实际 transport 样本。

**步骤：**

1. 捕获本地 RN SDK discovery/Run/Connect/Stop/history 的请求响应黄金样本；测试普通 HTTP 和 SDK 的区别。
2. 验证 Expo 54 上 SecureStore、Better Auth Expo、SSO 回跳、Cookie headers 与原生 streaming-fetch；iOS/Android 都检查。
3. 若兼容需要改依赖，先修改 manifest，再使用 pnpm/Expo 生态命令安装兼容版本，不混装 Expo 55。
4. 为 SDK 升级或 Expo 升级建立单独变更与 PDF/WebView 回归证据；不可用组合明确失败，不能补 cast 假装兼容。

**测试：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-compatibility.test.ts`；`pnpm --dir apps/mobile typecheck`。

**验收：** 精确版本、原生认证与 Runtime 协议候选都有实际证据；仅服务发现成功不代表运行成立。

### C02：冻结子系统规格与企业公开合同

**文件：** 获准后更新双方集成说明；`OB/shared/enterprise/mobile-contracts.ts`、`mobile-schemas.ts`；`OB/server/tests/enterprise/mobile/contracts.test.ts`；会话内保存身份/运行/Computer/Goals/连接器/PDF 子规格供用户批准。

**步骤：**

1. 冻结 §5 DTO、错误码、分页、幂等范围、事件判别联合、资源权限矩阵。
2. 为每个子系统说明单写所有者、事务线性化点、撤权、故障收敛与验收；作为 F02 和后续编码输入。
3. 定义 DTO 共享方式：生成/校验版本化 HTTP 合同，不跨仓库导入服务端私有类型。
4. Schema 测试拒绝身份伪造、多余字段、错误 ID/版本、秘密字段与不合法事件。

```ts
import { expect, test } from "bun:test";
import { SubmitMessageSchema } from "../../../../shared/enterprise/mobile-schemas";
test("message input cannot claim a business identity", () => {
  expect(SubmitMessageSchema.safeParse({
    clientMessageId: "11111111-1111-4111-8111-111111111111",
    text: "Hello", attachmentIds: [], principalId: "another-person",
  }).success).toBe(false);
});
```

**测试：** `cd OB && bun test server/tests/enterprise/mobile/contracts.test.ts`。

**验收：** 消费者与提供方使用同一合同；规格的旧端点示例明确标为参考而非企业目标；批准记录存在。

### F01：验收已有企业 T1–T3，不重建一套身份

**文件：** 既有企业 tenancy/authz/schema；缺失时按 02 计划补 `enterprise/{config,app,bootstrap,index}.ts` 和 guard；独立企业测试 tsconfig。

**步骤：**

1. 将当前代码与 02 的 T1–T3 逐项对照，执行现有目录/Scope/事务/资源授权测试。
2. 补齐独立企业入口、真实 AuthService、租户列表和资源 read；只接受验证过的真实用户。
3. 执行隔离库 RLS、连接池上下文、撤权竞争、平台管理员非隐式成员用例。
4. 核对企业入口不挂旧业务/内部工具 listener，拒绝 single-user；共享身份域不共享业务权限。

**测试：** `cd OB && bun test server/tests/enterprise/tenancy`；入口新增测试以 02 确定的文件为准，全部纳入 `server/tsconfig.enterprise-tests.json`。

**验收：** T1–T3 证据交接通过；无测试库或仅 fake 结果为 blocked，不为 passed。

### F02：补齐企业运行、工具、调度的最小生产前置

**文件：** 企业总计划分配的 E1–E4、P2–P4、D1/D2/D4 规格与实现；`enterprise/runs`、`models`、`tools`、`schedules`；`OB/app/src/features/enterprise/` 与 `routes/_authed/enterprise/` 的最小受权个人会话界面；复用已有 RuntimeAdapter，不把候选 fake 作为生产实现。

**步骤：**

1. 补齐尚未形成专项规格的账本/事件、预算、ActionPolicy/审批/回执、持久调度与执行隔离合同并取得批准。
2. 按总计划实现 Run/预算/Outbox 同事务、稳定 workflow ID、lease/fencing、先持久化后发布事件。
3. 工具 prepare 只记录提议；execute 重验权限/预算/参数/审批，`submitted/unknown` 禁止自动重试。
4. 调度保存有限可撤销的人类主体委托，不保存长期移动 Session；旧轮询与新调度所有权互斥。
5. 运行候选必须按 G1a/G1b 证据准入。未准入时仅隔离 fake/fixture 开发，不向真实租户开放。
6. 对接 D1 最小企业 Web：可选租户、查看同一个人 Channel 的持久历史和 Run 状态，为 C09/C16 跨端验收提供真实消费者。扩展 `OB/app/src/lib/client.ts` 的显式 `ClientOptions.tenantId`，只为同源企业路径附加选择头；不使用模块级全局“当前租户”。同时兼容企业结构化 error 与旧字符串 error，保持旧请求行为。以 `app/src/lib/enterprise/{queries,mutations}.ts` 工厂统一请求，query key 包含 user/tenant 与参数，切换移除旧缓存；组件不写 fetch，不手算权限。配置页面遵循 PageShell/PageSection，聊天画面沿用既有 chat 组件，不强套配置行布局。不改造旧 Web 为隐式多租户，也不扩大为完整企业管理控制台。
7. 为共享 Web client 加 `OB/app/tests/enterprise-client.test.ts`，覆盖无 tenantId 的旧请求不变、企业请求正确选择头、异源拒绝、两种 error 提取；为企业页面加 `enterprise-session.test.ts`，覆盖 pending/error/empty/rows、切租户晚到响应与撤权。按现有 Web runner 执行并纳入 CI。

**验收：** 后端提供 §5 服务、可持久恢复与治理回执；真实 Run/Tool 门禁按企业 00 登记，移动端不另发生产准入。

## 8. M1：身份、租户、Bot 与个人消息闭环

### C03：移动 SSO、Session 恢复与退出

**文件：** `OM/apps/mobile/src/openbot/auth/{auth-client.ts,auth-provider.tsx,session-lifecycle.ts}`；`App.tsx`、`app.json`；`test/openbot-auth.test.ts`。服务端 trusted origins/回跳配置由 F01 管理。

**输入/输出：** 输入部署 HTTPS 地址与已注册 IdP；输出 `signedOut/restoring/signedIn/expired/error` 身份状态，不输出业务 Token。

**步骤与测试：**

1. 测试未配置/含凭证/不受信 URL 拒绝；生产 HTTPS，开发 HTTP 明确限定。
2. 使用 `openmuse://` 与原项目 scheme，不复制 `openbotmobile://`；测试 PKCE/state、取消、错误回跳。
3. 验证 Session 恢复与 `/me`；401 进入 expired，403 进入权限问题，不回退管理员。
4. 退出/账号切换清除 Cookie、缓存、草稿可见性与活跃 Runtime/socket；SSO 策略禁止社会登录时明确展示。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-auth.test.ts`。

**验收：** iOS/Android 真机登录、重启、过期和退出；无成员用户停留在“未分配租户”，不自动入租。

### C04：API Client、租户选择与身份隔离

**文件：** `OM/apps/mobile/src/openbot/api/{client.ts,errors.ts}`、`tenants/{tenant-provider.tsx,cache-scope.ts}`；`test/openbot-client.test.ts`、`openbot-tenant.test.ts`。

**步骤与测试：**

1. Client 使用 schema 校验；Web 走 Cookie credentials，Native 异步读取 Better Auth Cookie；禁止异源重定向携带凭证。
2. 覆盖 204、非 JSON 错误、401/403/409/429/503、取消、网络错误；向 UI 输出稳定错误码与 requestId。
3. 所有缓存/草稿按部署、user、tenant、资源键分区；generation 拒绝迟到旧租户响应。
4. 切租户取消旧请求并销毁旧 Provider/订阅；离线时不允许切到未验证租户。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { cacheKey } from "../src/openbot/tenants/cache-scope.ts";
test("the same channel id cannot alias two tenant caches", () => {
  assert.notEqual(
    cacheKey({ origin: "https://example.test", userId: "u", tenantId: "a" }, "c"),
    cacheKey({ origin: "https://example.test", userId: "u", tenantId: "b" }, "c"),
  );
});
```

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-client.test.ts apps/mobile/test/openbot-tenant.test.ts`。

**验收：** A→B 切换没有 A 的消息、草稿、文件或 late response；错误不能返回成功形态默认值。

### C05：企业 Bot/Channel/Thread 后端

**文件：** `OB/server/src/enterprise/conversations/{routes.ts,service.ts,store.ts}`、`db/schema/enterprise-conversations.ts`；复用资源授权服务；`tests/enterprise/mobile/conversations.test.ts`。

**步骤与测试：**

1. 先测非成员、撤权、跨租户 Bot/Channel、平台管理员绕过；拒绝读取不可访问资源的名称与映射。
2. 实现已授权 Bot 列表、个人 Channel 创建/分页/详情/归档，服务端生成 threadId。
3. 创建以 `clientRequestId` 去重；相同键不同 Bot 409；Bot 可读与可运行权限分别检查。
4. 复合键约束 tenant/channel/bot/thread，记录资源 ACL 与所有者；不依赖客户端传身份。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/conversations.test.ts`。

**验收：** 返回权威 `PersonalSession`；同租户其他用户也需显式权限；个人会话不开放共享参与者。

### C06：Bot 选择与 Channel 导航

**文件：** `OM/apps/mobile/src/openbot/conversations/{client.ts,channel-provider.tsx}`；`src/threads.tsx`、`App.tsx`；`test/openbot-conversations.test.ts`。

**步骤与测试：**

1. 保留现有导航外观；使用 Bot 列表、Channel 分页与选中状态。
2. 移除企业模式 `newThreadId()` 与 `"default"` 假定；动态绑定服务端 session。
3. 测试创建失败不出现成功会话；切换/恢复/归档不更改原消息归属。
4. 被撤销 Bot 不继续运行；选中项不可用时明确提示，不能静默换 Bot。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-conversations.test.ts`。

**验收：** Web 与 Native 指向同一企业 Channel/Thread，而不是在旧 Web 会话复制内容。

### C07：企业消息提交、历史与幂等核对

**文件：** `OB/server/src/enterprise/conversations/{messages.ts,history.ts}`、routes；企业消息 schema；`tests/enterprise/mobile/messages.test.ts`。

**步骤与测试：**

1. 准备重复同键、同键不同 payload、提交后断网、并发 Thread、权限撤销测试。
2. 单事务持久化用户消息、业务 Run、预算与启动 Outbox；202 返回 Submission。
3. 增加按 clientMessageId 查询回执；history 按已确认顺序与 cursor 分页。
4. 复用企业线程锁；重试同键返回同 message/run，不重新执行；未知外部副作用冻结。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/messages.test.ts`。

**验收断言：** 两次同键提交 → 一条用户消息、一个业务 Run、一个有效启动意图；不同内容 → 409；旧 lease 无法提交结果。

### C08：非流式聊天、草稿与网络核对

**文件：** `OM/apps/mobile/src/openbot/conversations/{submission.ts,drafts.ts}`、`src/chat.tsx`、`conversation-queue.ts`；`test/openbot-submission.test.ts`、既有 queue tests。

**步骤与测试：**

1. 定义 `draft/submitting/accepted/running/completed/failed/uncertain` UI 状态，accepted 不显示为回答完成。
2. 只从 C07 提交消息；通过受权历史/Run 状态取得最终结果；暂停/前后台切换不产生第二次提交。
3. 每次业务提交稳定保留 clientMessageId；断网恢复先查询，不自动生成新 ID。
4. 离线保存草稿；恢复权限验证后用户确认提交；保留既有队列失败暂停与不静默重试行为。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-submission.test.ts apps/mobile/test/conversation-queue.test.ts`。

**验收：** 202、运行中、最终成功、失败、不明结果各有独立 UI；同一逻辑消息最多一个 Run。

### C09：M1 集成验收

**文件：** `OB/server/tests/enterprise/mobile/m1.test.ts`；会话目录脱敏真机验收记录。

**步骤：** 真身份登录→选租户→选 Bot→建个人 Channel→发消息→读最终历史→在企业 Web 恢复；补未登录、跨租户、同租户未授权、SSO 撤销、重启、断网同键核对。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/m1.test.ts`；OM mobile typecheck。

**验收：** 功能闭环与拒绝用例通过。隔离环境 M1 不代表 G1b/G2 或真实租户发布通过。

## 9. M2：实时、工具、审批与 Computer

### C10：企业 Runtime facade 与持久事件

**文件：** `OB/server/src/enterprise/runtime/{mobile-facade.ts,event-projection.ts}`；企业 runs 事件服务；`tests/enterprise/mobile/runtime-facade.test.ts`。

**步骤与测试：**

1. 使用 C01 黄金协议测 discovery、Run、Connect、Stop/history，与固定 RN SDK 实际调用对比。
2. Runtime facade 转调 MessageService/Run 服务；授权路径一致，不挂旧 `server/src/copilot.ts` 全应用。
3. 从已持久事件投影 AG-UI；源事件去重，平台 seq 单调，历史快照/续流无遗漏或重复。
4. 授权后才能连接；撤权终止现有连接。Stop 先是 cancel_requested，业务终态来自账本。
5. Intelligence 只在明确不引入第二存储所有者且通过契约时作为可选传输；不能以 SDK 要求为由恢复旧企业数据存储。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/runtime-facade.test.ts`。

**验收：** 固定 SDK 协议真实可用；无法满足时阻断实时功能并单独修订接缝设计，不直接用 fetch 解析旧 Intelligence 响应为 SSE。

### C11：Native 实时、停止、重连与历史重放

**文件：** `OM/apps/mobile/src/openbot/runtime/{runtime-provider.tsx,event-reducer.ts,run-state.ts}`、`src/chat.tsx`；`test/openbot-runtime.test.ts`。

**步骤与测试：**

1. Cookie 已异步获取后注入同步 Provider headers；刷新 Session 与租户变化更新身份，不使用启动时过期快照。
2. useAgent 动态 bot/thread；Run 发起替换非流式 submission，不双路径发送。
3. 覆盖 TEXT、TOOL、STATE、RUN_ERROR、取消、断流、重复事件、历史与 live 重叠。
4. 重连按服务器 cursor/seq，重建运行状态，不重跑消息；前后台仅恢复受权订阅。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { reduceEvents } from "../src/openbot/runtime/event-reducer.ts";
test("replayed persisted events are applied once", () => {
  const event = { eventId: "e1", runId: "r1", seq: 1,
    type: "TEXT_MESSAGE_CONTENT", payload: { messageId: "m1", delta: "Hi" } };
  assert.deepEqual(reduceEvents([event, event]), reduceEvents([event]));
});
```

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-runtime.test.ts apps/mobile/test/conversation-queue.test.ts`。

**验收：** iOS/Android 真机流式、Stop、弱网、重启重放；SDK RUN_FINISHED 不误报业务 Run 成功。

### C12：工具展示与执行职责拆分

**文件：** `OM/apps/mobile/src/openbot/tools/{tool-registry.tsx,computer-tools.tsx,skill-tools.tsx}`、`src/chat.tsx`；`test/openbot-tools.test.ts`。

**步骤与测试：**

1. 建立按冻结名称与版本的 Renderer/Frontend Handler/Server Tool 清单；不是只迁移视觉卡片。
2. Server/headless 处理不依赖 App 前台存活；Native handler 仅处理确需用户设备参与的功能。
3. Handler 通过企业公开授权操作，不能透传服务签名/私有 Computer URL；服务端还需验证 operation 对应运行。
4. 工具参数 schema、拒绝/等待审批/失败/取消/恢复均可见；未知工具显示不支持，不伪造结果。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-tools.test.ts`。

**验收：** 工具实际执行与渲染一致；切后台不导致同一 operation 再执行。

### C13：审批闭环

**文件：** `OB/server/src/enterprise/tools/approval-routes.ts` 与 F02 审批服务；`OM/.../openbot/tools/approval-tools.tsx`、`approvals/client.ts`；双侧 approval tests。

**步骤与测试：**

1. 授权审批列表、详情、approve/deny；身份、租户、操作、目标、args digest、策略版本绑定预览。
2. 使用真实权限 intersection；管理员、工具发起者与可审批人不能混用。
3. 双点击审批幂等；预览变更/过期/撤权拒绝；批准不直接从手机调用 execute。
4. receipt `unknown` 显示待核对；拒绝、恢复、执行失败分别展示并审计。

**命令：** OB `bun test server/tests/enterprise/mobile/approvals.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-approvals.test.ts`。

**验收：** 审批改变参数后必须重批；有效批准只能消费一次；手机不能调用内部 execute endpoint。

### C14：企业 Computer Gateway 与屏幕通道

**文件：** `OB/server/src/enterprise/computer/{routes.ts,access.ts,stream.ts}`；按差量提取旧 gateway 可复用执行原语；`tests/enterprise/mobile/computer.test.ts`。

**步骤与测试：**

1. 企业 Scope/Bot 授权与对象定位接企业服务，不直接挂旧 actor-only 路由。
2. status/screenshot/stream、snapshot/navigate、控制权请求/接管/归还分别校验权限与策略。
3. WebSocket upgrade 手工执行与 HTTP 同等身份/租户校验；连接存活期间撤权主动关闭。
4. Native 支持受验证 Cookie header；Web 同源 Cookie。不得把长期 Session 放 query。
5. snapshot ref 绑定 snapshotId；requestId 绑定接管请求；human 持有时 Bot 写拒绝；审计记录相关 Run/operation。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/computer.test.ts server/tests/computer-snapshot-id.test.ts server/tests/computer-handoff-contract.test.ts`。

**验收：** 跨租户屏幕 upgrade 拒绝，私有地址/token 不入客户端 DTO；人机并发仍由服务端控制。

### C15：移动屏幕、浏览器与人工接管

**文件：** `OM/apps/mobile/src/openbot/computer/{client.ts,stream.ts,control-state.ts}`；`src/computer.tsx`、`computer-drafts.tsx`、`screens.tsx`；`test/openbot-computer.test.ts`。

**步骤与测试：**

1. 保留 Computer/Browser UI，将选中 Bot 与当前租户绑定，不能为每个 Thread 创建独立 Computer。
2. stream 为主、截图为明确降级；前后台生命周期暂停/恢复，按服务配置限制频率，不无界轮询。
3. control/request/take/release/cancel 使用真实 requestId；无控制权不发送 human 输入。
4. stale snapshot 明确刷新，手动输入/文件写/命令遵守权限与审批；WebView 不加载私有 supervisor URL。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-computer.test.ts apps/mobile/test/computer-status.test.ts apps/mobile/test/browser-address.test.ts`。

**验收：** 看屏幕、请求接管、接管、归还完整闭环；断网显示控制权不明并核对，不本地假定拥有控制权。

### C16：M2 实时工作闭环验收

**文件：** `OB/server/tests/enterprise/mobile/m2.test.ts`；真机测试记录。

**步骤：** 受控测试站点浏览→工具进度→需审批操作→拒绝/批准→屏幕→手机接管→归还→重连；并发 Web/Native、撤权、服务重启和 lease 失效。

**命令：** `cd OB && bun test server/tests/enterprise/mobile/m2.test.ts`。

**验收：** 同一任务没有重复 Run/operation；工具拒绝、审批和审计真实；Computer 接管期间 Bot 不旁路执行。

## 10. M3：完整工作台与业务扩展

### C17：Activity、Task、Routine、Responsibility

**文件：** `OB/server/src/enterprise/activity/{routes.ts,view-model.ts}`；复用企业 schedules/runs；`OM/.../openbot/adapters/activity-adapter.ts`、`src/agent-workspace.tsx`、`agent-ui.tsx`；双侧 activity tests。

**步骤与测试：**

1. 聚合企业 Run、计划、职责、审批与回执，稳定 ID、分页、来源和时间排序；区分运行状态与工具状态。
2. Task 是任务实例；Routine 是计划；Responsibility 是持续职责，不互相改名伪装。
3. pause/resume/cancel/retry 委托给各权威域；unknown 不可从 Activity 按 retry 重执行。
4. 定时计划显式授权委托；停用成员/撤销连接/撤销目标权限阻断下一次执行。

**命令：** OB `bun test server/tests/enterprise/mobile/activity.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-activity.test.ts`。

**验收：** 状态与服务器一致；展示与控制均受权；无 OpenMuse Worker 第二次调度。

### C18：Ideas / Proactive Suggestions

**文件：** `OB/server/src/enterprise/proactive/{routes.ts,service.ts}`；`OM/.../openbot/adapters/proactive-adapter.ts`、Ideas UI；双侧 proactive tests。

**步骤与测试：**

1. 受权建议列表、开始、忽略；证据与目标资源 ACL 同步检查，避免标题/摘要泄漏。
2. 接受建议采用稳定请求键，只启动一个企业 Task/Run；重复点按返回同一个引用。
3. 过期/已撤权/已忽略建议拒绝启动；refresh 不默认产生业务写操作。
4. 映射新/接受/忽略/不可用状态，不把建议直接视为已执行任务。

**命令：** OB `bun test server/tests/enterprise/mobile/proactive.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-proactive.test.ts`。

**验收：** 可查看、启动、忽略并追踪 Run；建议不能绕过审批/预算/当前 ACL。

### C19：Apps、Plugins、Skills、Memory

**文件：** `OB/server/src/enterprise/workspace/capability-routes.ts`；复用企业安装/资源域；`OM/.../openbot/adapters/capability-adapter.ts`、Apps/Memory UI；双侧 capability tests。

**步骤与测试：**

1. 返回真实租户安装/授权能力、版本、连接状态、Bot 授权；Secrets/运行凭证不进入 API。
2. Skills 查看/授权、Memory 查看/编辑/禁用/确认使用现有语义与权限，能力不支持时明确提示。
3. 安装、升级、权限增量需要重新授权；手机不获得管理员安装权。
4. 同名用户/同名连接不同 tenant 不共享 Memory 或 connection 引用；禁用能力影响后续执行。

**命令：** OB `bun test server/tests/enterprise/mobile/capabilities.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-capabilities.test.ts`。

**验收：** 列表与权限、版本、运行可用性一致；Memory 的权威存储不双写旧 Intelligence/新企业域。

### C20：文件与安全产物

**文件：** `OB/server/src/enterprise/files/{routes.ts,service.ts,storage.ts}`、`db/schema/enterprise-files.ts`；`OM/.../openbot/files/client.ts`、Files UI；双侧 files tests。

**步骤与测试：**

1. 区分 Computer Workspace 文件与企业上传/任务产物；只返回有权资源。
2. 服务端生成 tenant/resource object key；禁止绝对路径、`..`、编码绕过与跨 Bot 文件引用。
3. 下载绑定当前 ACL；已撤权后拒绝新下载，处理活动连接终止；凭证不入链接、日志或 WebView。
4. 上传 sniff MIME、大小、hash、配额与扫描状态；未完成扫描/处理不显示可用产物。
5. Native 下载/分享显式用户操作，临时文件在退出、任务完成与过期时精确清理。

**命令：** OB `bun test server/tests/enterprise/mobile/files.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-files.test.ts`。

**验收：** 文件引用与 task/channel 关系有效，跨租户与路径逃逸拒绝；本地文件不跨用户复用。

### C21：Goals / Milestones 持久化与任务关联

**文件：** `OB/server/src/enterprise/goals/{routes.ts,service.ts,store.ts}`、`db/schema/enterprise-goals.ts`；`OM/.../openbot/adapters/goals-adapter.ts`；双侧 goals tests。

**模型：** Goal 为长期目标，Milestone 为有序里程碑；关联 Task 的结果但不自动等同 Routine。参考 OpenMuse Goal status `active/paused/completed`，里程碑明确完成布尔与 revision；租户复合外键保护关系。

**步骤与测试：**

1. CRUD、状态、里程碑增删/排序/完成、Task 关联逐项测试，前端保存必须由服务端持久成功确认。
2. optimistic concurrency 使用 revision，冲突 409；错误关联/跨租户 task 或 milestone 拒绝。
3. 重启恢复目标与状态；撤权后不能查看 Goal，也不能从已加载界面继续更新。
4. 完成 Goal 不默认取消 Task；暂停 Goal 不伪造计划暂停；用户分别操作并展示关系。

**命令：** OB `bun test server/tests/enterprise/mobile/goals.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-goals.test.ts`。

**验收：** 真实持久化、并发冲突明确、Task/Routine/Goal 关系可解释。

### C22：Google / Microsoft 365 连接授权生命周期

**文件：** `OB/server/src/enterprise/connections/{routes.ts,service.ts,google.ts,microsoft.ts}`；复用批准的 connector/secret broker，不另建明文 token 库；`OM/.../openbot/connections/client.ts`；双侧 connections tests。

**步骤与测试：**

1. 接入个人账号 delegated OAuth，使用 PKCE/state、固定回调、最小 read scope；写 scope 单独升级同意。
2. Token 仅服务端加密/broker 持有，连接绑定 tenant/principal/provider/account；SSO 登录不会授予邮件权限。
3. OAuth state 绑定发起用户/租户与连接 generation；另一租户回跳、重放、断开后迟到回跳拒绝。
4. refresh 单飞、断开/撤销/过期状态；Microsoft 企业 consent 不可用时显示 blocked，不改成 application-wide 权限绕过。
5. 暂不纳入共享邮箱/应用级全组织权限；需要专项授权模型才开启。

**命令：** OB `bun test server/tests/enterprise/mobile/connections.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-connections.test.ts`。

**验收：** Google 与 Microsoft 365 真实测试账号授权/恢复/撤销；App、Computer、Runtime state 无供应商 token。

### C23：双供应商 Mail / Calendar 读写与审批

**文件：** `OB/server/src/enterprise/mail/{routes.ts,service.ts,google.ts,microsoft.ts}`、`calendar/{routes.ts,service.ts,google.ts,microsoft.ts}`；`OM/.../openbot/adapters/productivity-adapter.ts`、`screens.tsx`；双侧 productivity tests。

**范围：** 邮件列表/详情/线程/附件引用、草稿与审批发送；日历列表、区间事件、时区显示、审批创建/更新/取消。Google Gmail/Calendar 与 Microsoft Graph Mail/Calendar 都必须实现。

**步骤与测试：**

1. 统一应用 ViewModel，但保留 provider 与原始 ID 作为不透明引用，禁止碰撞/错误拼接。
2. 分页、游标、时区/DST、全天事件、重复事件与单次实例操作定义明确；不支持的复杂编辑禁用且说明。
3. 邮件发送/事件写入走工具提议→预览审批→当前权限/connection generation 复核→receipt。
4. 重试仅依供应商可验证幂等/回执；发送后断网状态 unknown 时查询或人工核对，不重复发送。
5. 附件进入 C20 资产权限链；内容渲染净化，禁止执行邮件 HTML/远程跟踪内容。

**命令：** OB `bun test server/tests/enterprise/mobile/productivity.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-productivity.test.ts`。

**验收：** 两供应商读写 sandbox 都通过；approval digest 绑定收件人/正文/附件或日历目标/时间/时区，修改后重批。

### C24：PDF 导入、检查、填表、回执

**文件：** `OB/server/src/enterprise/pdf/{routes.ts,service.ts,jobs.ts}`；隔离 parser worker 接缝；`OM/.../openbot/pdf/client.ts` 与 PDF 现有 View；借鉴 `OM/packages/integrations/src/pdf.ts`，不复制旧 Store/Auth/Worker。

**范围：** 导入 PDF、预览页数/表单字段、填写现有可编辑字段、生成新产物、查看/下载/分享。非表单 OCR、任意版面编辑与数字签章属于后续专项，不假定 pdf-lib 提供。

**步骤与测试：**

1. 初始沿用已实现 OpenMuse 上限：`10 * 1024 * 1024` bytes、500 pages；超限 413/422，恶意/损坏/加密/不可填写文件明确失败。
2. 通过 C20 授权资产上传，隔离解析并限制内存/CPU/作业输入；单独 parser sandbox，不在 API 进程无界解析。
3. preview 绑定输入 hash、字段集合与操作参数，审批后生成新文件；不覆盖原件。
4. 幂等 operation 关联输出 artifact；重启后由回执核对，不生成重复副本；下载依当前 ACL。
5. 真机 PDF 预览、DocumentPicker、下载/分享与升级回归；外发 PDF 邮件仍需 C23 审批。

**命令：** OB `bun test server/tests/enterprise/mobile/pdf.test.ts`；OM `pnpm exec tsx --test apps/mobile/test/openbot-pdf.test.ts`；移植相关 PDF fixture，不使用真实用户文档。

**验收：** 输入、审核、处理、失败、输出与来源可追溯；不靠放宽旧聊天上传格式完成 PDF 工作流。

### C25：Workspace 统一适配与旧后端退役

**文件：** `OM/apps/mobile/src/openbot/adapters/workspace-adapter.ts`、`workspace.tsx`、`agent-workspace.tsx`、`App.tsx`、`screens.tsx`、`details.tsx`；必要时 `OB/server/src/enterprise/workspace/routes.ts`；`test/openbot-workspace.test.ts`。

**步骤与测试：**

1. 汇总真实数据给现有 View/Context；没有等价能力时明确 unavailable，不伪造完整旧 Workspace。
2. 如果跨域聚合确需 BFF，仅做受权读模型组合；单资源错误显式呈现，不用 broad catch 返回空成功。
3. 分页/刷新/缓存、全局错误与 section 操作指向企业 API；删除企业模式的 `/api/workspace`、`/api/agent`、`/api/main-thread` 与旧 token 依赖。
4. 企业构建不启动 OpenMuse server/worker/独立 Computer。若保留 sample mode，明确独立模式与存储，不混入真实身份树。
5. 更新双仓库集成说明、部署变量与 capability matrix；用代码扫描和运行请求追踪确认无旧服务旁路。

**命令：** `cd OM && pnpm exec tsx --test apps/mobile/test/openbot-workspace.test.ts`。

**验收：** 全页面数据和写操作有真实服务器来源；企业模式只依赖 OpenBot 与批准的执行基础设施。

## 11. 全端验收与交付

### C26：全端、双部署、故障、性能与升级

**文件：** `OB/server/tests/enterprise/mobile/e2e.test.ts`、`recovery.test.ts`；`OM/apps/mobile/test/openbot-regression.test.ts`；复用现有企业 Web E2E；会话目录保存真实输出与设备记录。

**步骤：**

1. 全量执行 §12 负向矩阵与 M1–M3 用户旅程；检查现有 queue、PDF、日期、browser 状态行为保留。
2. iOS/Android 真机验证 SSO 回跳、HTTP/Runtime/WS 身份、前后台、弱网、文件预览/分享。
3. SaaS 与受控联网私有化两种部署，认证源/网络策略/Secrets/升级配置一致；不承诺未验证离线 Intelligence。
4. 故障注入：提交后响应丢失、API/Runtime/Worker 重启、旧 lease、审批恢复、Token refresh/断开竞争、数据库连接池租户复用。
5. 按企业 G2 容量假设进行授权负载验证，记录端到端首字节/最终结果、重连、内存、流量、电量与 UI 长列表指标；预算/性能阈值由产品/业务/SRE 在 C02 合同验收中批准，未签署就阻断发布，不虚构达标。
6. Expo/SDK/服务版本升级测试 schema 兼容、正在运行任务排空、checkpoint 与权限撤销传播，回滚不破坏已提交 receipt。

**最小命令：**

```bash
# OpenMuse root
pnpm exec tsx --test apps/mobile/test/*.test.ts
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile build:web
pnpm --dir apps/mobile build:ios
pnpm --dir apps/mobile build:android

# OpenBot root
bun test server/tests/enterprise/mobile
bun run --filter server typecheck
bunx tsc --noEmit -p server/tsconfig.enterprise-tests.json
```

移动 `build:ios/build:android` 只是 Expo export，不是真机编译/签名/E2E通过。原生构建另执行已有 `pnpm --dir apps/mobile ios` / `android` 或获批 CI 的开发客户端/发布流程。

范围受影响或集成阶段再执行 `OM: pnpm test、pnpm typecheck、pnpm lint` 与 `OB: bun run lint、bun run typecheck、bun run test:ci`，避免每个任务全量跑。格式检查仅针对修改文件，不格式化整个脏工作区。

**验收：** 精确命令、环境、退出码与真机/双部署结果有证据；未运行、不具备账号/库/设备、被 skip 的关键测试记 blocked/not_run。

### C27：发布证据与回滚

**文件：** 双仓库 README/集成文档、获批 CI/部署清单；门禁证据报告，沿用企业 00 注册，不新增更宽松的移动生产门禁。

**步骤：**

1. 汇总双仓库 commit/dirty diff 摘要、依赖 hash、合同版本、各任务和企业 G0/G1a/G1b/G2 状态。
2. 权限/认证/数据域、任务恢复/重复副作用、两个供应商、PDF 与真机矩阵全部列证据。
3. 服务端先发布向后兼容 schema/API，再发布客户端；不兼容变更显式拒绝旧客户端，不能降级为旧无租户 API。
4. 关闭/撤回未达门禁能力；回滚 binary/config，不盲目回滚数据迁移；审计、Run、receipt 和资产保留。
5. 仅 G2 签署后在批准范围开放；Go 候选失败不得由手机绕过企业网关补执行。

**验收：** 可重复部署、明确能力限制与运维手册；真实租户上线经过既有门禁，而非本计划批准即上线。

## 12. 强制测试矩阵与规格覆盖

| 场景/要求 | 期望 | 任务 |
|---|---|---|
| 未登录运行/读历史/看屏幕 | 401，无数据与执行 | C03、C07、C10、C14 |
| 用户/租户 A 请求 B 资源 | 403/404，无存在性泄漏 | F01、C05–C07、C14、C20–C24 |
| SSO 登录但未成为成员 | 无租户权限，不自动入租 | F01、C03、C04 |
| 同用户切租户/退出换用户 | 请求取消、缓存隔离、socket 销毁、迟到响应丢弃 | C03、C04、C11、C15 |
| Native HTTP/Runtime/WS 身份不一致 | 拒绝连接，显式错误 | C01、C03、C10、C14 |
| OAuth/SSO 两平台回跳 | 正确 scheme/state；取消、过期、重放拒绝 | C01、C03、C22 |
| Channel/Thread/Bot 混淆 | 服务端绑定并拒绝非法组合 | C05–C07 |
| 消息 202 | 只表示接受，不伪造完成 | C07、C08 |
| 同消息 ID 重试/换内容 | 一 Run/消息；内容改变 409 | C07、C08、C10 |
| Web/Native 同一 Thread 并发 | 权威锁/版本处理，不重复业务执行 | C07、C10、C11 |
| RUN_FINISHED 但工具 unknown | 保持业务待核对，不能标 succeeded | F02、C10–C13 |
| 历史回放/实时重叠 | 稳定 ID/seq 去重，不重复文字/工具 | C10、C11 |
| Stop/服务丢失/旧 lease | 取消意图与终态分开；旧 fencing 拒绝 | F02、C10、C11、C26 |
| 危险写拒绝/审批变参 | 不执行或重新审批，不能直接调用 Computer | C12–C15、C23、C24 |
| stale snapshot / human 控制 | 更新 snapshot；Bot 写被服务端拒绝 | C14、C15 |
| 定时执行撤权/委托过期 | 下次运行拒绝，不持移动 Session | F02、C17 |
| Goals/Task/Routine | 持久化、分离模型、真实关联 | C17、C21 |
| Google/Microsoft 连接断开/refresh 竞争 | 不复活旧连接，不跨租户，不泄漏 Token | C22、C23 |
| 发信/日历写后响应丢失 | 查询回执/人工核对，无自动重复副作用 | C13、C23、C26 |
| PDF 超限/坏文件/撤权 | 明确拒绝，隔离解析，产物权限跟随 | C20、C24 |
| Files 路径逃逸与旧下载授权 | 拒绝跨路径/资源，撤权生效 | C20、C26 |
| Expo/SDK 升级 | Auth/stream/WS/PDF/WebView 回归 | C01、C26 |
| 两部署、许可证/出域要求 | 授权环境可用；Intelligence 服务许可单独确认 | C00、C02、C26、C27 |
| 群聊/共享 Thread | 当前禁用；不得套个人权限实现 | 扩展 X01 |

原移动规格 T01–T06 → C00/C01/C02/C03–C09；T07–T10 → C10–C16；T11–T16 → C17–C27。规格中旧 Delivery/Intelligence 示例改为企业合同，这是用户确认的企业安全路线差异，不是遗漏。

## 13. 并行边界与执行顺序

- C00 后可独立推进 C01 与 F01；C02 冻结契约后，客户端可使用明确 fixture 开发，不能把 fixture 记为集成通过。
- F01 + C02 后 C03 与 C05 可分开实现；C07 必须等 F02 的持久运行服务。
- M2 的 C14 网关可与 C10/C11 并行；C15 等审批与 Computer 网关都稳定后联调。
- M3 的 Activity、Ideas、Capabilities、Files 可按域并行；Goals 依赖任务域，连接器依赖安装/Secrets，生产力写操作依赖审批，PDF 依赖资产和审批。
- 对同一 `App.tsx`、`chat.tsx`、`screens.tsx` 或 shared schema 的修改串行合并；不可为并行开发同时改同一状态树。
- 每阶段先完成独立后端和客户端测试，再阶段 E2E，再进入下一阶段；可以提前设计 M3，不提前开放未达门禁功能。

## 14. 专项扩展与明确排除

**X01 企业群聊：** 独立规格覆盖参与者、共享历史/资源、成员撤销、`botId → threadId` 映射、多 Bot 发言归属、委派与 fan-out、审计。未批准前 M1–M3 不显示可用群聊。

**X02 后续业务：** 共享邮箱/应用级 Graph 权限、非表单 PDF OCR/数字签章、完整离线执行与自动同步、公开 IdP 自助入驻、非人业务 principal、其他供应商，均不隐式纳入当前编码。

**不执行：** 全量重写 OpenBot 控制平面、迁移所有旧历史、复制 OpenMuse 全部服务端、重复创建 Computer 沙箱、安装外部授权引擎、自动把旧 routine 迁移为 Goal。

## 15. 实施启动输入与完成标准

计划已确定路线；下列是执行/发布所需真实输入，不允许由实现者伪造：

- 代码与隔离测试数据库操作授权、现有工作区保护方式。
- 独立测试 PostgreSQL 与 RLS 角色、SSO IdP/回跳注册、测试成员/资源 ACL。
- iOS/Android 真机和 Native build 环境。
- Google/Microsoft 测试应用与测试账号、客户 admin consent 条件、批准的测试写目标。
- 对象存储、执行/解析沙箱、Secrets broker 与企业运行候选准入证据。
- 企业门禁签署人与业务/性能/预算阈值；许可证、数据出域、保留与删除规则。

**完成定义：** C00–C27 均有可追溯交付物与实际验证；企业既有前置门禁满足；M1–M3 与负向矩阵通过；真实消息/任务/审批/回执/资产持久化且跨租户拒绝；双供应商与真机/双部署有实证。只有计划存在、单元测试通过或 SDK discovery 成功都不构成任务完成。

**规划阶段交付状态：** 完成规划与 SQL 任务建模；规划时未改仓库源码、依赖、数据库或服务，没有声明实现或测试已通过。

### 执行检查点：C00

- 已按用户批准创建仓库外 worktree：OpenBot `feat/openmuse-enterprise-mobile`，OpenMuse `feat/openbot-enterprise-mobile`，固定在本计划终检记录的 commit。
- 两个原工作区的文件与分支未修改；原未提交改动未带入隔离 worktree。
- 恢复隔离目录缺失依赖，未修改已跟踪文件；OpenBot 使用 manifest 指定的 Bun 1.3.14，而非系统 Bun 1.4.2。
- 基线结果：OpenBot Scope 单元测试 9/9；OpenMuse 现有队列测试 4/4；OpenMuse mobile typecheck 退出码 0。它们不是 Native/SSO/RLS/企业门禁通过的证据。
- 脱敏基线与精确命令保存在 `implementation-baseline.json`（该基线文件未随仓库保留）。
- 尚未提供隔离 `TEST_DATABASE_URL`、SSO 测试部署与真机测试目标。C01 Native 联调和 F01 数据库集成必须取得这些输入；不能从原 `.env` 复制或自行使用生产库。
- 未开始功能编码、数据库操作或生产部署，未创建 Git 提交。

### 执行检查点：用户批准的本地 SDK / 契约准备

用户明确选择先做本地可验证的准备，Native/RLS 联调保持阻塞。本检查点仅完成 C01/C02 的本地子任务，不把父任务或 M1–M3 标为完成。

**持久改动位置：**

- OpenMuse worktree：`apps/mobile/src/openbot/compatibility.ts`、`apps/mobile/test/openbot-compatibility.test.ts`、既有集成说明。
- OpenBot worktree：`shared/enterprise/mobile-{schemas,contracts}.ts`、`server/tests/enterprise/mobile/contracts.test.ts`、专用类型检查配置、root Zod 声明及锁文件、CI 类型检查步骤、既有开发说明。
- 未修改原工作区源码；未提交 Git；没有切换 `App.tsx`，没有注册企业 API 或启动服务。

**实现内容：**

1. 生成独立企业 Runtime 的 Provider 配置：HTTPS/显式开发 HTTP、安全 origin、有效租户选择器、Native 必须提供 Cookie/Web 禁止手工 Cookie、明确 REST transport。
2. 用实际安装且被 RN Provider 解析的 CopilotKit Core 1.70.1 运行本地 fetch fixture，验证 discovery/Run/Connect/Stop 的 URL、Bot/Thread 路由、身份头与流式消息结果。
3. 确认 SDK Stop 使用 global fetch；记录后续 Native Cookie 更新与取消通道验证要求，不因此宣称已完成 Native 认证。
4. 提供严格个人会话、消息提交、接受回执、工具操作回执与错误 Schema/推导类型；拒绝伪造身份/秘密字段，保持 16,000 字符和共享 8 附件边界，unknown 必须 reconciliation。
5. root 增加现有 `zod@^4.4.3` 范围，因为 shared 文件不能依赖 server 子目录的包解析；冻结安装检查通过。
6. Runtime 事件判别联合、企业业务授权、Native Auth 及生产账本仍由完整 C02/F01/F02 负责，本地 schema 不冒充权威身份或授权服务。

**已执行验证（均退出码 0）：**

| 工作区 | 命令 | 结果 |
|---|---|---|
| OM | `pnpm exec tsx --test apps/mobile/test/openbot-compatibility.test.ts apps/mobile/test/conversation-queue.test.ts` | 13 passed，0 failed |
| OM | `pnpm --dir apps/mobile typecheck` | passed |
| OM | `pnpm exec biome check apps/mobile/src/openbot/compatibility.ts apps/mobile/test/openbot-compatibility.test.ts` | passed |
| OB | `npm exec --yes --package=bun@1.3.14 -- bun --no-env-file test server/tests/enterprise/mobile/contracts.test.ts server/tests/enterprise/tenancy/scope.test.ts` | 22 passed，0 failed |
| OB | `npm exec --yes --package=bun@1.3.14 -- bun run typecheck:enterprise-mobile` | passed |
| OB | `npm exec --yes --package=bun@1.3.14 -- bun run --filter server typecheck` | passed |
| OB | `node_modules/.bin/biome check package.json shared/enterprise/mobile-schemas.ts shared/enterprise/mobile-contracts.ts server/tests/enterprise/mobile/contracts.test.ts server/tsconfig.mobile-contracts.json` | passed |
| OB | `npm exec --yes --package=bun@1.3.14 -- bun install --frozen-lockfile` | passed，无依赖变化 |
| 双方 | `git diff --check` | passed |
| OB | 本地 YAML parser 校验 `.github/workflows/ci.yml` 与新类型检查步骤 | passed；GitHub CI 本身未运行 |

Native/SSO、真机、RLS、供应商账号与真实企业 Runtime 验证仍未运行；未使用数据库、真实 IdP、真实供应商写操作或生产凭证。
