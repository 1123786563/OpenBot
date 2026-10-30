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

`RecallInput.asOf` 是明确的历史有效时间选择，不是身份或授权证明；服务仍按当前身份、委托、共享和来源权限检查。有效区间采用 `[effectiveFrom, effectiveUntil)`，UTC 时间不合法则拒绝；当前查询省略 `asOf`。

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

`GET /v1/me`、`/v1/delegations`、`/v1/jobs/:id`、`/v1/candidates`、`/v1/memories`、`/v1/cleanup/:id` 提供本人受控视图；写入用 `/v1/ingestions`、`/v1/candidates/:id/review`、`/v1/memories/:id/corrections`、`/v1/memories/:id/forget`、`/v1/shares`、`/v1/shares/:id/revoke`、`/v1/sources/revoke`。`/v1/pause` 分别保存 learning/usage 状态。管理应用调用与服务调用执行同一规则。

本人明确“请记住”使用 `POST /v1/remember`；只接受服务验证的本人交互证明，绑定应用、本人、内容摘要、来源与一次性 nonce。普通采集委托或模型输出不能制造该证明；敏感信息仍进入相应审核或被拒绝。

异步提交只有在片段、归属、过期时间与任务原子持久化后返回 202。相同 `(appId, subjectId, idempotencyKey)` 与相同内容返回原任务；相同 key 内容不同返回冲突。其他写入也须有同等级幂等或版本前置条件。

拒绝使用稳定错误 envelope `{ error: { code, requestId } }`，细节不给无权调用方泄露对象存在性。合同固定：400 `INVALID_REQUEST`、401 `AUTH_REQUIRED`、403 `APP_NOT_REGISTERED` / `DELEGATION_REQUIRED` / `SOURCE_DENIED`、404 `NOT_FOUND`、409 `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT`、503 `DEPENDENCY_UNAVAILABLE`；无权得知存在性的对象统一 404。#722 历史查询能力接入前，#720 对带 `asOf` 的请求以 501 `HISTORICAL_QUERY_UNSUPPORTED` 拒绝，不能忽略时间并返回当前内容；能力交付后按历史时间合同处理。可靠接收后的预算不足是 JobView pending 原因，不伪装成同步成功记忆；来源无法核验不能伪装成空召回。M01/M02 与客户端合同测试共同锁定此映射。

## 来源与撤权

来源应用实现 `POST /api/memory-service/source-check`，消费 SourceCheck 并返回 SourceDecision。临时拒绝/不可用不等同持久来源撤销。来源引用必须由来源应用签发并能恢复原始业务范围，不可用任意传入 tenantId 或 workspaceId 选择其他人的资源。

服务内共享/遗忘/来源撤销使用单调权限版本。交付前回读最新服务版本并在线核验来源，核验成功的来源 revision 是此次读取的来源授权线性化点；其后的撤销不使已准入读取自动变成新调用，但来源最终撤销通知仍触发持久阻断和副本清理。实施者须用并发测试证明所选 fencing 与交付顺序，不承诺追回已交付字节。

`POST /v1/cleanup-receipts` 接收应用服务身份提交的 CleanupReceipt；notification 必须属于该 app。服务提交撤销事务时持久化通知意图，通知与回执均可重试；未收到或部分失败不显示全量清除完成。

## 客户端与内嵌

MEMORY 提供 `createMemoryClient(options: { baseUrl: string; credentials: ServerCredentialProvider }): MemoryClient`；`MemoryClient.submit/recall` 的输入输出复用上述合同。OpenBot 的 ServerCredentialProvider 仅在服务器签发或取得已验证委托，客户端包不得包含服务秘密。

`ServerCredentialProvider.forRequest(input: { subjectId: string; appId: string; requestId: string }): Promise<{ serviceCredential: string; userDelegation: string }>`；MemoryClient 的 `submit(input: SubmitInput)`、`recall(input: RecallInput)` 分别返回 JobView、RecallResult，服务端消费时由 provider 绑定当前可信本人上下文。浏览器管理站使用本人会话客户端，不装配该服务秘密 provider。

内嵌页面消息仅支持 `{ type: "memory.ready" | "memory.resize" | "memory.auth-required" | "memory.logged-out"; requestId: string; height?: number }`。消息不携带身份、公司选择或 bearer token，不触发权限变更；双方校验精确 Origin、source window 与关联 ID。auth-required 只要求顶层执行已登记回跳流程，不接受任意消息 URL。支持同站 HTTPS 部署作为首个集成 fixture；跨站拓扑须独立验证会话/存储合同，不能默默依赖第三方 cookie。
