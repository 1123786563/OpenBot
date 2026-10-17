import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import { Hono } from "hono";
import type { Db } from "../db/client";
import type { DocRow, KbRow } from "../handler/shared";
import { apiKeyMiddleware, requestIdMiddleware } from "../middleware/api-key";
import type { AppEnv } from "./app";
import { type BuildRoutesDeps, buildRoutes } from "./routes";

/**
 * 十条路由 HTTP 契约测试：越权 404（不泄漏存在性）、角色 403、hybrid=true
 * 接受、错误体 {code,message,request_id}、wire 投影。查询层与 search 全部
 * 注入桩（不碰真 Postgres/Qdrant）。
 */

const ORIG_ENV = { ...process.env };

function setupApp(overrides: Partial<BuildRoutesDeps> = {}): Hono<AppEnv> {
  process.env.KB_EMBED_MODEL = "test-embed";
  process.env.KB_API_KEYS =
    "sk-admin:tenant-a:admin;sk-read:tenant-a:read;sk-other:tenant-b:admin";

  const kbs = new Map<string, KbRow>();
  const docs = new Map<string, DocRow>();
  kbs.set("kb-a", {
    id: "kb-a",
    tenantId: "tenant-a",
    name: "库A",
    description: "",
    chunkSize: 512,
    chunkOverlap: 80,
    rerankModel: null,
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T08:00:00Z"),
  });
  docs.set("doc-1", {
    id: "doc-1",
    kbId: "kb-a",
    tenantId: "tenant-a",
    title: "手册",
    type: "manual",
    fileName: "",
    fileType: "",
    parseStatus: "finalizing",
    chunkCount: 4,
    metadata: null,
    progress: { chunksTotal: 4, chunksDone: 1, stage: "embed", updatedAt: "x" },
    errorMessage: "",
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T08:00:00Z"),
  });

  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware);
  app.use("*", apiKeyMiddleware);
  buildRoutes(app, {
    db: {} as Db,
    search: async () => ({ results: [], count: 0 }),
    documentIngest: null,
    kbAdmin: null,
    dbQueriesOverride: {
      async getKB(id) {
        return kbs.get(id) ?? null;
      },
      async listKBs(tenantId) {
        return [...kbs.values()].filter((kb) => kb.tenantId === tenantId);
      },
      async docCount(kbId) {
        return [...docs.values()].filter((d) => d.kbId === kbId).length;
      },
      async listDocuments(kbId) {
        return [...docs.values()].filter((d) => d.kbId === kbId);
      },
      async getDocument(docId) {
        return docs.get(docId) ?? null;
      },
    },
    ...overrides,
  });
  return app;
}

async function get(
  app: Hono<AppEnv>,
  path: string,
  key = "sk-admin",
): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${key}` } });
}

async function post(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  key = "sk-read",
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("routes: auth and tenant isolation", () => {
  test("missing api key → 401 with contract error body", async () => {
    const app = setupApp();
    const res = await app.request("/kb");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      code: string;
      message: string;
      request_id: string;
    };
    expect(body.code).toBe("unauthorized");
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
  });

  test("unknown api key → 401", async () => {
    const app = setupApp();
    const res = await get(app, "/kb", "sk-bogus");
    expect(res.status).toBe(401);
  });

  test("cross-tenant KB access → 404 (existence not leaked)", async () => {
    const app = setupApp();
    const res = await get(app, "/kb/kb-a", "sk-other"); // tenant-b admin
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  test("read role calling admin endpoint → 403", async () => {
    const app = setupApp();
    const res = await app.request("/kb", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-read",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "新库" }),
    });
    expect(res.status).toBe(403);
  });

  test("health path bypasses auth middleware (createApp registers the route itself)", async () => {
    // 测试 app 只挂 buildRoutes；/health 由 router/app.ts 的 createApp 注册。
    // 这里验证鉴权中间件对 /health 路径的豁免：直接挂一个同路径处理器。
    const app = setupApp();
    app.get("/health", (c) => c.json({ ok: true }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("routes: GET /kb list and detail", () => {
  test("list returns {items,count} with live doc_count", async () => {
    const app = setupApp();
    const res = await get(app, "/kb", "sk-read");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe("kb-a");
    expect(body.items[0].doc_count).toBe(1);
    expect(body.items[0].chunk_size).toBe(512);
  });

  test("detail of unknown KB → 404", async () => {
    const app = setupApp();
    const res = await get(app, "/kb/nope", "sk-read");
    expect(res.status).toBe(404);
  });
});

describe("routes: documents", () => {
  test("list documents maps manual→text and finalizing→processing", async () => {
    const app = setupApp();
    const res = await get(app, "/kb/kb-a/documents", "sk-read");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      count: number;
    };
    expect(body.items[0].source).toBe("text");
    expect(body.items[0].parse_status).toBe("processing");
  });

  test("document detail cross-tenant → 404", async () => {
    const app = setupApp();
    const res = await get(app, "/kb/kb-a/documents/doc-1", "sk-other");
    expect(res.status).toBe(404);
  });

  test("task endpoint projects doc row: task_id=doc_id, progress percent", async () => {
    const app = setupApp();
    const res = await get(app, "/kb/kb-a/tasks/doc-1", "sk-read");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.task_id).toBe("doc-1");
    expect(body.doc_id).toBe("doc-1");
    expect(body.status).toBe("processing");
    expect(body.progress).toBe(25);
  });

  test("upload before T3 wiring → 501 not_implemented", async () => {
    const app = setupApp();
    const res = await post(
      app,
      "/kb/kb-a/documents",
      { type: "text", content: "x" },
      "sk-admin",
    );
    expect(res.status).toBe(501);
  });
});

describe("routes: POST /kb/:id/retrieve contract", () => {
  test("hybrid=true accepted (never 422); search receives server-side identity", async () => {
    let seen: Record<string, unknown> | null = null;
    const app = setupApp({
      search: async (request) => {
        seen = request as Record<string, unknown>;
        return { results: [], count: 0 };
      },
    });
    const res = await post(app, "/kb/kb-a/retrieve", {
      query: "风险准备金",
      top_k: 5,
      score_threshold: 0,
      hybrid: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; count: number };
    expect(body).toEqual({ results: [], count: 0 });
    expect(seen).not.toBeNull();
    const request = seen as unknown as Record<string, unknown>;
    expect(request.hybrid).toBe(true);
    expect(request.kbIds).toEqual(["kb-a"]);
    expect(request.tenantId).toBe("tenant-a"); // 身份来自 key，非请求体
  });

  test("hybrid omitted defaults true; rerank flag optional", async () => {
    let seen: Record<string, unknown> | null = null;
    const app = setupApp({
      search: async (request) => {
        seen = request as Record<string, unknown>;
        return { results: [], count: 0 };
      },
    });
    await post(app, "/kb/kb-a/retrieve", { query: "q" });
    expect((seen as unknown as Record<string, unknown>).hybrid).toBe(true);
    await post(app, "/kb/kb-a/retrieve", {
      query: "q",
      hybrid: false,
      rerank: true,
    });
    const second = seen as unknown as Record<string, unknown>;
    expect(second.hybrid).toBe(false);
    expect(second.rerank).toBe(true);
  });

  test("blank query → 400 bad_request with error body", async () => {
    const app = setupApp();
    const res = await post(app, "/kb/kb-a/retrieve", { query: "  " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toContain("query");
  });

  test("search failure → 503 unavailable (upstream G4 semantics)", async () => {
    const app = setupApp({
      search: async () => {
        throw new Error("qdrant unreachable");
      },
    });
    const res = await post(app, "/kb/kb-a/retrieve", { query: "q" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unavailable");
  });

  test("cross-tenant retrieve → 404", async () => {
    const app = setupApp();
    const res = await post(
      app,
      "/kb/kb-a/retrieve",
      { query: "q" },
      "sk-other",
    );
    expect(res.status).toBe(404);
  });

  test("invalid JSON body → 400", async () => {
    const app = setupApp();
    const res = await app.request("/kb/kb-a/retrieve", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-read",
        "content-type": "application/json",
      },
      body: "{broken",
    });
    expect(res.status).toBe(400);
  });

  test("x-request-id header echoed back", async () => {
    const app = setupApp();
    const res = await app.request("/kb", {
      headers: {
        authorization: "Bearer sk-read",
        "x-request-id": "req-fixed-123",
      },
    });
    expect(res.headers.get("x-request-id")).toBe("req-fixed-123");
  });
});

// 还原 env（避免污染其他测试的 loadConfig 单例）。
process.env.KB_EMBED_MODEL = ORIG_ENV.KB_EMBED_MODEL;
process.env.KB_API_KEYS = ORIG_ENV.KB_API_KEYS;
