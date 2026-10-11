/**
 * OpenBot 集成层错误模型。
 *
 * 语义沿用上游 OpenBotAdapter（packages/backends/src/openbot.ts）的九类
 * 错误码，保证 OpenMuse 侧已有的错误展示逻辑无需重写：
 * - disabled / not_configured：集成开关与配置问题（开发期错误）；
 * - invalid_input：请求参数不合法（客户端 bug）；
 * - invalid_response：响应与契约不符（版本漂移，需联调确认）；
 * - authentication_required：401，会话失效，应回到登录页；
 * - refused：403，越权或策略拒绝；
 * - http_error：其余非 2xx；
 * - unavailable：网络不可达/超时/中断；
 * - cancelled：调用方主动取消。
 */
export type OpenBotErrorCode =
  | "disabled"
  | "not_configured"
  | "invalid_input"
  | "invalid_response"
  | "authentication_required"
  | "refused"
  | "http_error"
  | "unavailable"
  | "cancelled";

export class OpenBotError extends Error {
  constructor(
    readonly code: OpenBotErrorCode,
    message: string,
    readonly status?: number,
    readonly rule?: string,
    /** 写操作可能已生效；重试前必须先对账，避免重复执行。 */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "OpenBotError";
  }
}

/** 会话失效的判定入口：鉴权失败即需要重新登录。 */
export function isAuthFailure(error: unknown): error is OpenBotError {
  return error instanceof OpenBotError && error.code === "authentication_required";
}
