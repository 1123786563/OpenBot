import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { OpenBotMemorySourceCheck, SourceCheck } from "./source-check";

/*
 * #730 来源应用端点：MEMORY 在采集/召回/审核前向 OpenBot 核验来源。
 * 服务身份鉴权（服务令牌），输入按合同形状校验；身份字段不会被请求体自报
 * 通过——source check 用 OpenBot 自己签发的来源引用判定。
 */

export function mountMemoryServiceRoutes(
  app: Hono,
  deps: { check: OpenBotMemorySourceCheck; serviceToken: string },
): void {
  const authorized = (request: Request): boolean => {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return false;
    const token = Buffer.from(header.slice(7));
    const expected = Buffer.from(deps.serviceToken);
    return token.length === expected.length && timingSafeEqual(token, expected);
  };

  app.post("/api/memory-service/source-check", async (c) => {
    if (!authorized(c.req.raw)) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }
    const body = (await c.req
      .json()
      .catch(() => null)) as Partial<SourceCheck> | null;
    const wellFormed =
      body !== null &&
      typeof body.requestId === "string" &&
      typeof body.subjectId === "string" &&
      typeof body.originAppId === "string" &&
      typeof body.consumerAppId === "string" &&
      (body.action === "collect" ||
        body.action === "recall" ||
        body.action === "review") &&
      (body.versionId === null || typeof body.versionId === "string") &&
      body.source !== undefined &&
      typeof body.source.originAppId === "string" &&
      typeof body.source.scopeRef === "string";
    if (!wellFormed) {
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    return c.json(
      await deps.check.checkOpenBotMemorySource({
        requestId: body.requestId,
        subjectId: body.subjectId,
        originAppId: body.originAppId,
        consumerAppId: body.consumerAppId,
        action: body.action,
        versionId: body.versionId ?? null,
        source: {
          originAppId: body.source.originAppId,
          scopeRef: body.source.scopeRef,
        },
      }),
    );
  });
}
