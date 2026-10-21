# 企业 Bot/Channel/Thread 会话子系统规格（C05 / C02 会话域冻结草案）

> 状态：**已批准（冻结）**。2026-10-10 用户在实施会话中明确批准本规格，作为 C05（`plan.md` §8）唯一编码输入与 C02 会话域冻结依据；与 `plan.md` §5、`shared/enterprise/mobile-schemas.ts` 已冻结内容不一致之处在 §3.4 与 §11 显式列为**待修订**，编码任务不得自行裁决。此后对本文档的实质修订需再次取得批准；实现与本规格冲突时以本规格为准并登记差异，不得自行降低。

**输入与证据**（本规格全部断言来自本次逐文件读取）：

- `docs/specs/superpowers/plan.md` §3（全局约束 L56–71）、§5（L114–199）、C02（L246–270）、C05（L349–362）、C07（L379–392）。
- `shared/enterprise/mobile-schemas.ts`、`shared/enterprise/mobile-contracts.ts`（已冻结 re-export）。
- `server/src/enterprise/`：`app.ts`、`contracts.ts`、`errors.ts`、`tenancy/{scope,transaction,directory,routes}.ts`、`authz/{service,repository}.ts`、`bootstrap.ts`、`tenancy/provision.ts`。
- `server/src/db/schema/enterprise-{tenancy,authz}.ts`。
- 已核对缺失：`server/src/enterprise/conversations/` 目录不存在；`server/tests/enterprise/mobile/` 现仅有 `contracts.test.ts`（只覆盖 `TenantSummarySchema`）；本规格文件为此前不存在的新建文件。

---

## 1. 范围与边界

**C05 只做三件事**（`plan.md` L349–362）：

1. 已授权 Bot 的服务端列表（可见性授权）；
2. 个人 Channel 的创建 / 分页 / 详情 / 归档，`threadId` 由服务端生成；
3. 上述资源的租户/主体授权（Scope 复用、Bot read/run 分离、owner 所有权）。

**明确不做**（边界即验收的一部分）：

| 不做 | 归属 | 依据 |
|---|---|---|
| 消息提交、Run、预算、Outbox、`202 Submission` 的产生 | C07（等 F02 持久运行服务） | `plan.md` L379–392、L767 |
| Run 事件持久化、订阅、AG-UI 投影 | F02 / C10 | `plan.md` L423–435 |
| `GET /me`（`PersonalSession` 登录会话视图的提供者） | F01 / C03 | `plan.md` L307；`app.ts` 目前仅挂 `/tenants`、`/scope`、`/resources/:id`（`tenancy/routes.ts:23-38`） |
| 群聊 / 共享 Thread / Channel 参与者 | X01，禁用 | `plan.md` L775 |
| 消息正文内容校验、附件资产 | C07 / C20 | `plan.md` L583–595 |

**与 F02 的接缝**：C05 的 Channel 是 F02 运行域的**引用方**——C07 提交消息时以 `(tenantId, channelId, botId, threadId)` 四元组定位会话并在其自身事务内重验授权；C05 不调用 RuntimeAdapter、不写 `runs` 表、不产生任何执行副作用。`SubmitMessage`/`Submission` DTO 在本规格冻结（§3.2）但**实现归 C07**。

---

## 2. 复用的既有模式（不重建）

| 模式 | 来源 | C05 使用方式 |
|---|---|---|
| Scope 发放 | `tenancy/scope.ts:24-54`：`resolveScope` 是唯一入口，selector 校验 `^[A-Za-z0-9_-]{1,128}$`，非全 active 链 403；WeakSet + `assertScope`（L56-60） | 不改。每请求由 `app.ts:155-165` 中间件重建，C05 路由从 `c.var.scope` 取，禁止从 body/header 收身份 |
| 事务 | `tenancy/transaction.ts:132-167` `withTenant`：READ COMMITTED、事务本地 `set_config` 三上下文、锁超时 2s/语句超时 5s、共享锁三把 + epoch/role 重检、失配抛 `SCOPE_REVOKED` | C05 全部读写走 `withTenant`；禁止裸连接池查询 |
| 锁 | `transaction.ts:40-42` `lockKey`（JSON 数组键）、固定锁序 tenant → principal → membership → resource → operation（L17-20 注释） | Channel 创建用 `operation` 类锁；归档用 `channel` 类排他锁（§5） |
| 授权引擎 | `authz/service.ts:47-80`：default deny、不缓存正判、未知 policy revision 503 | Bot 的 read/run 都过此引擎（run 为 §6 新增 action） |
| 授权读 | `authz/repository.ts:97-115`：单事务读 resource+grant+policy，无行/无 grant/不 active 一律同一 404 | Bot 详情沿用；Bot 列表为新的同事务批量语句（§6.3） |
| 错误 | `errors.ts:14-21`：code 即契约，status ∈ {400,401,403,404,409,500,503} | C05 只使用现有 status；不扩联合（§3.3、§11） |
| 挂载 | `app.ts:167` `mountTenantRoutes(api, deps)`；`tenancy/routes.ts:19-39` | 差量新增 `mountConversationsRoutes(api, deps)`，在 `mountTenantRoutes` 之后同层挂载 |

---

## 3. 契约冻结

### 3.1 命名冲突裁定（最关键待修订）

已冻结 `shared/enterprise/mobile-schemas.ts:29-36` 的 `PersonalSession = { userId, tenants }` 是**登录会话视图**（认证用户 + 可选租户列表），已被 C02 合同测试与 C03/C04 语义占用；而 `plan.md` L127-132 草案的 `PersonalSession = { channelId, botId, threadId, mode }` 是**个人 Channel 会话**。同名不同义。

**裁定**：保留已冻结 `PersonalSession` 语义不变（登录会话视图，提供者归 F01/C03）；计划草案的四元组定名 **`PersonalConversation`**，为本规格新冻结 DTO。`plan.md` §5.1 的此名冲突列入 §11 待修订（修订 plan 文档，不改已冻结 schema 语义）。

### 3.2 C05 新冻结 DTO

```ts
/** 个人 Channel 会话（服务端权威；客户端不提交任何身份字段） */
export const PersonalConversationSchema = z.object({
  channelId: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.literal("single"),
  status: z.enum(["active", "archived"]),
}).strict();

/** Channel 创建请求（幂等键由客户端提供，身份由 Scope 决定） */
export const CreateChannelSchema = z.object({
  botId: z.string().min(1),
  clientRequestId: z.string().min(1).max(128),
}).strict();

/** 消息提交（冻结给 C07；threadId/channelId 走路径，不入 body） */
export const SubmitMessageSchema = z.object({
  clientMessageId: z.string().min(1).max(128),
  text: z.string().min(1).max(16000),
  attachmentIds: z.array(z.string().min(1)).max(8),
}).strict();

/** 受理回执（冻结给 C07；accepted 为字面 true，202 ≠ 执行成功） */
export const SubmissionSchema = z.object({
  messageId: z.string().min(1),
  runId: z.string().min(1),
  accepted: z.literal(true),
}).strict();
```

约束（与 `plan.md` L821 检查点一致）：text 上限 16,000 字符、附件上限 8 个、`.strict()` 拒绝一切多余字段（`principalId`/`scope`/`token` 等身份与凭证字段因此天然被拒）。分页沿用已冻结 `StringCursorPageSchema`（`mobile-schemas.ts:39-46`）。

### 3.3 错误码语义（C05 范围）

统一信封沿用 `app.ts:75-85`：`{error:{code, request_id, retryable, summary}}`；`EnterpriseApiErrorSchema` 已冻结（`mobile-schemas.ts:17-26`）。C05 使用且仅使用现有 `EnterpriseError` status 联合（`errors.ts:14-21`）：

| code | status | 触发 | retryable |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 未登录 / 会话失效（`app.ts:125-131`、`scope.ts:29-31`） | false |
| `TENANT_REQUIRED` | 400 | 缺或非法 `x-openbot-tenant` 选择器（`scope.ts:32-34`） | false |
| `TENANT_FORBIDDEN` | 403 | 非成员 / 任一链路 suspended（`scope.ts:37-44`） | false |
| `SCOPE_REVOKED` | 403 | 事务内 epoch/role 重检失配（`transaction.ts:158-164`）——**撤权后下一个请求即命中** | false |
| `ORIGIN_DENIED` | 403 | 写方法 origin 不在允许列表（`app.ts:116-120`） | false |
| `RESOURCE_NOT_FOUND` | 404 | Bot 无 read grant、Channel 非 owner、资源不存在——**三者同码，不可区分**（沿用 `authz/repository.ts:101-107` 的不可区分原则） | false |
| `CHANNEL_ARCHIVED` | 409 | 向 archived Channel 的写型操作（创建返回读回除外） | false |
| `SUBMISSION_CONFLICT` | 409 | 同 `clientRequestId` 不同 `botId`；同 `clientMessageId` 不同内容（C07） | false |
| `AUTHORIZATION_STATE_INVALID` | 503 | 授权事实损坏（`authz/service.ts:64-72`） | true |
| `POLICY_REVISION_UNSUPPORTED` | 503 | 未知 policy revision（`authz/service.ts:73-76`） | false |
| `DATABASE_UNAVAILABLE` | 503 | 已识别驱动连接失败码（`app.ts:47-61`） | true |
| `SERVICE_DRAINING` | 503 | 排水中（`app.ts:91-93`） | true |
| `INTERNAL_ERROR` | 500 | 其余一切（fail closed，`app.ts:60`） | false |

**不引入** `plan.md` L187 提到的 413/415/422/429：`EnterpriseError.status` 联合不含这些值，扩联合属差量修改且 C05 无大小/类型/配额判定需求（text 长度与附件数由 Schema 校验，超限按 400 处理）；若 C07 需要 413/422/429，由 C07 任务单独立项扩联合并更新测试（§11 待修订）。

### 3.4 已冻结 DTO 与本规格差异对照（全部标待修订，不改语义由编码任务擅自处理）

| DTO | `mobile-schemas.ts` 现状（行号） | 本规格目标 / `plan.md` §5.1 | 差异性质 |
|---|---|---|---|
| `PersonalSession` | `{userId, tenants}`（L29-36） | 保留不动；新拆 `PersonalConversation`（§3.1） | **同名不同义**，需修订 plan §5.1 命名 |
| `SubmitMessage` | `{threadId, content}`（L61-68） | `{clientMessageId, text, attachmentIds}`，threadId/channelId 入路径 | 现形状无幂等键与附件位，C07 无法实现 `plan.md` L392 断言；**待修订** |
| `Submission` | `{id, threadId, status}`（L71-79） | `{messageId, runId, accepted:true}` | 现形状无 runId，无法支撑断网核对（`plan.md` L164 `findSubmission`）；**待修订** |
| `PublicRunEvent` | `{id, runId, kind, createdAt}` 信封（L49-58） | 需 `seq`（重放游标）与 `payload` 判别联合（`plan.md` L143-149、L158） | 信封可兼容演进：**待修订**（加 `seq`/`payload` 或换字段名），归 C10 冻结，C05 不消费 |
| `OperationReceipt` | `{operationId, status:string, createdAt}`（L82-90） | status 须为 `not_submitted/submitted/succeeded/failed/unknown` 五值 + `reconciliationRequired`（`plan.md` L150-155） | `unknown` 必须核对是全计划不变量（`plan.md` L69）；**待修订**，归 F02/C07 |
| C02 测试示例 | `contracts.test.ts` 现仅覆盖 TenantSummary | `plan.md` L258-266 的 `SubmitMessageSchema` 用例当前仅因 strict 多字段拒绝而通过，**并非**按计划语义拒绝身份伪造 | 修订 schema 后该测试才具备声明的语义；**待修订** |

### 3.5 公开 API 形状（C05 分组，前缀 `/api/enterprise/v1`）

| 方法与路径 | 语义 | 授权 |
|---|---|---|
| `GET /bots` | 当前 principal 有 read grant 的 active Bot 列表（分页信封） | Bot read |
| `POST /channels` | body `CreateChannelSchema`；服务端生成 channelId+threadId；幂等创建 | Bot read **且** run（§6.2） |
| `GET /channels` | owner 的个人 Channel 分页（`StringCursorPageSchema<PersonalConversation>`） | owner |
| `GET /channels/:id` | 单个权威 `PersonalConversation` | owner |
| `POST /channels/:id/archive` | 归档（幂等状态翻转；archived→archived 无变更不审计冲突） | owner |

个人会话**不开放**参与者列表/邀请/共享端点（X01 禁用，`plan.md` L760）。

---

## 4. 数据模型与单写所有者

### 4.1 表（`server/src/db/schema/enterprise-conversations.ts`，新建；迁移走既有隔离迁移入口，不走 `db:generate`）

```
enterprise_channels:
  PK (tenant_id, id)                              -- 同 enterprise_resources 复合键模式
  owner_principal_id  FK (tenant_id, principal_id) → enterprise_memberships
  bot_resource_id     FK (tenant_id, id)          → enterprise_resources（应用层校验 kind='bot'）
  thread_id           text NOT NULL               -- 服务端生成
  client_request_id   text NOT NULL
  status              CHECK IN ('active','archived')
  created_at / archived_at
  UNIQUE (tenant_id, owner_principal_id, client_request_id)   -- 创建幂等线性化点
  INDEX  (tenant_id, owner_principal_id, status, id)          -- owner 分页
```

Channel **不**注册进 `enterprise_resources`（其 status check 仅 `('active','deleted')`，`enterprise-authz.ts:48-51`，语义不合归档；且个人 Channel 的授权主判据是 owner 所有权而非 ACL grant，见 §6.1）。**只有 Bot** 作为 `enterprise_resources(kind='bot')` 进现有 grant 体系。

### 4.2 单写所有者矩阵（`plan.md` L58 "一个数据域一个写入方"）

| 数据 | 唯一写者 | C05 角色 |
|---|---|---|
| `enterprise_channels` 行（创建/归档状态） | **C05 conversations 域**（`conversations/store.ts`，仅经 `withTenant`） | 所有者 |
| `enterprise_resource_grants` / `enterprise_resources`（Bot 的 grant） | 租户管理域（`tenancy/provision.ts` 既有授予/撤销命令） | 只读 |
| `enterprise_memberships` / epoch | 租户管理域（`provision.ts:167`、`enterprise-tenancy.ts:88`） | 只读 |
| 用户消息 / Run / 预算 / Outbox | C07 `MessageService` 单事务（等 F02） | 不写；只在 C05 表存四元组引用 |
| Run 事件 / receipt | F02 运行域 | 不写 |
| 移动端本地缓存/草稿 | OM C04/C08 客户端 | 不涉及 |

违反即缺陷：任何 C05 之外的模块写 `enterprise_channels`，或 C05 写上述他域表，验收门禁（§10 N8）拒绝。

---

## 5. 事务线性化点

**Channel 创建**（`POST /channels`，一次 `withTenant` 事务内的固定顺序）：

1. epoch/role 重检（`withTenant` 自带，`transaction.ts:153-164`）；
2. `lockExclusive(lockKey("channel-create", tenantId, ownerPrincipalId, clientRequestId))` —— 同幂等键的并发创建在此**串行化**（advisory lock 模式沿用 `transaction.ts:32-35`；JSON 键防跨类碰撞，`transaction.ts:12-15`）；
3. 锁内按唯一键查询：命中且 `botId` 相同 → **读回原 Channel**（幂等，返回同一 `PersonalConversation`，不新建）；命中且 `botId` 不同 → `SUBMISSION_CONFLICT` 409；
4. 未命中：校验 Bot read+run（§6.2）后 INSERT channel 行；`threadId` 由服务端生成（客户端传入任何 thread 字段被 Schema strict 拒绝）；
5. **线性化点 = 该 INSERT 的 COMMIT**。UNIQUE 约束是锁之后的第二道防线：并发路径若绕过锁等待直接撞唯一键，视为冲突重试读回，不产生第二行。

**归档**（`POST /channels/:id/archive`）：owner 校验 → `lockExclusive(lockKey("channel", tenantId, channelId))` → status 翻转 → COMMIT。归档与创建/消息提交（C07 将取同一 `channel` 排他锁）互斥，不存在"归档事务与提交事务交叉"的中间态。

**Bot 列表 / Channel 列表 / 详情**：只读，仍走 `withTenant`（保证 epoch 重检与 RLS 上下文），不取排他锁；与写事务的并发由 READ COMMITTED + 排他锁串行化保证读到提交前或提交后的完整状态。

**禁止**：跨事务持有锁（`transaction.ts:20`）、事务上下文泄漏到连接池（`plan.md` L66）、在锁内做外部网络调用。

---

## 6. 资源权限矩阵

### 6.1 矩阵

| 资源 / 动作 | tenant_admin | member（owner） | member（非 owner 同租户） | auditor | 平台管理员（非成员） |
|---|---|---|---|---|---|
| Bot 列表可见（read grant） | 需显式 grant | 需显式 grant | 需显式 grant | 需显式 grant | **无**（L61 不隐式） |
| Bot 运行（run grant） | 需显式 grant | 需显式 grant | 需显式 grant | 需显式 grant | 无 |
| 创建个人 Channel | — | Bot read+run | 无（404 Bot 或 403 run） | — | 无 |
| 读自己的 Channel / 历史 | — | ✔（owner 即授权） | ✖ 404 | — | 无 |
| 归档自己的 Channel | — | ✔ | ✖ 404 | — | 无 |
| 读他人 Channel | ✖ 404 | ✖ 404 | ✖ 404 | ✖ 404 | 无 |

要点：**没有任何角色隐式获得内容访问**（`authz/service.ts:11-13`：管理员/审计员同样需显式 grant，`plan.md` L61）；"同租户其他用户也需显式权限"（`plan.md` L362）在 M1 的实现即 **404**——个人 Channel 无共享授权路径，避免存在性泄漏（沿用 `authz/repository.ts:8-9` 的不可区分原则）。

### 6.2 Bot read 与 run 分离（`plan.md` L357）

- `read`：已冻结 action（`contracts.ts:67`、grants check `action='read'`，`enterprise-authz.ts:83`）——Bot 出现在 `GET /bots`、Channel 详情可见 Bot 名。
- `run`：**新增 action**，差量改动（编码任务执行，非本规格改码）：
  - `enterprise-authz.ts` grants 的 check 放宽为 `action in ('read','run')`（迁移，经隔离迁移入口）；
  - `authz/service.ts` 新增 policy revision（建议 `conversations-v1`）：`action ∈ {read, run} ∧ scope.tenantId === resource.tenantId ∧ active ∧ locallyAllowed`（`locallyAllowed` 子查询按请求 action 匹配 grant 行，参照 `authz/repository.ts:40-42`）；`tenancy-v1` 保持只 read 不动，既有测试不回归；
  - `enterprise_tenants.policy_revision` 切换仍在租户排他锁下进行（`enterprise-tenancy.ts:33-36` 既有约束）。
- 只有 read 无 run 的 Bot：列表可见，`POST /channels` **403**（码 `TENANT_FORBIDDEN` 或新码 `BOT_NOT_RUNNABLE` 403，编码时二选一并写入测试；推荐前者以少扩码表）。

### 6.3 列表授权（新语句，禁止 N+1 授权）

`GET /bots` 在**一个** `withTenant` 事务内用单条参数化语句 join `enterprise_resources × enterprise_resource_grants`（principal + action='read'），与 `readAuthorizedResource` 同构（`authz/repository.ts:31-45`）；禁止先列资源再逐个授权。

---

## 7. 撤权语义

三层，全部**立即生效于下一次事务**，无任何缓存正判（`authz/service.ts:6-8`）：

1. **成员撤权/暂停**：`provision.ts:167` `epoch = epoch + 1`（仅 status 真变化时 bump，L387-388 注释、L424 幂等不 bump）。scope 每请求经 `resolveScope` 重建（`app.ts:155-165`）→ 撤权后下一请求 403 `TENANT_FORBIDDEN`；若请求在途，其 `withTenant` 内 epoch 重检（`transaction.ts:158-164`）抛 `SCOPE_REVOKED`。**已存在 Channel 不级联删除**，但 owner 已无法通过任何新事务访问。
2. **Bot read/run grant 撤销**：`provision.ts:675-679` `BUMP_ACL_EPOCH`（幂等撤销不 bump，L673）。下一次 Bot 列表/创建/（C07 的）提交事务实时读 grant → 404/403。**运行中会话的反应**：Channel 存续但不可再由此 Bot 发起新提交——"被撤销 Bot 不继续运行"（`plan.md` L373）由 C07 在提交事务内重验 Bot run grant 落实；C05 的不变量是：**任何以 Channel 为入口的写路径必须在该事务内重验归属 Bot 的 run grant**（本规格作为 C07 的强制输入）。
3. **Channel owner 身份不变**：owner 是创建时固化的 principal，不随后续角色变化漂移；principal 暂停后既非成员亦非 owner，全部 403/404。

撤权竞争窗口：撤权事务与在途会话事务的交叠由锁序（tenant → principal → membership → resource → operation，`transaction.ts:17-20`）+ READ COMMITTED epoch 重检收敛——撤权提交前的在途事务完整生效，撤权提交后的新事务全部拒绝，不存在部分生效。

---

## 8. 故障收敛

| 故障 | 收敛行为 | 证据依据 |
|---|---|---|
| 创建响应丢失后重试同键 | 锁内读回原 Channel，返回**同一** `PersonalConversation`；不产生第二行 | §5 线性化点；`plan.md` L162 幂等创建 |
| 并发双击创建（同键同 Bot） | advisory lock 串行 + 唯一键兜底 → 一行 | §5 |
| 同键不同 Bot | 409 `SUBMISSION_CONFLICT` | `plan.md` L357 |
| DB 不可达 / 连接关闭 | 映射 `DATABASE_UNAVAILABLE` 503 retryable；未识别驱动码 fail closed 500 | `app.ts:47-61` |
| 锁等待 > 2s / 语句 > 5s | 事务失败回滚，无部分写；不换宽超时掩盖 | `transaction.ts:115-116` |
| 服务排水 | 新业务请求 503 `SERVICE_DRAINING`，`/health/*` 例外 | `app.ts:91-104`、`bootstrap.ts` drain 语义 |
| 进程重启 | 无内存态可失：幂等键、Channel、归档状态全在 PG；重启后同键仍读回 | §4 单写所有者 |
| 客户端 Schema 外字段 / 伪造身份 | strict 拒绝（400/422 域内的形状失败按 400），身份永远取自 Scope | §3.2；`scope.ts:7-8` |
| 撤权与在途请求竞争 | §7 锁序 + epoch 重检收敛，无部分生效 | §7 |

禁止形态（`plan.md` L32）：任何故障不得以空数组、成功形状或 mock 默认值返回；失败必须以 §3.3 错误码到达客户端。

---

## 9. 实现落点（全部差量，保护既有未提交改动）

| 文件 | 动作 |
|---|---|
| `server/src/db/schema/enterprise-conversations.ts` | 新建（§4.1） |
| `server/src/enterprise/conversations/{routes.ts,service.ts,store.ts}` | 新建（`plan.md` L351 指定路径；目录当前不存在） |
| `server/src/enterprise/app.ts` | 差量：`mountTenantRoutes` 后挂 `mountConversationsRoutes`（一行级改动） |
| `server/src/db/schema/enterprise-authz.ts` | 差量：grants action check 放宽 + 迁移（§6.2） |
| `server/src/enterprise/authz/service.ts` | 差量：新增 `conversations-v1` policy revision，`tenancy-v1` 不动（§6.2） |
| `shared/enterprise/mobile-schemas.ts` | 差量：新增 §3.2 schema；§3.4 待修订项**须先取得修订批准**再动已冻结导出 |
| `server/tests/enterprise/mobile/conversations.test.ts` | 新建；纳入 `server/tsconfig.enterprise-tests.json` |
| 迁移 | 经既有隔离迁移入口，测试只连隔离库（`TEST_DATABASE_URL`），禁碰 5432 应用库 |

---

## 10. 验收清单（C05 门禁；命令 `cd OB && bun test server/tests/enterprise/mobile/conversations.test.ts`，全部用隔离库 + 真实 RLS，mock 不得替代，`plan.md` L212）

- **N1 拒绝面**：未登录 401；非成员/暂停 403 `TENANT_FORBIDDEN`；跨租户 Bot 与跨租户/非 owner Channel 一律 404 `RESOURCE_NOT_FOUND`，响应体不含他租户资源名称（`plan.md` L355）。
- **N2 管理员不隐式**：平台管理员（deployment admin）以自身成员身份访问，仅见自己的 membership；无成员关系的租户 Bot/Channel 全 404（`app.ts:11-14` 注释语义）。
- **N3 read/run 分离**：仅 read grant 的 Bot 出现在 `GET /bots` 但创建 Channel 403；两者由不同 grant 行驱动，互不推导（§6.2）。
- **N4 幂等创建**：同 `(tenant, owner, clientRequestId)` 同 Bot 重放 → 同一 `PersonalConversation`（同 channelId/threadId，行数不变）；同键不同 Bot → 409；不同键 → 新行（§5）。
- **N5 服务端身份生成**：`threadId` 服务端生成；请求携带任何 thread/身份字段被 strict Schema 拒绝；复合键 `(tenant, channel, bot, thread)` 由表约束承载（`plan.md` L358）。
- **N6 归档**：归档后 owner 仍可 GET 详情（status=archived），继续写型操作 409 `CHANNEL_ARCHIVED`；重复归档幂等无副作用；归档不改消息归属（`plan.md` L372 归 C06 消费）。
- **N7 撤权即时性**：成员暂停 → 在途事务后所有 C05 端点 403 `SCOPE_REVOKED`/`TENANT_FORBIDDEN`；Bot run 撤销 → 下一次创建 403/404 且 epoch 已 bump（§7）。
- **N8 单写所有者**：C05 事务外无任何代码路径写 `enterprise_channels`（代码审读 + 测试断言）；C05 不写消息/Run/grant 表（§4.2）。
- **N9 列表授权**：`GET /bots`/`GET /channels` 为单事务批量授权查询；无逐资源二次授权；分页 cursor 稳定（§6.3）。
- **N10 错误语义**：§3.3 表内每个 code 至少一条正/反测试；错误信封过 `EnterpriseApiErrorSchema`（`mobile-schemas.ts:17-26`）。
- **N11 回归**：`bun test server/tests/enterprise/mobile/contracts.test.ts server/tests/enterprise/tenancy` 全绿；`bunx tsc --noEmit -p server/tsconfig.enterprise-tests.json` 通过（`plan.md` L283、L710）。
- **N12 边界**：仓库中不存在从 C05 指向 RuntimeAdapter/runs 表/消息表的调用或外键（§1）。

---

## 11. 待修订与开放问题（需用户/计划所有者批准后才可编码）

1. **plan §5.1 `PersonalSession` 命名**：与已冻结登录会话视图同名不同义 → 修订 plan，采用 `PersonalConversation`（§3.1）。
2. **`SubmitMessage`/`Submission`/`OperationReceipt` 已冻结形状**（§3.4）：按本规格目标形态修订 `mobile-schemas.ts` 并补 C02 合同测试；修订前 C07 无法实现其声明的幂等断言。
3. **`PublicRunEvent` seq/payload**：信封需加 `seq` 与判别联合 payload；归 C10 冻结（§3.4）。
4. **`EnterpriseError.status` 联合是否扩 413/415/422/429**（§3.3）：C05 不需要；C07 消息域如需，单独立项扩联合。
5. **仅 read 无 run 的创建拒绝码**：`TENANT_FORBIDDEN` vs 新码 `BOT_NOT_RUNNABLE`（§6.2），编码前二选一确认。（登记日期 2026-10-10，来源：C05 收尾评审）：实现已按 §6.2 的推荐方向落码为 `TENANT_FORBIDDEN`（不扩 `EnterpriseError` 联合与 §3.3 码表，`conversations/store.ts:317`；测试 `conversations.test.ts` §6.2 用例如实声明该选择），登记为待追认的裁决确认——追认通过则本条关闭；改判 `BOT_NOT_RUNNABLE` 时需扩联合、更新码表与断言后另行批准。
6. **Bot 目录来源**：本规格假设 Bot 以 `enterprise_resources(kind='bot')` 行存在且 grant 由租户管理域维护；Bot 行的创建/命名入口（capability/插件域）不在 C05——若该域尚无 Bot 资源生产者，C05 以隔离 fixture 造数据并在验收中标注 `implemented(fixture)/missing(producer)`，不得伪造生产端完成（`plan.md` L39、L112）。
7. **`REQUEST_BODY_INVALID` 码表增补待追认**（登记日期 2026-10-10，来源：F01/C05 收尾评审）：`conversations/routes.ts:29` 引入该码（400 语义），未在 §3.3 冻结码表中——登记为待追认的码表增补。
8. **§3.3 `retryable` 语义矛盾待澄清**（登记日期 2026-10-10，来源：F01/C05 收尾评审）：§3.3 将 `DATABASE_UNAVAILABLE`/`SERVICE_DRAINING`/`AUTHORIZATION_STATE_INVALID` 标为 `retryable=true`，但 `app.ts` onError 信封硬编码 `retryable:false`（`app.ts:89`）——登记为待澄清的语义矛盾。
9. **`JSON_REQUIRED` 码表增补待追认**（登记日期 2026-10-10，来源：C05 收尾评审）：`app.ts:141` 写型请求中间件引入该码（400 语义，非只读方法缺 `content-type: application/json` 即拒），未在 §3.3 冻结码表中——与第 7 条同性质，登记为待追认的码表增补。
