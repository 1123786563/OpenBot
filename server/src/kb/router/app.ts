/**
 * HTTP 应用：Hono 直接承载（不经 Mastra CLI）。
 *
 * 为什么不用 `mastra dev/start`：CLI 的 dev 流程要解包 studio 产物（数百个
 * 文件）并交互确认清理，容器/CI 不可交互；而 kb-mastra 只需要十条路由 +
 * 中间件，@mastra/core 的 server 配置最终也落在 Hono 上（core 的依赖）。
 * 自建 Hono app = 同样的路由语义 + bun 原生 serve，零 CLI 依赖。
 *
 * Mastra 实例（src/mastra/index.ts）仍存在：T04+ 若挂 Mastra 管理的 agent
 * 能力（/agents 等内部路由）再接 getServerApp；本期知识库路由全部自管。
 */

import { Hono } from "hono";
import { getLogger } from "../../../../shared/logger";
import {
  apiKeyMiddleware,
  errorBody,
  requestIdMiddleware,
} from "../middleware/api-key";

const log = getLogger("kb");

/** context 变量：鉴权中间件写入、handler 读取（同 Mastra middleware 语义）。 */
export type AppEnv = {
  Variables: {
    kbIdentity: unknown;
    kbRequestId: string;
  };
};

/**
 * 构建 kb-mastra 的 Hono 应用。中间件链与设计 §2 一致：
 * requestId（生成/透传 x-request-id + 访问日志 + panic 兜底）→ Bearer 鉴权
 * （/health 豁免）→ 路由。错误体统一 {code, message, request_id}。
 *
 * routes 装配由调用方决定：index.ts 传 buildRoutes（十条路由全量），
 * 测试可只挂中间件自己注册路由。
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestIdMiddleware);
  app.use("*", apiKeyMiddleware);

  // 健康检查：compose healthcheck 无 token，鉴权中间件内部豁免。
  app.get("/health", (context) =>
    context.json({ ok: true, service: "kb-mastra" }),
  );

  // 404 兜底带契约错误体（十条路由由调用方经 buildRoutes 挂载）。
  app.notFound((context) => {
    const requestId = context.get("kbRequestId") ?? "";
    return context.json(
      errorBody(requestId, "not_found", "route not found"),
      404,
    );
  });

  app.onError((error, context) => {
    const requestId = context.get("kbRequestId") ?? "";
    log.error(
      {
        type: "kb-request-error",
        requestId,
        error: error.name,
        path: context.req.path,
      },
      "kb-request-error",
    );
    return context.json(
      errorBody(requestId, "internal", "internal server error"),
      500,
    );
  });

  return app;
}
