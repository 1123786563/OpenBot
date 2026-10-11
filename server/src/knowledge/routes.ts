/**
 * KB-Service 的 REST 代理路由，挂载在 `/api/knowledge` 下。
 *
 * 前端只和 OpenBot 自己的 `/api/*` 说话（复用 better-auth 的 cookie session），
 * 本路由再以服务间 API Key 转发到 KB-Service。这样：
 *   - 鉴权全链路统一为 OpenBot 的 session，前端不接触 KB-Service 的密钥；
 *   - 上游的 404/403/409/422 等状态与错误信息原样透传给前端。
 *
 * 请求体（JSON 或 multipart 文件）不做解释地透传，只注入鉴权头。
 */
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import {
  KnowledgeServiceError,
  KnowledgeServiceUnavailableError,
  knowledgeRequest,
} from "./client";
import type { KnowledgeServiceConfig } from "./config";

const log = getLogger("server");

export function createKnowledgeRoutes(
  config: KnowledgeServiceConfig | null,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof KnowledgeServiceError) {
      return context.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
    log.error(
      {
        type: "knowledge-route-error",
        error: error.name,
        path: context.req.path,
      },
      "knowledge-route-error",
    );
    return context.json({ error: "Knowledge is unavailable. Try again." }, 503);
  });

  /** 配置缺失时抛 503，让 onError 统一应答。 */
  const requireConfig = () => {
    if (!config) throw new KnowledgeServiceUnavailableError();
    return config;
  };

  /** 透传原始请求到 KB-Service（只换鉴权头，body/content-type 原样转发）。 */
  const pass = (
    context: Context<{ Variables: AppVariables }>,
    upstreamPath: string,
    method: string,
  ): Promise<Response> => {
    const raw = context.req.raw;
    const headers: Record<string, string> = {};
    const contentType = raw.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;

    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && raw.body) {
      init.body = raw.body;
    }
    return knowledgeRequest(requireConfig(), upstreamPath, init);
  };

  const relay = async (
    context: Context<{ Variables: AppVariables }>,
    upstreamPath: string,
    method: string,
  ) => {
    const response = await pass(context, upstreamPath, method);
    return context.json(
      await response.json(),
      response.status as ContentfulStatusCode,
    );
  };

  // ---- 知识库生命周期 ----
  routes.get("/kb", (context) => relay(context, "/kb", "GET"));
  routes.post("/kb", (context) => relay(context, "/kb", "POST"));
  routes.get("/kb/:id", (context) =>
    relay(context, `/kb/${context.req.param("id")}`, "GET"),
  );
  routes.delete("/kb/:id", (context) =>
    relay(context, `/kb/${context.req.param("id")}`, "DELETE"),
  );

  // ---- 文档 ----
  routes.get("/kb/:id/documents", (context) =>
    relay(context, `/kb/${context.req.param("id")}/documents`, "GET"),
  );
  routes.post("/kb/:id/documents", (context) =>
    relay(context, `/kb/${context.req.param("id")}/documents`, "POST"),
  );
  routes.get("/kb/:id/documents/:docId", (context) =>
    relay(
      context,
      `/kb/${context.req.param("id")}/documents/${context.req.param("docId")}`,
      "GET",
    ),
  );
  routes.delete("/kb/:id/documents/:docId", (context) =>
    relay(
      context,
      `/kb/${context.req.param("id")}/documents/${context.req.param("docId")}`,
      "DELETE",
    ),
  );

  // ---- 异步任务与检索 ----
  routes.get("/kb/:id/tasks/:taskId", (context) =>
    relay(
      context,
      `/kb/${context.req.param("id")}/tasks/${context.req.param("taskId")}`,
      "GET",
    ),
  );
  routes.post("/kb/:id/retrieve", (context) =>
    relay(context, `/kb/${context.req.param("id")}/retrieve`, "POST"),
  );

  return routes;
}
