/**
 * KB-Service 的 HTTP 客户端。
 *
 * 所有 OpenBot → KB-Service 的调用都收敛到这里，服务间鉴权（API Key）只存在
 * 这一处，不向任何调用方泄漏。错误统一转成带状态码的 `KnowledgeServiceError`，
 * 让路由层用一个 `onError` 就能把上游的 404/403/409 等如实透传给前端。
 *
 * 传输层：node:http 直连（不经任何代理层）。Bun 的 fetch 在长驻进程里会被
 * 开发机的 HTTP_PROXY 劫持 localhost 上游（折成代理 404/HTML），且实测
 * NO_PROXY 与逐请求 `proxy: ""` 都拦不住——node:http 从不读代理变量，是
 * 本机/内网上游的唯一稳定通道（与 kb-mastra 的 QdrantClient 同款结论）。
 * `init.body` 支持 JSON 字符串与 ReadableStream（文件上传）：流会被完整
 * 读入内存再转发（上传文件本就有大小上限，内存化不改变语义）。
 */
import { request as httpRequest } from "node:http";
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
  const startedAt = Date.now();
  try {
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? Buffer.from(init.body, "utf8")
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : // ReadableStream / Blob 等：整体读入（上传有大小上限）。
              Buffer.from(
                await new Response(init.body as BodyInit).arrayBuffer(),
              );

    const response = await dispatch(
      config,
      path,
      init.method ?? "GET",
      init.headers as Record<string, string> | undefined,
      body,
    );

    if (!response.ok) {
      let message = `The knowledge service responded with ${response.status}.`;
      let code: string | undefined;
      try {
        const parsed = (await response.json()) as UpstreamError;
        if (parsed.message) message = parsed.message;
        code = parsed.code;
      } catch {
        // 非 JSON 错误体，保留默认消息。
      }
      log.warn(
        {
          type: "knowledge-upstream-error",
          status: response.status,
          code,
          path,
          tookMs: Date.now() - startedAt,
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
  }
}

/** node:http 直连：返回 fetch 形状的 Response（调用面读 ok/status/json/text）。 */
function dispatch(
  config: KnowledgeServiceConfig,
  path: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: Buffer | undefined,
): Promise<Response> {
  const url = new URL(`${config.baseUrl}${path}`);
  const callerHeaders = headers ?? {};
  const callerContentType =
    callerHeaders["content-type"] ?? callerHeaders["Content-Type"];

  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...callerHeaders,
          authorization: `Bearer ${config.apiKey}`,
          ...(body !== undefined && callerContentType === undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(body !== undefined
            ? { "content-length": String(body.byteLength) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
            }),
          );
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error(`timeout after ${config.timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
