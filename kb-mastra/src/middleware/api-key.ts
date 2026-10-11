/**
 * Mastra server 中间件：requestId + 鉴权 + 错误体装配。
 *
 * 链序（v1 §2）：requestId（生成/透传 x-request-id）→ recover 兜底 → Bearer 鉴权
 * （/health 豁免——compose 健康检查不带 token）→ 路由。
 * 错误体统一 `{code, message, request_id}`（契约 §6.2）。
 *
 * 兼容注记：签名与 @mastra/core 的 Middleware（Hono 上下文形状）一致——
 * Mastra 的 server 配置最终也跑在 Hono 上，未来切回 CLI 模式零改动。
 */

import type { MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import { loadConfig } from "../config";
import { authenticate, type Identity } from "./auth";

const log = getLogger("kb-mastra");

/** 身份挂在 context 上的键。 */
export const IDENTITY_CONTEXT_KEY = "kbIdentity";
export const REQUEST_ID_CONTEXT_KEY = "kbRequestId";

/** 契约错误体（§6.2）。 */
export function errorBody(
  requestId: string,
  code: string,
  message: string,
): { code: string; message: string; request_id: string } {
  return { code, message, request_id: requestId };
}

/** 新 request id：`req-` 前缀 + 时间基36 + 序列36（kb-service NewID 同形）。 */
let requestSeq = 0;
function newRequestId(): string {
  requestSeq += 1;
  return `req-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

/**
 * requestId + 访问日志 + 兜底。必须是链上第一个：错误体需要 request_id。
 * （panic 兜底由 Hono 的 app.onError 承担，这里只保证 requestId 入 context。）
 */
export const requestIdMiddleware: MiddlewareHandler<{
  Variables: { kbRequestId: string; kbIdentity: unknown };
}> = async (context, next) => {
  const requestId =
    context.req.header("x-request-id")?.trim() || newRequestId();
  context.set(REQUEST_ID_CONTEXT_KEY, requestId);
  const startedAt = Date.now();
  await next();
  context.header("x-request-id", requestId, { append: false });
  log.info(
    {
      type: "kb-request",
      requestId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      tookMs: Date.now() - startedAt,
    },
    "kb-request",
  );
};

/**
 * Bearer 鉴权。/health 豁免（compose healthcheck 无 token）。
 * 鉴权失败 401 带契约错误体；成功则身份入 context 供 handler/kb-access 用。
 */
export const apiKeyMiddleware: MiddlewareHandler<{
  Variables: { kbRequestId: string; kbIdentity: unknown };
}> = async (context, next) => {
  if (context.req.path === "/health") return next();
  const config = loadConfig();
  const header = context.req.header("authorization") ?? "";
  const offered = header.trim().replace(/^Bearer\s+/i, "");
  const identity = authenticate(config, offered);
  if (!identity) {
    const requestId = context.get(REQUEST_ID_CONTEXT_KEY) ?? newRequestId();
    return context.json(
      errorBody(requestId, "unauthorized", "invalid or missing api key"),
      401,
    );
  }
  context.set(IDENTITY_CONTEXT_KEY, identity);
  return next();
};

/** 从 context 取身份（handler 层用；缺失说明中间件链被绕过，直接抛）。 */
export function identityOf(context: { get(key: string): unknown }): Identity {
  const identity = context.get(IDENTITY_CONTEXT_KEY);
  if (!identity)
    throw new Error("No identity on context: auth middleware missing.");
  return identity as Identity;
}

/** 从 context 取 request id。 */
export function requestIdOf(context: { get(key: string): unknown }): string {
  return (context.get(REQUEST_ID_CONTEXT_KEY) as string | undefined) ?? "";
}
