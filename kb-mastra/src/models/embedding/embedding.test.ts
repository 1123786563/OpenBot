import { describe, expect, test } from "bun:test";
import { createBatchEmbedder, DEFAULT_BATCH_EMBED_SIZE } from "./batch";
import type { Embedder } from "./embedder";
import { createLimiter, DEFAULT_EMBED_MAX_CONCURRENCY, withConcurrency } from "./concurrency";
import { createOllamaEmbedder } from "./ollama";
import { createEmbedTransport } from "./transport";

/** embedding 层：分批快停、并发限流、双协议 transport。 */

function countingEmbedder(vectors: number[][]): { embedder: Embedder; batchCalls: string[][] } {
  const batchCalls: string[][] = [];
  const embedder: Embedder = {
    async embed() {
      return vectors[0];
    },
    async batchEmbed(texts: string[]) {
      batchCalls.push(texts);
      return texts.map((_, i) => vectors[i % vectors.length]);
    },
    getModelName: () => "test-model",
    getDimensions: () => vectors[0]?.length ?? 0,
    getModelID: () => "test-model",
  };
  return { embedder, batchCalls };
}

describe("batch", () => {
  test("default batch size 5", () => {
    expect(DEFAULT_BATCH_EMBED_SIZE).toBe(5);
  });

  test("splits into batches of batchSize, order preserved", async () => {
    const { embedder, batchCalls } = countingEmbedder([[1, 2]]);
    const batched = createBatchEmbedder(embedder, { batchSize: 2 });
    const out = await batched.batchEmbed(["a", "b", "c", "d", "e"]);
    expect(out.length).toBe(5);
    expect(batchCalls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(out.every((v) => v.length === 2)).toBe(true);
  });

  test("empty input short-circuits", async () => {
    const { embedder, batchCalls } = countingEmbedder([[1]]);
    const batched = createBatchEmbedder(embedder);
    expect(await batched.batchEmbed([])).toEqual([]);
    expect(batchCalls).toEqual([]);
  });

  test("failing batch stops subsequent batches (fail fast)", async () => {
    let calls = 0;
    const failing: Embedder = {
      async embed() {
        return [1];
      },
      async batchEmbed() {
        calls += 1;
        if (calls === 2) throw new Error("batch 2 failed");
        return [[1]];
      },
      getModelName: () => "m",
      getDimensions: () => 1,
      getModelID: () => "m",
    };
    const batched = createBatchEmbedder(failing, { batchSize: 1 });
    await expect(batched.batchEmbed(["a", "b", "c", "d"])).rejects.toThrow("batch 2 failed");
    expect(calls).toBe(2); // 第 3、4 批未发出
  });

  test("length mismatch between request and vectors throws", async () => {
    const bad: Embedder = {
      async embed() {
        return [1];
      },
      async batchEmbed(texts) {
        return texts.slice(0, 1).map(() => [1]);
      },
      getModelName: () => "m",
      getDimensions: () => 1,
      getModelID: () => "m",
    };
    const batched = createBatchEmbedder(bad, { batchSize: 5 });
    await expect(batched.batchEmbed(["a", "b", "c"])).rejects.toThrow(/expected 3 vectors/);
  });
});

describe("concurrency limiter", () => {
  test("default 32", () => {
    expect(DEFAULT_EMBED_MAX_CONCURRENCY).toBe(32);
  });

  test("caps in-flight tasks, all complete", async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("withConcurrency accepts both limit and maxConcurrency option names", async () => {
    const inner = countingEmbedder([[0.5]]).embedder;
    const a = withConcurrency(inner, { limit: 3 });
    const b = withConcurrency(inner, { maxConcurrency: 4 });
    expect(await a.embed("x")).toEqual([0.5]);
    expect(await b.embed("x")).toEqual([0.5]);
  });
});

describe("transport (dual protocol)", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("ollama /api/embed single prompt shape; vector from embedding field", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ embedding: [0.1, 0.2] });
    }) as unknown as typeof fetch;
    const transport = createEmbedTransport({
      baseUrl: "http://ollama.test",
      model: "m",
      protocol: "ollama",
      fetchImpl,
    });
    expect(await transport.embed("你好")).toEqual([0.1, 0.2]);
    expect(bodies[0]).toEqual({ model: "m", prompt: "你好" });
  });

  test("ollama batch input shape; vectors from embeddings field", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ embeddings: [[1], [2]] });
    }) as unknown as typeof fetch;
    const transport = createEmbedTransport({
      baseUrl: "http://ollama.test",
      model: "m",
      protocol: "ollama",
      fetchImpl,
    });
    expect(await transport.embedBatch(["a", "b"])).toEqual([[1], [2]]);
    expect(bodies[0]).toEqual({ model: "m", input: ["a", "b"] });
  });

  test("openai /v1/embeddings shape; data ordered by index", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      // 乱序返回验证 index 复原
      return jsonResponse({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      });
    }) as unknown as typeof fetch;
    const transport = createEmbedTransport({
      baseUrl: "http://gateway.test",
      model: "m",
      protocol: "openai",
      fetchImpl,
    });
    expect(await transport.embedBatch(["a", "b"])).toEqual([[1], [2]]);
    expect(bodies[0]).toEqual({ model: "m", input: ["a", "b"] });
  });

  test("probe falls back to openai when ollama 404s", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (url: string) => {
      paths.push(url);
      if (url.endsWith("/api/embed")) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ data: [{ index: 0, embedding: [9] }] });
    }) as unknown as typeof fetch;
    const transport = createEmbedTransport({
      baseUrl: "http://mixed.test",
      model: "m",
      fetchImpl,
    });
    expect(await transport.embed("q")).toEqual([9]);
    expect(paths[0].endsWith("/api/embed")).toBe(true);
    expect(paths[1].endsWith("/v1/embeddings")).toBe(true);
  });

  test("unreachable endpoint throws EmbedTransportError", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const transport = createEmbedTransport({
      baseUrl: "http://dead.test",
      model: "m",
      fetchImpl,
    });
    await expect(transport.embed("q")).rejects.toThrow(/unreachable|cannot reach/);
  });
});

describe("ollama embedder adapter", () => {
  test("dimensions observed from first vector when not declared", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ embedding: [1, 2, 3, 4] }), { status: 200 })) as unknown as typeof fetch;
    const embedder = createOllamaEmbedder({
      baseUrl: "http://o.test",
      model: "m",
      protocol: "ollama",
      fetchImpl,
    });
    expect(embedder.getDimensions()).toBe(0);
    await embedder.embed("x");
    expect(embedder.getDimensions()).toBe(4);
    expect(embedder.getModelName()).toBe("m");
    expect(embedder.getModelID()).toBe("m");
  });

  test("declared dimensions reported without a call", () => {
    const embedder = createOllamaEmbedder({
      baseUrl: "http://o.test",
      model: "m",
      dimensions: 1024,
      protocol: "ollama",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(embedder.getDimensions()).toBe(1024);
  });
});
