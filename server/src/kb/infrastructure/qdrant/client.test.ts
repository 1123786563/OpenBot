import { describe, expect, test } from "bun:test";
import { QdrantClient, QdrantError } from "./client";

/**
 * QA 补盲区：node:http 直连版 QdrantClient 的行为验证。
 * ① Response 形状兼容（ok/status/text/json）② 非 2xx → QdrantError 带 body 摘要
 * ③ 超时 → 504 ④ 连接拒绝 → 503 ⑤ GET collection 404 → null。
 * 用本地起的真实 HTTP 服务（Bun.serve）与不可达端口——不 mock node:http 本身
 * （A 线加固的核心就是要绕开 Bun fetch 的代理劫持，mock fetch 会测不到这条路径）。
 */

function serveOnce(handler: (req: Request) => Response | Promise<Response>): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: { method: string; path: string; body?: string; headers: Record<string, string> }[];
}> {
  const requests: { method: string; path: string; body?: string; headers: Record<string, string> }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.text();
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        body,
        headers: Object.fromEntries(req.headers.entries()),
      });
      return handler(req);
    },
  });
  return Promise.resolve({
    url: `http://127.0.0.1:${server.port}`,
    close: () => Promise.resolve(server.stop(true)),
    requests,
  });
}

describe("node:http QdrantClient 行为", () => {
  test("happy path: JSON parsed, ok/status shape, api-key + content-type headers sent", async () => {
    const svc = await serveOnce(() => Response.json({ result: { points: [] } }));
    try {
      const client = new QdrantClient({ baseUrl: svc.url, apiKey: "secret" });
      const out = await client.queryPoints("c", {
        query: [1],
        filter: { must: [] },
        limit: 1,
        with_payload: true,
      });
      expect(out.result).toEqual({ points: [] });
      expect(svc.requests.length).toBe(1);
      const req = svc.requests[0];
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/collections/c/points/query");
      expect(req.headers["api-key"]).toBe("secret");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(req.body ?? "{}").limit).toBe(1);
    } finally {
      await svc.close();
    }
  });

  test("empty-body 2xx (PUT collection) → {}", async () => {
    const svc = await serveOnce(() => new Response(null, { status: 200 }));
    try {
      const client = new QdrantClient({ baseUrl: svc.url });
      const out: unknown = await client.createCollection("c", {
        vectors: { size: 4, distance: "Cosine" },
        hnswConfig: { m: 16, ef_construct: 64 },
      });
      expect(out).toBeUndefined(); // createCollection 无返回体（request 空 body → {} 由类型承载）
    } finally {
      await svc.close();
    }
  });

  test("non-2xx → QdrantError with status and body excerpt", async () => {
    const svc = await serveOnce(() => new Response('{"status":{"error":"bad"}}', { status: 400 }));
    try {
      const client = new QdrantClient({ baseUrl: svc.url });
      try {
        await client.queryPoints("c", { query: [1], filter: { must: [] }, limit: 1, with_payload: false });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(QdrantError);
        expect((error as QdrantError).status).toBe(400);
        expect((error as QdrantError).message).toContain("bad");
        expect((error as QdrantError).message).toContain("/points/query");
      }
    } finally {
      await svc.close();
    }
  });

  test("getCollection 404 → null; 500 → throws", async () => {
    const svc404 = await serveOnce(() => new Response("nope", { status: 404 }));
    const client404 = new QdrantClient({ baseUrl: svc404.url });
    expect(await client404.getCollection("missing")).toBeNull();
    await svc404.close();

    const svc500 = await serveOnce(() => new Response("boom", { status: 500 }));
    const client500 = new QdrantClient({ baseUrl: svc500.url });
    await expect(client500.getCollection("c")).rejects.toThrow(QdrantError);
    await svc500.close();
  });

  test("connection refused → QdrantError 503 (unreachable semantics)", async () => {
    // 找一个几乎必然无监听的端口：先占后释放
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probe.port;
    await probe.stop(true);
    const client = new QdrantClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2_000 });
    try {
      await client.getCollection("c");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QdrantError);
      expect((error as QdrantError).status).toBe(503);
    }
  });

  test("timeout → QdrantError 504", async () => {
    // 服务端挂起不响应：1s 后 client 超时（timeoutMs=100）
    const svc = await serveOnce(
      () => new Promise<Response>(() => { /* never resolves */ }),
    );
    try {
      const client = new QdrantClient({ baseUrl: svc.url, timeoutMs: 100 });
      // 超时必须折 504（AbortError 名）——与连接拒绝的 503 区分（QA 修复点）
      try {
        await client.getCollection("c");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(QdrantError);
        expect((error as QdrantError).status).toBe(504);
        expect((error as QdrantError).message).toMatch(/timed out/);
      }
    } finally {
      await svc.close();
    }
  });

  test("upsert points carries ?wait=true and points body", async () => {
    const svc = await serveOnce(() => new Response(null, { status: 200 }));
    try {
      const client = new QdrantClient({ baseUrl: svc.url });
      await client.upsertPoints("c", [
        { id: "558701d7-762c-4996-bc45-4b3258a784ef", vector: [0.1], payload: { tenant_id: "t" } },
      ]);
      expect(svc.requests[0].path).toBe("/collections/c/points?wait=true");
      const body = JSON.parse(svc.requests[0].body ?? "{}");
      expect(body.points.length).toBe(1);
      expect(body.points[0].payload.tenant_id).toBe("t");
    } finally {
      await svc.close();
    }
  });

  test("countPoints unwraps result.count", async () => {
    const svc = await serveOnce(() => Response.json({ result: { count: 7 } }));
    try {
      const client = new QdrantClient({ baseUrl: svc.url });
      expect(await client.countPoints("c")).toBe(7);
      expect(svc.requests[0].path).toBe("/collections/c/points/count");
    } finally {
      await svc.close();
    }
  });
});
