import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/public";
import { createMemoryServiceEntryRoutes } from "../src/memory-service/entry-routes";

/*
 * #731 承载入口：地址与允许 Origin 只来自部署配置，每次装载一个新 requestId；
 * 不返回令牌或服务秘密。requireUser 是部署自己的守卫，这里用同形状的桩。
 */

const BASE = "https://memory.example";

function fixture(options: { signedIn: boolean }) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    if (!options.signedIn) return c.json({ error: "Unauthorized" }, 401);
    return next();
  };
  const app = new Hono();
  app.route(
    "/api/memory-service/entry",
    createMemoryServiceEntryRoutes({ memoryBaseUrl: BASE, requireUser }),
  );
  return app;
}

const get = (app: Hono, path = "/api/memory-service/entry") =>
  app.fetch(new Request(`https://openbot.example${path}`));

describe("entry", () => {
  test("未登录不返回承载信息", async () => {
    const response = await get(fixture({ signedIn: false }));
    expect(response.status).toBe(401);
  });

  test("地址、允许 Origin 与 requestId 来自服务器，每次装载各不相同", async () => {
    const app = fixture({ signedIn: true });
    const first = await get(app);
    expect(first.status).toBe(200);
    const one = (await first.json()) as {
      entry: { src: string; allowedOrigin: string; requestId: string };
    };
    expect(one.entry.allowedOrigin).toBe(BASE);
    expect(one.entry.src.startsWith(`${BASE}/?embed=1&requestId=`)).toBe(true);
    expect(one.entry.src).toContain(one.entry.requestId);
    // 响应里没有令牌或服务秘密。
    expect(Object.keys(one.entry).sort()).toEqual([
      "allowedOrigin",
      "requestId",
      "src",
    ]);

    const second = await get(app);
    const two = (await second.json()) as { entry: { requestId: string } };
    expect(two.entry.requestId).not.toBe(one.entry.requestId);
  });

  test("承载页路径前缀保留：部署在子路径时地址仍是配置的那一个", async () => {
    const app = new Hono();
    app.route(
      "/api/memory-service/entry",
      createMemoryServiceEntryRoutes({
        memoryBaseUrl: "https://memory.example/tenant-a/",
        requireUser: async (_c, next) => next(),
      }),
    );
    const body = (await (await get(app)).json()) as {
      entry: { src: string; allowedOrigin: string };
    };
    expect(body.entry.src).toBe(
      `https://memory.example/tenant-a/?embed=1&requestId=${body.entry.src.split("requestId=")[1]}`,
    );
    expect(body.entry.allowedOrigin).toBe("https://memory.example");
  });
});
