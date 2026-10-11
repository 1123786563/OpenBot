/**
 * KB-Service 的 HTTP 客户端。
 *
 * 所有 OpenBot → KB-Service 的调用都收敛到这里，服务间鉴权（API Key）只存在
 * 这一处，不向任何调用方泄漏。错误统一转成带状态码的 `KnowledgeServiceError`，
 * 让路由层用一个 `onError` 就能把上游的 404/403/409 等如实透传给前端。
 */
import { getLogger } from "../../../shared/logger";
import type { KnowledgeServiceConfig } from "./config";

const log = getLogger("server");

/** KB-Service 返回的错误体（见 internal/api/handlers.go 的 errorBody）。 */
type UpstreamError = { code?: string; message?: string; request_id?: string };

export class KnowledgeServiceError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "KnowledgeServiceError";
    this.status = status;
    this.code = code;
  }
}

/** 知识库服务未配置或不可达时的统一错误，HTTP 503。 */
export class KnowledgeServiceUnavailableError extends KnowledgeServiceError {
  constructor() {
    super(
      503,
      "The knowledge service is not configured. Set KB_SERVICE_URL to enable it.",
      "unavailable",
    );
    this.name = "KnowledgeServiceUnavailableError";
  }
}

/**
 * 向 KB-Service 发请求并返回响应；非 2xx 一律抛 `KnowledgeServiceError`。
 *
 * `init.body` 可以是 JSON 字符串，也可以是透传的 ReadableStream（文件上传），
 * 客户端不加解释地原样转发；只有鉴权头由这里统一注入。
 */
export async function knowledgeRequest(
  config: KnowledgeServiceConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `The knowledge service responded with ${response.status}.`;
      let code: string | undefined;
      try {
        const body = (await response.json()) as UpstreamError;
        if (body.message) message = body.message;
        code = body.code;
      } catch {
        // 非 JSON 错误体，保留默认消息。
      }
      log.warn(
        {
          type: "knowledge-upstream-error",
          status: response.status,
          code,
          path,
        },
        "knowledge-upstream-error",
      );
      throw new KnowledgeServiceError(response.status, message, code);
    }

    return response;
  } catch (error) {
    if (error instanceof KnowledgeServiceError) throw error;
    log.error(
      {
        type: "knowledge-upstream-unreachable",
        path,
        error: (error as Error).message,
      },
      "knowledge-upstream-unreachable",
    );
    throw new KnowledgeServiceError(
      503,
      "The knowledge service is unavailable. Try again.",
      "unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
