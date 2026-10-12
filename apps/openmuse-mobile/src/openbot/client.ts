import { Platform } from "react-native";
import { z } from "zod";
import { OpenBotError } from "./errors";
import { sessionCookie } from "./auth";
import { openbotUrl } from "./config";

/**
 * OpenBot HTTP 传输层：所有 API 调用的唯一出口。
 *
 * 职责（对应任务要求 3——异常处理）：
 * - 鉴权：web 用 credentials include（浏览器 cookie），native 手工注入
 *   Better Auth 的 Cookie 头；
 * - 超时：默认 20s，AbortSignal 兼容调用方取消；
 * - 错误映射：401 → authentication_required、403 → refused（带策略 rule）、
 *   网络异常 → unavailable、响应不符契约 → invalid_response；
 * - 写请求（mutates）在 5xx/408 时标记 outcomeUnknown，提示先对账再重试。
 */

const errorBodySchema = z.object({
  error: z.string().optional(),
  rule: z.string().optional(),
});

export interface OpenBotRequestInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function openbotFetch<T>(
  path: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  init: OpenBotRequestInit = {},
  mutates = false,
): Promise<T> {
  if (!path.startsWith("/api/"))
    throw new OpenBotError("invalid_input", "必须使用 /api/ 开头的 OpenBot 路径。");
  if (init.signal?.aborted)
    throw new OpenBotError("cancelled", "请求在发出前已取消。");

  const cookie = await sessionCookie();
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 20_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(`${openbotUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      credentials: Platform.OS === "web" ? "include" : "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
      throw new OpenBotError("cancelled", "请求已取消。");
    throw new OpenBotError(
      "unavailable",
      "无法连接 OpenBot 服务，请检查网络后重试。",
      undefined,
      undefined,
      mutates,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = errorBodySchema.safeParse(body);
    const message =
      detail.success && detail.data.error
        ? detail.data.error.slice(0, 500)
        : `OpenBot 请求失败（${response.status}）。`;
    const code =
      response.status === 401
        ? "authentication_required"
        : response.status === 403
          ? "refused"
          : "http_error";
    throw new OpenBotError(
      code,
      message,
      response.status,
      detail.success ? detail.data.rule : undefined,
      mutates && (response.status >= 500 || response.status === 408),
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new OpenBotError(
      "invalid_response",
      "OpenBot 返回了与预期不符的数据结构。",
      response.status,
      undefined,
      mutates,
    );
  return parsed.data;
}
