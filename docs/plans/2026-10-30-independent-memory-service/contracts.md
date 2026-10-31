# 跨仓库合同

状态：已批准 Spec v3 的实施细化。以下名称和路由供各分册统一消费；它们是拟建合同，不是现有 API。类型由 MEMORY 的 `packages/client/src/contracts.ts` 定义并以发布包交付，禁止跨仓库深层源码 import。

## 身份与内部能力

身份中心提供 OIDC discovery、签名密钥、authorization code + PKCE、token 与适用的会话退出能力。每个客户端使用独立登记的 client ID、精确回调与 audience；本人会话与 client credentials 不能互换。

身份中心的内部服务 API：`POST /internal/subjects/resolve` 接受已验证的 issuer/subject 或受控旧主体映射凭据，返回 `SubjectRef`；`POST /internal/subjects/status` 返回当前主体有效性及 generation。不得开放按邮箱返回任意身份的查询或创建路径。旧映射导入只对隔离 fixture 或另行批准的身份切换操作开放。

```ts
type SubjectRef = Readonly<{
  subjectId: string;
  issuer: string;
  subject: string;
  generation: number;
}>;
type AccessContext = Readonly<{
  requestId: string;
  subjectId: string;
  appId: string;
  credentialKind: "user-session" | "user-delegation";
}>; // 仅鉴权模块构造，不从请求 body 反序列化。
type SourceRef = Readonly<{
  originAppId: string;
  scopeRef: string; // 来源应用签发并绑定原始公司/团队/Bot/来源范围的引用。
}>;
type SourceCheck = Readonly<{
  requestId: string;
  subjectId: string;
  originAppId: string;
  consumerAppId: string;
  source: SourceRef;
  versionId: string | null;
  action: "collect" | "recall" | "review";
}>;
type SourceDecision =
  | { state: "allowed"; revision: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable" };
type JobView = Readonly<{
  id: string;
  state: "accepted" | "processing" | "pending" | "review" | "completed" | "failed" | "expired";
  reason: string | null;
  expiresAt: string;
}>;
type MemoryView = Readonly<{
  id: string;
  versionId: string;
  content: string;
  originAppId: string;
  sources: readonly SourceRef[];
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;
type RecallResult = Readonly<{
  state: "available" | "partial" | "unavailable";
  memories: readonly MemoryView[];
  unavailableReasons: readonly string[];
}>;
type RecallInput = Readonly<{
  query?: string;
  sourceRefs?: readonly SourceRef[];
  asOf?: string; // ISO 8601 UTC；省略时按当前有效版本。
}>;
type SubmitInput = Readonly<{
  idempotencyKey: string;
  fragment: string;
  sources: readonly SourceRef[];
}>;
type CleanupReceipt = Readonly<{
  notificationId: string;
  state: "completed" | "partial" | "failed";
  items: readonly Readonly<{
    scope: string;
    state: "completed" | "failed" | "uncontrollable";
    evidenceRef: string | null;
  }>[];
}>;
type BudgetedCall<T> = Readonly<{
  appId: string;
  subjectId: string;
  jobId: string;
  idempotencyKey: string;
  maximumMicrousd: bigint;
  execute: () => Promise<{ value: T; actualMicrousd: bigint | null; usageRef: string }>;
}>; // 内部适配器构造，不能从应用请求反序列化执行函数或费用归属。
type SweepResult = Readonly<{
  payloadsDeleted: number;
  candidatesExpired: number;
  errors: readonly string[];
}>;
```

这些类型不将 `subjectId` 或 appId 的客户端声明当作身份：HTTP 层从受信会话/委托构造 AccessContext；来源应用只有在核验来源引用和实际消费者后才返回 allowed。无外部来源的明确个人输入可用空 sources；已知来源内容不能由接收应用清空来源再写为自己的记忆。

内部预算使用美元百万分之一的整数单位，bigint 不直接上 JSON wire；API 显示值用十进制字符串并锁定价格依据。BudgetedCall 的 execute 只能来自已装配网关适配，覆盖 Hindsight 内部模型调用，不能接受应用上传函数或自行声明低估费用。

`RecallInput.asOf` 是明确的历史有效时间选择，不是身份或授权证明；服务仍按当前身份、委托、共享和来源权限检查。有效区间采用 `[effectiveFrom, effectiveUntil)`；`asOf` 与更正的 `effectiveFrom` 都只接受带 `Z` 的 ISO 8601 UTC 瞬时，其它写法（无时区、纯日期、空格分隔）一律 400，不按服务器本地时区解释。历史查询不走只反映当前状态的索引，因此 `asOf` 与 `query` 同时给出即 400——服务不能静默丢弃调用方的过滤条件；当前查询省略 `asOf`。

`CleanupReceipt.items` 逐项声明接收应用控制的范围和结果；每项 `completed` 须有可核验 `evidenceRef`，`failed` 或 `uncontrollable` 不能算清理完成。整体 `completed` 必须与全部应清理范围的完成证据一致，空清单或回调 200 不证明清理；未回执表示待处理。计划中的旧 `controlledScopes` / `unresolvedScopes` 是未发布草案，不是已部署协议；首个实现统一发布此合同版本，真实适配接入前须经消费者合同测试。

## MEMORY 的逻辑服务接口与 wire

`MemoryService` 定义于 `src/memory/service.ts`，方法均异步：

- `submit(context: AccessContext, input: SubmitInput): Promise<JobView>`。
- `recall(context: AccessContext, input: RecallInput): Promise<RecallResult>`。
- `review(context: AccessContext, input: { candidateId: string; decision: "confirm" | "edit" | "reject"; content?: string }): Promise<MemoryView | null>`。
- `correct(context: AccessContext, input: { memoryId: string; content: string; effectiveFrom: string }): Promise<MemoryView>`。
- `forget(context: AccessContext, memoryId: string): Promise<{ cleanupId: string }>`。
- `share(context: AccessContext, input: { versionId: string; consumerAppId: string }): Promise<{ authorizationId: string }>`；`revokeShare(context, authorizationId): Promise<{ cleanupId: string }>`。
- `revokeSource(context: AccessContext, source: SourceRef): Promise<{ cleanupId: string }>`。
- `setPause(context: AccessContext, patch: Partial<PauseStateView>): Promise<PauseStateView>`、`getPause(subjectId): Promise<PauseStateView>`（#721 实现为 `src/memory/pause.ts` 的 `createPauseService`）。

`PauseStateView` 为 `{ learningPaused: boolean; usagePaused: boolean }`。`GET /v1/pause` 返回当前本人两值（缺省全 false）；`POST /v1/pause` 接受 `Partial<PauseStateView>` 部分更新（未提供项保持原值，两项控制互不替代；空 patch 或非布尔 400）。两入口只接受本人受信会话（应用凭据 401 AUTH_REQUIRED），body 中的 `subjectId` 不被信任。learning 暂停阻断采集任务处理与候选形成（任务置 `pending/paused`，保留片段可重试；排队过期判定先于暂停，超期任务仍终态清片段）；本人显式 `/v1/remember` 与本人审核确认不受 learning 暂停阻断。usage 暂停立即阻断全部召回路径（本人会话、产生应用、跨应用共享、索引命中与降级），前置于索引检索与来源在线核验，结果 `{ state: "unavailable", memories: [], unavailableReasons: ["usage_paused"] }`，与"本人没有记忆"（`available`+空）可区分。暂停/恢复只写暂停状态，不改采集、读取、共享及来源授权。

`GET /v1/me`、`/v1/delegations`、`/v1/jobs/:id`、`/v1/candidates`、`/v1/memories`、`/v1/memories/:id/versions`、`/v1/cleanup/:id` 提供本人受控视图。`GET /v1/memories` 只返回各记忆当前有效版本；版本历史（新旧内容与各自半开区间）由 `GET /v1/memories/:id/versions` 返回 `MemoryVersionView[]`（本人会话；他人与不存在 404）。写入用 `/v1/ingestions`、`/v1/candidates/:id/review`、`/v1/memories/:id/corrections`（正文非空且非秘密，`effectiveFrom` 须晚于当前版本起点：更早 400，同一时点 409 `VERSION_CONFLICT`）、`/v1/memories/:id/forget`、`/v1/shares`、`/v1/shares/:id/revoke`、`/v1/sources/revoke`。`/v1/pause` 分别保存 learning/usage 状态。管理应用调用与服务调用执行同一规则。

逐版本只读共享用 `POST /v1/shares`（`{ versionId, consumerAppId }` → `201 { authorizationId }`，幂等）与 `POST /v1/shares/:id/revoke`（`204`，幂等；他人与不存在 404）；`GET /v1/shares` 返回本人当前有效授权 `ShareView[]`（`{ authorizationId, versionId, memoryId, content, consumerAppId, createdAt }`）。三个入口只接受本人受信会话（应用凭据 401 `AUTH_REQUIRED`）；版本须属于本人、已确认且仍开放（`effectiveUntil` 已闭合的旧版 404——历史选择不是授权证明），接收应用须已登记且 active（否则 400）。裁决顺序：版本归属先于应用登记态，垃圾 versionId 探测不到登记面。活跃授权在 `(versionId, consumerAppId)` 上唯一（部分唯一索引兜底）：并发的相同请求只落一行并返回同一授权 id，撤销即全量生效。交付侧共享裁决（recall/derivation）同时要求版本仍开放——版本失效即不可交付，收回共享的故障/竞态不放大泄露面。共享是只读事实：接收应用不能创建/撤销共享，也不能修改或删除内容；新记忆、更正后新版本、新派生都不继承共享。更正提交时旧版共享撤销意图与业务写入同事务持久化，收回成功后标记完成；失败保留待重放，服务启动（及重放入口）补做未完成意图。

派生判断使用 `POST /v1/derivations`（`{ basisVersionIds, content? }` → `202 { candidateId }`）：依据必须属于本人、已确认且当前在其有效区间内、对调用方可见（同来源或逐版本共享；本人会话不限应用范围）且来源在线核验 `allowed`；依据本身是派生判断时，其祖先依据递归同规则复核（继承全部依据限制，悬挂依据按不可用拒绝）。同一次判断的依据须同源，或全部为无外部来源的通用个人记忆，不跨不同授权来源合成。派生只形成待审候选，正文由调用应用给出不构成本人确认；学习暂停期间应用发起的派生返回 409 `PAUSED`（本人显式 remember 与审核不受影响）。更正与撤销提交时把旧版共享撤销意图与业务写入同一事务持久化，远端收回成功后标记完成、失败保留待重放。

本人明确“请记住”使用 `POST /v1/remember`；只接受服务验证的本人交互证明，绑定应用、本人、内容摘要、来源与一次性 nonce。普通采集委托或模型输出不能制造该证明；敏感信息仍进入相应审核或被拒绝。

异步提交只有在片段、归属、过期时间与任务原子持久化后返回 202。相同 `(appId, subjectId, idempotencyKey)` 与相同内容返回原任务；相同 key 内容不同返回冲突。其他写入也须有同等级幂等或版本前置条件。

拒绝使用稳定错误 envelope `{ error: { code, requestId } }`，细节不给无权调用方泄露对象存在性。合同固定：400 `INVALID_REQUEST`、401 `AUTH_REQUIRED`、403 `APP_NOT_REGISTERED` / `DELEGATION_REQUIRED` / `SOURCE_DENIED`、404 `NOT_FOUND`、409 `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `PAUSED`（学习暂停期间应用发起的派生被拒，本人恢复后可重试）、503 `DEPENDENCY_UNAVAILABLE`；无权得知存在性的对象统一 404。#722 历史查询能力接入前，#720 对带 `asOf` 的请求以 501 `HISTORICAL_QUERY_UNSUPPORTED` 拒绝，不能忽略时间并返回当前内容；能力交付后按历史时间合同处理。可靠接收后的预算不足是 JobView pending 原因，不伪装成同步成功记忆；来源无法核验不能伪装成空召回。M01/M02 与客户端合同测试共同锁定此映射。

## 来源与撤权

来源应用实现 `POST /api/memory-service/source-check`，消费 SourceCheck 并返回 SourceDecision。OpenBot 侧实现位于 `server/src/memory-service/routes.ts`（服务令牌鉴权、按合同形状校验）；#732 阶段尚未挂载——服务令牌来源须与真实 MEMORY 实例对齐，挂载进联调验收（#733），未挂载时该入口返回 404 而不是放行。临时拒绝/不可用不等同持久来源撤销。来源引用必须由来源应用签发并能恢复原始业务范围，不可用任意传入 tenantId 或 workspaceId 选择其他人的资源。

服务内共享/遗忘/来源撤销使用单调权限版本。交付前回读最新服务版本并在线核验来源，核验成功的来源 revision 是此次读取的来源授权线性化点；其后的撤销不使已准入读取自动变成新调用，但来源最终撤销通知仍触发持久阻断和副本清理。实施者须用并发测试证明所选 fencing 与交付顺序，不承诺追回已交付字节。

`POST /v1/cleanup-receipts` 接收应用服务身份提交的 CleanupReceipt；notification 必须属于该 app。服务提交撤销事务时持久化通知意图，通知与回执均可重试；未收到或部分失败不显示全量清除完成。

`POST /v1/shares/:id/revoke`（204，幂等）把撤销时间、清理事实（`share_cleanups`）与通知意图（`cleanup_notifications`，notificationId 固定）写入同一事务：通知发送失败不影响撤销生效。通知投递走接收应用登记的回调 URL（无回调即失败），启动与周期重试未完成通知；HTTP 200 只代表送达，回执之前不是完成。`GET /v1/cleanups` 返回本人 `CleanupStatusView[]`（`{ cleanupId, authorizationId, versionId, consumerAppId, createdAt, notificationId, notificationState: pending|sent|completed, attempts, lastError, receipt, outcome }`），`GET /v1/cleanup/:id` 为单条（他人与不存在 404）；两入口只接受本人受信会话。`outcome` 由回执事实派生：无回执 `awaiting_receipt`；任一范围 `uncontrollable` 即 `uncontrollable`（不与失败混同）；整体 `completed` 且逐项有证据为 `completed`；其余 `partial`。回执入口只接受应用服务身份（本人 bearer 401）：畸形回执与"整体 completed 但空清单/无证据项/含不可控项"一律 400，通知不属于该应用 404；重复回执单行状态化（无重复效果）。界面按 outcome 区分停止共享/未回执/部分清理/无法控制/有证据完成，任何状态都不表示已追回外发内容。

## 客户端与内嵌

MEMORY 提供 `createMemoryClient(options: { baseUrl: string; credentials: ServerCredentialProvider }): MemoryClient`；`MemoryClient.submit/recall` 的输入输出复用上述合同。OpenBot 的 ServerCredentialProvider 仅在服务器签发或取得已验证委托，客户端包不得包含服务秘密。

`ServerCredentialProvider.forRequest(input: { subjectId: string; appId: string; requestId: string }): Promise<{ serviceCredential: string; userDelegation: string }>`；MemoryClient 的 `submit(input: SubmitInput)`、`recall(input: RecallInput)` 分别返回 JobView、RecallResult，服务端消费时由 provider 绑定当前可信本人上下文。浏览器管理站使用本人会话客户端，不装配该服务秘密 provider。

OpenBot 的部署配置在 `MEMORY_SERVICE_URL` 之外必须同时提供应用身份与来源签名键：`MEMORY_SERVICE_APP_ID`、`MEMORY_SERVICE_APP_SECRET`、`MEMORY_SERVICE_SOURCE_KEY`；缺一即拒绝启动（#732）。前三者对应上文的 appId/serviceCredential，`SOURCE_KEY` 用于 `issueSourceScope` 签发可核验的 SourceRef，来源应用据此裁决来源授权。管理承载页只读部署地址；运行装载器只在四值齐备时装配。

内嵌页面消息仅支持 `{ type: "memory.ready" | "memory.resize" | "memory.auth-required" | "memory.logged-out"; requestId: string; height?: number }`。消息不携带身份、公司选择或 bearer token，不触发权限变更；双方校验精确 Origin、source window 与关联 ID。auth-required 只要求顶层执行已登记回跳流程，不接受任意消息 URL。支持同站 HTTPS 部署作为首个集成 fixture；跨站拓扑须独立验证会话/存储合同，不能默默依赖第三方 cookie。
