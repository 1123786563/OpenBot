/*
 * #730 OpenBot → MEMORY 的服务客户端。合同来源：契约文档 §MEMORY wire。
 *
 * 身份不来自请求体：每次调用都由 ServerCredentialProvider 按当前可信本人上下文
 * 签发服务凭据与用户委托，客户端包内不含任何服务秘密。浏览器管理站不装配这个
 * provider（它用本人会话客户端），因此同一个客户端不会被浏览器路径复用。
 */

export type SourceRef = Readonly<{ originAppId: string; scopeRef: string }>;

export type JobView = Readonly<{
  id: string;
  state: "accepted" | "processing" | "pending" | "review" | "completed" | "failed" | "expired";
  reason: string | null;
  expiresAt: string;
}>;

export type MemoryView = Readonly<{
  id: string;
  versionId: string;
  content: string;
  originAppId: string;
  sources: readonly SourceRef[];
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export type RecallResult = Readonly<{
  state: "available" | "partial" | "unavailable";
  memories: readonly MemoryView[];
  unavailableReasons: readonly string[];
}>;

export type RecallInput = Readonly<{
  query?: string;
  sourceRefs?: readonly SourceRef[];
  asOf?: string;
}>;

export type SubmitInput = Readonly<{
  idempotencyKey: string;
  fragment: string;
  sources: readonly SourceRef[];
}>;

export type ServerCredentialProvider = Readonly<{
  forRequest(input: { subjectId: string; appId: string; requestId: string }): Promise<{
    serviceCredential: string;
    userDelegation: string;
  }>;
}>;

export class MemoryServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`memory service answered ${status} ${code}`);
    this.name = "MemoryServiceError";
  }
}

export function createMemoryClient(options: {
  baseUrl: string;
  appId: string;
  credentials: ServerCredentialProvider;
}) {
  const base = options.baseUrl.replace(/\/$/, "");
  const call = async <T>(
    path: string,
    subjectId: string,
    requestId: string,
    body: unknown,
  ): Promise<T> => {
    const credential = await options.credentials.forRequest({
      subjectId,
      appId: options.appId,
      requestId,
    });
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-memory-app": options.appId,
        "x-memory-subject": subjectId,
        "x-user-delegation": credential.userDelegation,
        authorization: `Bearer ${credential.serviceCredential}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      throw new MemoryServiceError(response.status, payload.error?.code ?? "UNKNOWN");
    }
    return (await response.json()) as T;
  };

  return {
    submit(input: { subjectId: string; requestId: string } & SubmitInput): Promise<JobView> {
      return call<JobView>("/v1/ingestions", input.subjectId, input.requestId, {
        idempotencyKey: input.idempotencyKey,
        fragment: input.fragment,
        sources: input.sources,
      });
    },
    recall(input: { subjectId: string; requestId: string } & RecallInput): Promise<RecallResult> {
      return call<RecallResult>("/v1/recall", input.subjectId, input.requestId, {
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
        ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      });
    },
  };
}

export type MemoryClient = ReturnType<typeof createMemoryClient>;