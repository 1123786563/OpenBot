import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, of } from "rxjs";
import { createKnowledgeCircuit } from "./circuit";
import {
  createKnowledgeRetriever,
  knowledgeRetrievalOptionsFromEnv,
} from "./retrieval";
import { KnowledgeRetrievalMiddleware } from "./middleware";
import { knowledgeTools } from "./tools";
import { isMarkedUntrusted } from "../untrusted-content";
import type { KnowledgeSearchResult, RetrieveResponse } from "./types";

/**
 * QA 独立验证用例（不替代工程师的 4 个套件，只补走查发现的盲区）：
 * env 解析的非法值回退、等分稳定排序、跨 kb 去重、top_k 下界 clamp、总预算
 * 精确边界、kb id URL 编码、200 但 body 非 JSON、half-open 并发单探测、
 * middleware 空/空白/纯图片消息、工具 schema 边界长度。
 */

const realFetch = globalThis.fetch;
let fetchImpl:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;

const calls: { url: string; init: RequestInit | undefined }[] = [];

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

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (!fetchImpl) throw new Error("no fetch behaviour installed for test");
    return fetchImpl(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchImpl = null;
});

const config = { baseUrl: "http://kb.test", apiKey: "secret", timeoutMs: 10_000 };

function retriever(options: {
  kbIds?: string[];
  topK?: number;
  timeoutMs?: number;
  circuit?: ReturnType<typeof createKnowledgeCircuit>;
}) {
  return createKnowledgeRetriever(
    config,
    {
      kbIds: options.kbIds ?? ["kb1"],
      topK: options.topK ?? 5,
      timeoutMs: options.timeoutMs ?? 1500,
      scoreThreshold: 0,
    },
    options.circuit ?? createKnowledgeCircuit(),
  );
}

describe("qa: env parsing falls back on invalid values", () => {
  const keys = [
    "KB_RETRIEVAL_KB_IDS",
    "KB_RETRIEVAL_TOP_K",
    "KB_RETRIEVAL_TIMEOUT_MS",
    "KB_RETRIEVAL_SCORE_THRESHOLD",
  ];
  const saved: Record<string, string | undefined> = {};
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

  test("non-numeric TOP_K / TIMEOUT_MS fall back to defaults, not NaN", () => {
    process.env.KB_RETRIEVAL_KB_IDS = "kb1";
    process.env.KB_RETRIEVAL_TOP_K = "abc";
    process.env.KB_RETRIEVAL_TIMEOUT_MS = "xyz";
    const parsed = knowledgeRetrievalOptionsFromEnv();
    expect(parsed).toEqual({
      kbIds: ["kb1"],
      topK: 5,
      timeoutMs: 1500,
      scoreThreshold: 0,
    });
  });

  test("TOP_K=0 clamps up to 1; negative score threshold reads as off", () => {
    process.env.KB_RETRIEVAL_KB_IDS = "kb1";
    process.env.KB_RETRIEVAL_TOP_K = "0";
    process.env.KB_RETRIEVAL_SCORE_THRESHOLD = "-0.5";
    const parsed = knowledgeRetrievalOptionsFromEnv();
    expect(parsed?.topK).toBe(1);
    expect(parsed?.scoreThreshold).toBe(0);
  });
});

describe("qa: retriever blind spots", () => {
  test("equal scores keep a stable order (kb request order wins)", async () => {
    fetchImpl = async (input) =>
      String(input).endsWith("/kb/kb-a/retrieve")
        ? jsonResponse({
            results: [result({ chunk_id: "a", content: "from a", score: 0.5 })],
            count: 1,
          })
        : jsonResponse({
            results: [result({ chunk_id: "b", content: "from b", score: 0.5 })],
            count: 1,
          });
    const outcome = await retriever({ kbIds: ["kb-a", "kb-b"] }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.map((c) => c.chunkId)).toEqual(["a", "b"]);
  });

  test("dedup works across kbs: identical content collapses to the first", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: [
          result({ chunk_id: "a", content: "shared text", score: 0.5 }),
        ],
        count: 1,
      } satisfies RetrieveResponse);
    const outcome = await retriever({ kbIds: ["kb-a", "kb-b"] }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.length).toBe(1);
    expect(outcome.chunks[0]?.kbId).toBe("kb-a");
  });

  test("topK override clamps at the low end too (0 and negatives → 1)", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    await retriever({}).retrieve("q", { topK: 0 });
    await retriever({}).retrieve("q", { topK: -3 });
    for (const call of calls) {
      expect(JSON.parse(String(call.init?.body)).top_k).toBe(1);
    }
  });

  test("context budget boundary: exactly 4000 keeps all five 800-char chunks", async () => {
    fetchImpl = async () =>
      jsonResponse({
        results: ["0", "1", "2", "3", "4"].map((digit, i) =>
          result({
            chunk_id: `c${i}`,
            content: digit.repeat(800),
            score: 0.9 - i * 0.1,
          }),
        ),
        count: 5,
      });
    const outcome = await retriever({ topK: 10 }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.length).toBe(5);
    expect(
      outcome.chunks.reduce((sum, c) => sum + c.content.length, 0),
    ).toBe(4000);
  });

  test("context budget boundary: one char over drops the whole trailing chunk", async () => {
    fetchImpl = async () =>
      jsonResponse({
        // 6×800：前 5 条恰好 4000，第 6 条会让预算超 800 → 整条丢弃。
        results: ["0", "1", "2", "3", "4", "5"].map((digit, i) =>
          result({
            chunk_id: `c${i}`,
            content: digit.repeat(800),
            score: 0.9 - i * 0.1,
          }),
        ),
        count: 6,
      });
    const outcome = await retriever({ topK: 10 }).retrieve("q");
    expect(outcome.status).toBe("hit");
    if (outcome.status !== "hit") return;
    expect(outcome.chunks.length).toBe(5);
    expect(outcome.chunks.every((c) => c.content.length === 800)).toBe(true);
  });

  test("kb id with path-ish characters is URL-encoded in the request path", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    await retriever({ kbIds: ["a b/c?d"] }).retrieve("q");
    expect(calls[0]?.url).toBe("http://kb.test/kb/a%20b%2Fc%3Fd/retrieve");
  });

  test("200 with a non-JSON body degrades without tripping the circuit", async () => {
    const circuit = createKnowledgeCircuit({ failureThreshold: 1 });
    fetchImpl = async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const outcome = await retriever({ circuit }).retrieve("q");
    expect(outcome).toEqual({ status: "degraded", reason: "unavailable" });
    expect(circuit.state()).toBe("closed");
  });

  test("half-open admits exactly one in-flight probe under concurrency", async () => {
    let time = 0;
    const circuit = createKnowledgeCircuit({
      failureThreshold: 1,
      now: () => time,
    });
    circuit.recordFailure();
    time = 31_000;
    expect(circuit.state()).toBe("half-open");
    fetchImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return jsonResponse({
        results: [result({ content: "back", score: 0.4 })],
        count: 1,
      });
    };
    const [first, second] = await Promise.all([
      retriever({ circuit }).retrieve("q"),
      retriever({ circuit }).retrieve("q"),
    ]);
    const outcomes = [first, second].sort((a, b) =>
      a.status === "hit" ? -1 : 1,
    );
    expect(outcomes[0]?.status).toBe("hit");
    expect(outcomes[1]).toEqual({ status: "degraded", reason: "circuit-open" });
    expect(circuit.state()).toBe("closed");
  });

  test("query is capped at exactly 512 chars at the retrieval layer", async () => {
    fetchImpl = async () => jsonResponse({ results: [], count: 0 });
    await retriever({}).retrieve("x".repeat(513));
    expect(
      JSON.parse(String(calls[0]?.init?.body)).query.length,
    ).toBe(512);
  });
});

describe("qa: middleware blind spots", () => {
  function stubAgent() {
    const received: RunAgentInput[] = [];
    const agent = {
      run(receivedInput: RunAgentInput) {
        received.push(receivedInput);
        return of({ type: "RUN_STARTED" } as unknown as BaseEvent);
      },
    } as unknown as AbstractAgent;
    return { agent, received };
  }

  function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
    return {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "问题" }],
      tools: [],
      context: [],
      ...overrides,
    } as RunAgentInput;
  }

  test("empty messages array: passthrough, retriever never called", async () => {
    const { agent, received } = stubAgent();
    let retrieveCalls = 0;
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async () => {
        retrieveCalls += 1;
        return { status: "miss" };
      },
    }));
    const input = baseInput({ messages: [] });
    await firstValueFrom(middleware.run(input, agent));
    expect(retrieveCalls).toBe(0);
    expect(received[0]).toBe(input);
  });

  test("whitespace-only user message: retriever never called", async () => {
    const { agent, received } = stubAgent();
    let retrieveCalls = 0;
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async () => {
        retrieveCalls += 1;
        return { status: "miss" };
      },
    }));
    const input = baseInput({
      messages: [{ id: "m1", role: "user", content: "   \n\t  " }],
    } as Partial<RunAgentInput>);
    await firstValueFrom(middleware.run(input, agent));
    expect(retrieveCalls).toBe(0);
    expect(received[0]).toBe(input);
  });

  test("user message with only non-text parts (e.g. an image): no query", async () => {
    const { agent } = stubAgent();
    const queries: string[] = [];
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async (query) => {
        queries.push(query);
        return { status: "miss" };
      },
    }));
    await firstValueFrom(
      middleware.run(
        baseInput({
          messages: [
            {
              id: "m1",
              role: "user",
              content: [{ type: "image", source: { type: "url", value: "https://x/img.png" } }],
            },
          ],
        } as Partial<RunAgentInput>),
        agent,
      ),
    );
    expect(queries.length).toBe(0);
  });

  test("mixed content parts: text parts joined as the query", async () => {
    const { agent } = stubAgent();
    const queries: string[] = [];
    const middleware = new KnowledgeRetrievalMiddleware("bot-1", async () => ({
      retrieve: async (query) => {
        queries.push(query);
        return { status: "miss" };
      },
    }));
    await firstValueFrom(
      middleware.run(
        baseInput({
          messages: [
            {
              id: "m1",
              role: "user",
              content: [
                { type: "text", text: "风险" },
                { type: "image", source: { type: "url", value: "https://x/img.png" } },
                { type: "text", text: "准备金" },
              ],
            },
          ],
        } as Partial<RunAgentInput>),
        agent,
      ),
    );
    expect(queries).toEqual(["风险 准备金"]);
  });
});

describe("qa: search_knowledge schema boundaries", () => {
  function missRetriever() {
    return {
      retrieve: async () => ({ status: "miss" as const }),
    };
  }

  test("query of exactly 500 chars passes; 501 is refused", async () => {
    const tools = knowledgeTools({ retriever: missRetriever() });
    const ok = await tools[0]?.execute({ query: "q".repeat(500) });
    expect(ok).toContain("no matching content");
    const tooLong = await tools[0]?.execute({ query: "q".repeat(501) });
    expect(tooLong).toBe("Refused. Invalid knowledge arguments.");
  });

  test("top_k 1 and 10 pass; kb_id of 128 chars passes, 129 is refused", async () => {
    const tools = knowledgeTools({ retriever: missRetriever() });
    const low = await tools[0]?.execute({ query: "q", top_k: 1 });
    expect(low).toContain("no matching content");
    const high = await tools[0]?.execute({ query: "q", top_k: 10 });
    expect(high).toContain("no matching content");
    const longId = "k".repeat(128);
    const idOk = await tools[0]?.execute({ query: "q", kb_id: longId });
    expect(idOk).toContain("no matching content");
    const idTooLong = await tools[0]?.execute({ kb_id: "k".repeat(129), query: "q" });
    expect(idTooLong).toBe("Refused. Invalid knowledge arguments.");
  });

  test("degraded note JSON is deliberately NOT untrusted-wrapped (no upstream content)", async () => {
    const tools = knowledgeTools({
      retriever: { retrieve: async () => ({ status: "degraded" as const, reason: "unavailable" as const }) },
    });
    const answer = await tools[0]?.execute({ query: "q" });
    expect(answer).toBe(
      JSON.stringify({
        results: [],
        note: "knowledge retrieval is temporarily unavailable",
      }),
    );
    expect(isMarkedUntrusted(String(answer))).toBe(false);
  });

  test("hit and miss results ARE untrusted-wrapped (content reaches the model)", async () => {
    const hit = knowledgeTools({
      retriever: {
        retrieve: async () => ({
          status: "hit" as const,
          chunks: [
            {
              index: 1,
              kbId: "kb1",
              chunkId: "c1",
              docId: "d1",
              title: "t",
              source: "s",
              score: 0.5,
              content: "body",
            },
          ],
          block: "unused",
        }),
      },
    });
    const hitAnswer = await hit[0]?.execute({ query: "q" });
    expect(isMarkedUntrusted(String(hitAnswer))).toBe(true);
    const miss = knowledgeTools({ retriever: missRetriever() });
    const missAnswer = await miss[0]?.execute({ query: "q" });
    expect(isMarkedUntrusted(String(missAnswer))).toBe(true);
  });
});
