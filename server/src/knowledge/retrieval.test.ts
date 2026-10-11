import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KnowledgeCircuit } from "./circuit";
import { createKnowledgeCircuit } from "./circuit";
import {
  createKnowledgeRetriever,
  knowledgeRetrievalOptionsFromEnv,
} from "./retrieval";
import type { KnowledgeSearchResult, RetrieveResponse } from "./types";

/**
 * 全局 fetch mock：不起真实服务。retrieval 层经 client.ts 的 knowledgeRequest
 * 走全局 fetch，mock 住它就 mock 住了整条上游链路（Bearer 头与超时折叠逻辑属
 * client.ts，不在本测试的职责内）。
 */
const realFetch = globalThis.fetch;
let fetchImpl:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function result(
  overrides: Partial<KnowledgeSearchResult>,
): KnowledgeSearchResult {
  return {
    chunk_id: "chunk-1",
    doc_id: "doc-1",
    content: "some content",
    score: 0.5,
    source: "manual",
    ...overrides,
  };
}

/** 记录每次调用便于断言请求体与路径。 */
const calls: { url: string; init: RequestInit | undefined }[] = [];

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init,
    });
    if (!fetchImpl) throw new Error("no fetch behaviour installed for test");
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchImpl = null;
});

const config = {
  baseUrl: "http://kb.test",
  apiKey: "secret",
  timeoutMs: 10_000,
};

function retriever(options: {
  kbIds?: string[];
  topK?: number;
  timeoutMs?: number;
  scoreThreshold?: number;
  circuit?: KnowledgeCircuit;
}) {
  return createKnowledgeRetriever(
    config,
    {
      kbIds: options.kbIds ?? ["kb1"],
      topK: options.topK ?? 5,
      timeoutMs: options.timeoutMs ?? 1500,
      scoreThreshold: options.scoreThreshold ?? 0,
    },
    options.circuit ?? createKnowledgeCircuit(),
  );
}

describe("knowledgeRetrievalOptionsFromEnv", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "KB_RETRIEVAL_KB_IDS",
    "KB_RETRIEVAL_TOP_K",
    "KB_RETRIEVAL_TIMEOUT_MS",
    "KB_RETRIEVAL_SCORE_THRESHOLD",
  ];

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("null when KB_RETRIEVAL_KB_IDS is empty: retrieval entirely off", () => {
    expect(knowledgeRetrievalOptionsFromEnv()).toBeNull();
    process.env.KB_RETRIEVAL_KB_IDS = " , ,, ";
    expect(knowledgeRetrievalOptionsFromEnv()).toBeNull();
  });

  test("splits, trims and drops empty ids, and applies defaults", () => {
    process.env.KB_RETRIEVAL_KB_IDS = " kb1 , kb2 ,";
    expect(knowledgeRetrievalOptionsFromEnv()).toEqual({
      kbIds: ["kb1", "kb2"],
      topK: 5,
      timeoutMs: 1500,
      scoreThreshold: 0,
    });
  });

  test("clamps overrides into range", () => {
    process.env.KB_RETRIEVAL_KB_IDS = "kb1";
    process.env.KB_RETRIEVAL_TOP_K = "99";
    process.env.KB_RETRIEVAL_TIMEOUT_MS = "1";
    process.env.KB_RETRIEVAL_SCORE_THRESHOLD = "0.7";
    expect(knowledgeRetrievalOptionsFromEnv()).toEqual({
      kbIds: ["kb1"],
      topK: 10,
      timeoutMs: 100,
      scoreThreshold: 0.7,
    });
  });
});

describe("knowledge retriever", () => {
  test("hit: merges, orders by score desc, numbers chunks 1..n, wraps envelope", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: [
          result({ chunk_id: "c-low", content: "low", score: 0.1 }),
          result({ chunk_id: "c-high", content: "high", score: 0.9 }),
        ],
        count: 2,
      } satisfies RetrieveResponse);
    const outcome = await retriever({}).retrieve("risk policy");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.map((c) => c.chunkId)).toEqual(["c-high", "c-low"]);
    expect(outcome.chunks.map((c) => c.index)).toEqual([1, 2]);
    // 信封：markUntrusted 单一包裹 + 头尾使用规则。
    expect(outcome.block).toContain(
      "[检索资料] 以下是知识库检索返回的参考资料：",
    );
    expect(outcome.block).toContain(
      '<untrusted_data source="knowledge base retrieval">',
    );
    expect(outcome.block).toContain("[1] 来源: manual | score: 0.900");
    expect(outcome.block).toContain(
      "使用规则：引用某条资料时在句末标注对应序号",
    );
  });

  test("queries each kb concurrently and passes retrieval parameters", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    await retriever({ kbIds: ["kb1", "kb2"], scoreThreshold: 0.3 }).retrieve(
      "hello",
    );
    expect(calls.map((c) => c.url)).toEqual([
      "http://kb.test/kb/kb1/retrieve",
      "http://kb.test/kb/kb2/retrieve",
    ]);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      query: "hello",
      top_k: 5,
      score_threshold: 0.3,
      hybrid: true,
    });
  });

  test("miss: 200 with empty results does not trip the circuit", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    const outcome = await retriever({}).retrieve("nothing matches");
    expect(outcome).toEqual({ status: "miss" });
  });

  test("blank query short-circuits to miss without calling upstream", async () => {
    const outcome = await retriever({}).retrieve("   ");
    expect(outcome).toEqual({ status: "miss" });
    expect(calls.length).toBe(0);
  });

  test("query is trimmed, whitespace-collapsed and capped at 512 chars", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    await retriever({}).retrieve(`  ${"a".repeat(510)}  b\t c  `);
    const body = JSON.parse(String(calls[0]?.init?.body));
    // 折叠空白后 = 510 个 a + " b c" = 513 字符 → 截到 512。
    expect((body.query as string).length).toBe(512);
    expect(body.query).toBe(`${"a".repeat(510)} b`);
    // 短查询：trim + 空白折叠生效。
    await retriever({}).retrieve("  多个   空格\t和\n换行  ");
    const second = JSON.parse(String(calls[1]?.init?.body));
    expect(second.query).toBe("多个 空格 和 换行");
  });

  test("503 counts toward the circuit and degrades as unavailable", async () => {
    const circuit = createKnowledgeCircuit();
    fetchImpl = async () => jsonResponse({ message: "down" }, 503);
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "unavailable" });
    expect(circuit.state()).toBe("closed");
    await retriever({ circuit }).retrieve("q");
    await retriever({ circuit }).retrieve("q");
    expect(circuit.state()).toBe("open");
  });

  test("429 counts toward the circuit (upstream pressure signal)", async () => {
    const circuit = createKnowledgeCircuit({ failureThreshold: 1 });
    fetchImpl = async () => jsonResponse({ message: "slow down" }, 429);
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "unavailable" });
    expect(circuit.state()).toBe("open");
  });

  test("4xx does not count toward the circuit (configuration-class error)", async () => {
    const circuit = createKnowledgeCircuit({ failureThreshold: 1 });
    fetchImpl = async () => jsonResponse({ message: "no such kb" }, 404);
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome.status).toBe("degraded");
    expect(circuit.state()).toBe("closed");
  });

  test("one kb failing while another answers: partial success still hits", async () => {
    fetchImpl = async (input) =>
      String(input).endsWith("/kb/kb1/retrieve")
        ? jsonResponse({ message: "gone" }, 404)
        : jsonResponse({
            results: [
              result({ chunk_id: "c2", content: "from kb2", score: 0.7 }),
            ],
            count: 1,
          });
    const outcome = await retriever({ kbIds: ["kb1", "kb2"] }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.map((c) => c.kbId)).toEqual(["kb2"]);
  });

  test("all kbs failing degrades; slow failures read as timeout", async () => {
    // 超时分类依赖耗时近似（A5）：mock 一个确实超过 timeoutMs 的失败响应。
    fetchImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return jsonResponse({ message: "down" }, 503);
    };
    const outcome = await retriever({ timeoutMs: 100 }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "timeout" });
  });

  test("all kbs failing fast reads as unavailable", async () => {
    fetchImpl = async () => jsonResponse({ message: "down" }, 503);
    const outcome = await retriever({ timeoutMs: 1500 }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "unavailable" });
  });

  test("open circuit refuses without calling upstream", async () => {
    const circuit = createKnowledgeCircuit({ failureThreshold: 1 });
    circuit.recordFailure();
    expect(circuit.state()).toBe("open");
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "circuit-open" });
    expect(calls.length).toBe(0);
  });

  test("success records circuit success (half-open probe closes)", async () => {
    // 可变时钟：熔断器构造时捕获 now() 引用，推时间要改内部状态而非换函数。
    let time = 0;
    const circuit = createKnowledgeCircuit({
      failureThreshold: 1,
      now: () => time,
    });
    circuit.recordFailure();
    expect(circuit.state()).toBe("open");
    time = 31_000;
    expect(circuit.state()).toBe("half-open");
    fetchImpl = async () =>
      jsonResponse({
        results: [result({ content: "back", score: 0.4 })],
        count: 1,
      });
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome.status).toBe("hit");
    expect(circuit.state()).toBe("closed");
  });

  test("dedup: near-identical content collapses to the highest-scoring copy", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: [
          result({ chunk_id: "dup-a", content: "Same, content!", score: 0.2 }),
          result({ chunk_id: "other", content: "different", score: 0.6 }),
          result({ chunk_id: "dup-b", content: "same  content", score: 0.9 }),
        ],
        count: 3,
      });
    const outcome = await retriever({}).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    // dup-b 先出（0.9），dup-a 归一化后与之相同被丢弃。
    expect(outcome.chunks.map((c) => c.chunkId)).toEqual(["dup-b", "other"]);
  });

  test("truncates each chunk to 800 chars and the whole set to the top_k", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: Array.from({ length: 7 }, (_, i) =>
          result({
            chunk_id: `c${i}`,
            content: `${i}`.repeat(900),
            score: 1 - i * 0.1,
          }),
        ),
        count: 7,
      });
    const outcome = await retriever({ topK: 3 }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.length).toBe(3);
    expect(outcome.chunks.every((c) => c.content.length <= 800)).toBe(true);
    expect(outcome.chunks.map((c) => c.chunkId)).toEqual(["c0", "c1", "c2"]);
  });

  test("context budget drops whole trailing chunks instead of cutting one in half", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: Array.from({ length: 10 }, (_, i) =>
          result({
            chunk_id: `c${i}`,
            content: `${i}`.repeat(700),
            score: 1 - i * 0.05,
          }),
        ),
        count: 10,
      });
    const outcome = await retriever({ topK: 10 }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    // 700×10 远超 4000：只保留前 5 条整块 + 第 6 条会让 used(3500)+700>4000 而被丢。
    expect(outcome.chunks.length).toBeLessThan(10);
    const total = outcome.chunks.reduce((sum, c) => sum + c.content.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
    // 保住的每一条都是完整的 700 字符，没有被切半。
    expect(outcome.chunks.every((c) => c.content.length === 700)).toBe(true);
  });

  test("title falls back metadata.title → source → doc_id", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: [
          result({
            chunk_id: "t1",
            metadata: { title: "风险手册" },
            source: "file",
            content: "a",
            score: 0.9,
          }),
          result({
            chunk_id: "t2",
            source: "https://example.com/doc",
            content: "b",
            score: 0.8,
          }),
          result({ chunk_id: "t3", source: "", content: "c", score: 0.7 }),
        ],
        count: 3,
      });
    const outcome = await retriever({}).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.map((c) => c.title)).toEqual([
      "风险手册",
      "https://example.com/doc",
      "doc-1",
    ]);
  });

  test("tool overrides: kb scope, top_k clamp and longer timeout travel to the request", async () => {
    fetchImpl = async (input) => {
      if (String(input).endsWith("/kb/kb2/retrieve"))
        return jsonResponse({
          results: [result({ chunk_id: "x", content: "y", score: 0.5 })],
          count: 1,
        });
      throw new Error("kb1 must not be queried when kbIds overrides to kb2");
    };
    const outcome = await retriever({ kbIds: ["kb1"] }).retrieve("q", {
      kbIds: ["kb2"],
      topK: 99,
      timeoutMs: 9_000,
    });
    expect(outcome.status).toBe("hit");
    expect(calls.map((c) => c.url)).toEqual(["http://kb.test/kb/kb2/retrieve"]);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.top_k).toBe(10);
  });
});
