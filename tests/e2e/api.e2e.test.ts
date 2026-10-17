/**
 * API 端到端测试（bun:test，直接 fetch 本地服务端）。
 *
 * 覆盖范围（按测试计划）：
 *  1. 公开端点的 200 契约（/health、/api/capabilities）；
 *  2. 鉴权负路径：无 cookie 时受保护路由必须 401（本部署 Casdoor OAuth 已配置、
 *     各依赖 store 均已挂载，因此全部按计划修订约定 (1) 断言 401，而非 404）；
 *  3. WS 升级负路径：requireUser 在 upgradeWebSocket 之前（channels/routes.ts:1077），
 *     无会话的 GET /api/channels/events 直接以 401 JSON 拒绝，不会进入升级流程；
 *  4. 仅在 OPENBOT_INTERNAL_TOKEN 未配置时不挂载的 /internal/routines/run
 *     断言 404（app.ts:1244 条件挂载），并注释说明该功能未启用。
 *
 * 鉴权后的写路径与闭环流程按计划交由浏览器套件在 http://localhost:3010 真实登录
 * （admin/123）走通——Casdoor OAuth 无法纯 API 建立会话，本套件不含登录态正向用例。
 * 负路径与正向组共用的端点（/api/agents、/api/plugins 等）在本套件中仅存在于独立的、
 * 无 cookie 的客户端（每次请求新建 fetch，不携带任何 Cookie 头），与浏览器套件的登录态
 * 客户端互不复用连接与 cookie。
 */

import { describe, expect, test } from "bun:test";

const BASE_URL = process.env.OPENBOT_API_BASE_URL ?? "http://127.0.0.1:3001";

/**
 * 每次调用都用一个全新请求、显式不带 Cookie——保证任何 401 都来自鉴权失败，
 * 而不是客户端状态污染。只允许打这个本地 http 服务。
 */
async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, BASE_URL);
  if (url.protocol !== "http:") {
    throw new Error(`只允许 http 请求，收到 ${url.protocol}`);
  }
  return fetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...(init.headers ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// 1. 健康与公开能力（app.ts:496 / app.ts:500，无鉴权）
// ---------------------------------------------------------------------------

describe("健康与公开能力", () => {
  test("GET /health → 200 且声明 status=ok", async () => {
    const res = await raw("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: unknown };
    expect(body.status).toBe("ok");
  });

  test("GET /api/capabilities → 200 且契约字段齐全、类型正确", async () => {
    const res = await raw("/api/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // 投影契约：只允许这些字段出现，绝不能把 runtime 配置整体倒出来。
    const allowed = [
      "mode",
      "durableHistory",
      "generativeUi",
      "selfHostBanner",
      "transcription",
      "voice",
      "authProviders",
      "ssoConfigured",
      "ssoRequired",
      "billing",
    ] as const;
    expect(Object.keys(body).sort()).toEqual([...allowed].sort());

    expect(typeof body.mode).toBe("string");
    expect((body.mode as string).length).toBeGreaterThan(0);
    expect(typeof body.durableHistory).toBe("boolean");
    expect(typeof body.generativeUi).toBe("boolean");
    expect(typeof body.selfHostBanner).toBe("boolean");
    expect(typeof body.transcription).toBe("boolean");
    expect(typeof body.voice).toBe("boolean");
    expect(Array.isArray(body.authProviders)).toBe(true);
    for (const provider of body.authProviders as unknown[]) {
      expect(typeof provider).toBe("string");
    }
    expect(typeof body.ssoConfigured).toBe("boolean");
    expect(typeof body.ssoRequired).toBe("boolean");

    const billing = body.billing as Record<string, unknown> | undefined;
    expect(billing).toBeDefined();
    expect(typeof billing?.enabled).toBe("boolean");
    expect(typeof billing?.paid).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// 2. 鉴权负路径（无 cookie，预期 401）
//
// 修订约定 (1)：本部署所有受保护路由都已挂载（Casdoor 配置齐全、依赖 store 在场），
// 因此一律断言 401。仅 /internal/routines/run 因条件挂载未生效而 404，单独成组。
// ---------------------------------------------------------------------------

const PROTECTED_GET_PATHS: Array<[string, string]> = [
  ["/api/me", "app.ts 直挂 requireUser"],
  ["/api/agents", "agents/routes.ts 挂载 /api/agents"],
  ["/api/channels", "channels/routes.ts 挂载 /api/channels"],
  ["/api/threads/mint", "thread-routes.ts 挂载 /api/threads"],
  ["/api/routines", "routines/routes.ts 挂载 /api/routines"],
  ["/api/approvals", "approvals/routes.ts 挂载 /api/approvals"],
  ["/api/plugins", "plugins/routes.ts 挂载 /api/plugins"],
  ["/api/admin/status", "app.ts:849 管理后台"],
  ["/api/admin/people", "管理后台人员"],
  ["/api/settings/instructions", "app.ts 个人 standing instructions"],
  ["/api/computers/fleet", "computer/routes.ts 挂载 /api/computers"],
  ["/api/memory", "挂载 /api/memory"],
  ["/api/bots/attention", "agents/lifecycle-routes.ts 挂载 /api/bots"],
  ["/api/bots/routing", "agents/lifecycle-routes.ts 挂载 /api/bots"],
  ["/api/responsibilities", "挂载 /api/responsibilities"],
  ["/api/proactive/settings", "挂载 /api/proactive"],
  ["/api/proactive/suggestions", "挂载 /api/proactive"],
  ["/api/components", "挂载 /api/components"],
  ["/api/demonstrations", "挂载 /api/demonstrations"],
  ["/api/team-bots", "挂载 /api/team-bots"],
  ["/api/passwords", "挂载 /api/passwords"],
  ["/api/delivery", "delivery/routes.ts 挂载 /api/delivery"],
  ["/api/host-access", "挂载 /api/host-access（app.ts:1362）"],
  ["/api/voice/config", "挂载 /api/voice（app.ts:687）"],
  ["/api/admin/audit-events", "管理后台审计"],
  ["/api/admin/identity-providers", "管理后台身份提供方"],
  ["/api/admin/credentials", "管理后台凭据"],
  ["/api/admin/package", "管理后台包信息"],
  ["/api/admin/learning/overview", "挂载 /api/admin/learning（app.ts:838）"],
  ["/api/admin/learning/settings", "挂载 /api/admin/learning（app.ts:838）"],
  ["/api/admin/enterprise/me", "挂载 /api/admin/enterprise（app.ts:670）"],
  ["/api/billing/entitlements", "billing/routes.ts 挂载 /api/billing"],
  ["/api/billing/usage", "billing/routes.ts 挂载 /api/billing"],
];

describe("鉴权负路径（无 cookie，预期 401）", () => {
  for (const [path, where] of PROTECTED_GET_PATHS) {
    test(`GET ${path} → 401（${where}）`, async () => {
      const res = await raw(path);
      expect(res.status).toBe(401);
      // 401 必须是 JSON 错误体，而不是把受保护数据漏给未登录者。
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
    });
  }

  test("无 cookie 时对写方法同样拒绝：POST /api/agents → 401", async () => {
    const res = await raw("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e-should-not-create" }),
    });
    // 鉴权在业务处理之前：无论 body 合法与否，都先 401，且绝不创建任何资源。
    expect(res.status).toBe(401);
  });

  test("DELETE /api/admin/credentials → 404（该路由在当前代码中不存在）", async () => {
    // 计划中列了 DELETE /api/admin/credentials（app.ts:1089），但实际代码
    // （server/src/app.ts:1126-1210）只有 GET/POST /api/admin/credentials 与
    // rotate/revoke 子路由，不存在集合级 DELETE——404 说明不存在可被未登录者
    // 触发的删除入口；凭据的移除走 POST .../revoke，且必须登录。
    const res = await raw("/api/admin/credentials", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("无 cookie 时凭据读取仍拒绝：GET /api/admin/credentials → 401", async () => {
    const res = await raw("/api/admin/credentials");
    expect(res.status).toBe(401);
  });

  test("无 cookie 时 POST /api/me/onboarding → 401", async () => {
    const res = await raw("/api/me/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    expect(res.status).toBe(401);
  });

  test("WS 升级负路径：GET /api/channels/events 无会话 → 升级被拒（401 JSON，不进入升级）", async () => {
    // channels/routes.ts:1077：requireUser 在 upgradeWebSocket 之前，
    // 所以未登录的请求（即使带 Upgrade 头）拿不到 101，而是 401 JSON。
    const res = await raw("/api/channels/events", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
  });

  test("内部触发器无共享密钥：POST /internal/routines/run → 401（绝不触发例程）", async () => {
    // app.ts:1244 附近：该路由在 routineRunner 存在时挂载，但凭据是共享密钥
    // （workerSharedSecret）而非用户会话。本部署未配置密钥时，代码在比较前
    // 直接拒绝，且与"密钥错误"返回完全一致（防止探测）。401 表示边界被守住，
    // 绝不会触发任何例程执行。
    const res = await raw("/internal/routines/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routineId: "e2e-nonexistent" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
  });

  test("未登录下伪造他人资源路径同样 401：GET /api/agents/e2e-other-agent → 401", async () => {
    const res = await raw("/api/agents/e2e-other-agent");
    expect(res.status).toBe(401);
  });

  test("未知路径与契约无关：GET /api/definitely-not-a-route → 404", async () => {
    // 对照组：证明上面的 401 来自鉴权中间件，而不是本套件对所有路径一律报错。
    const res = await raw("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
  });
});
