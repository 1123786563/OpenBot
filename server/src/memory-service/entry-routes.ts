import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/public";

/*
 * #731 内嵌承载入口：返回当前会话适用的受控承载信息。URL 只来自部署配置，
 * 不来自请求；不返回服务秘密、令牌或任何身份字段之外的东西。未配置记忆服务
 * 时整体不挂载（页面显示"未启用"，而不是一个空 iframe）。
 */

export type MemoryServiceEntry = {
  /** 承载页地址，仅由服务器配置拼出。 */
  src: string;
  /** 承载页的 Origin：浏览器校验消息来源用。 */
  allowedOrigin: string;
  /** 每次装载生成，宿主与承载页用它把消息配到本次装载。 */
  requestId: string;
};

export function createMemoryServiceEntryRoutes(deps: {
  memoryBaseUrl: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const allowedOrigin = new URL(deps.memoryBaseUrl).origin;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", deps.requireUser);
  app.get("/", (c) => {
    const requestId = randomUUID();
    const base = deps.memoryBaseUrl.replace(/\/$/, "");
    const entry: MemoryServiceEntry = {
      src: `${base}/?embed=1&requestId=${requestId}`,
      allowedOrigin,
      requestId,
    };
    return c.json({ entry });
  });
  return app;
}
