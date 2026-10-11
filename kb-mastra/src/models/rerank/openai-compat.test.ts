import { describe, expect, test } from "bun:test";
import { createOpenAICompatReranker } from "./openai-compat";

/** OpenAI 兼容 rerank 协议：relevance_score/score 双字段、60s 超时语义、错误分类。 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("openai-compat reranker", () => {
  test("relevance_score field takes priority", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        results: [
          { index: 0, relevance_score: 0.91, score: 0.5 },
          { index: 1, relevance_score: 0.42 },
        ],
      });
    }) as unknown as typeof fetch;
    const reranker = createOpenAICompatReranker({ url: "http://r.test/rerank", model: "m", fetchImpl });
    const out = await reranker.rerank("查询", ["文档一", "文档二"]);
    expect(out).toEqual([
      { index: 0, relevanceScore: 0.91 },
      { index: 1, relevanceScore: 0.42 },
    ]);
    // 请求体：model + query + documents（document 为纯字符串数组）
    expect(bodies[0]).toEqual({ model: "m", query: "查询", documents: ["文档一", "文档二"] });
  });

  test("falls back to score field when relevance_score absent", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ results: [{ index: 0, score: 0.77 }] })) as unknown as typeof fetch;
    const reranker = createOpenAICompatReranker({ url: "http://r.test", model: "m", fetchImpl });
    const out = await reranker.rerank("q", ["d"]);
    expect(out[0].relevanceScore).toBe(0.77);
  });

  test("rows without index are dropped", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [{ relevance_score: 0.9 }, { index: 1, relevance_score: 0.4 }],
      })) as unknown as typeof fetch;
    const reranker = createOpenAICompatReranker({ url: "http://r.test", model: "m", fetchImpl });
    const out = await reranker.rerank("q", ["a", "b"]);
    expect(out.length).toBe(1);
    expect(out[0].index).toBe(1);
  });

  test("missing results array throws RerankError", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const reranker = createOpenAICompatReranker({ url: "http://r.test", model: "m", fetchImpl });
    await expect(reranker.rerank("q", ["d"])).rejects.toThrow(/missing results/);
  });

  test("non-2xx carries status and body excerpt", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "quota exceeded" }, 429)) as unknown as typeof fetch;
    const reranker = createOpenAICompatReranker({ url: "http://r.test", model: "m", fetchImpl });
    await expect(reranker.rerank("q", ["d"])).rejects.toThrow(/429/);
  });

  test("model name/id passthrough", () => {
    const reranker = createOpenAICompatReranker({
      url: "http://r.test",
      model: "bge-reranker",
      fetchImpl: (async () => jsonResponse({ results: [] })) as unknown as typeof fetch,
    });
    expect(reranker.getModelName()).toBe("bge-reranker");
    expect(reranker.getModelID()).toBe("bge-reranker");
    expect(reranker.maxPassageRunes?.("q")).toBeUndefined();
  });
});
