import { describe, expect, test } from "bun:test";
import type { AuditInitiator } from "../audit";
import { isMarkedUntrusted } from "../untrusted-content";
import type { KnowledgeRetriever, RetrievalOutcome } from "./retrieval";
import { knowledgeTools } from "./tools";

function retrieverReturning(
  outcome: RetrievalOutcome,
  captured: { query?: string; overrides?: Record<string, unknown> } = {},
): KnowledgeRetriever {
  return {
    retrieve: async (query, overrides) => {
      captured.query = query;
      captured.overrides = overrides;
      return outcome;
    },
  };
}

const hitOutcome: RetrievalOutcome = {
  status: "hit",
  chunks: [
    {
      index: 1,
      kbId: "kb1",
      chunkId: "c1",
      docId: "d1",
      title: "风险手册",
      source: "file",
      score: 0.87654,
      content: "风险准备金率的内容",
    },
    {
      index: 2,
      kbId: "kb1",
      chunkId: "c2",
      docId: "d1",
      title: "风险手册",
      source: "file",
      score: 0.5,
      content: "第二条内容",
    },
  ],
  block: "unused by the tool",
};

describe("search_knowledge tool", () => {
  test("registers one tool with the model-facing name and the domain ref", () => {
    const tools = knowledgeTools({
      retriever: retrieverReturning({ status: "miss" }),
    });
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("search_knowledge");
    expect(tools[0]?.ref).toBe("knowledge/search_knowledge");
    expect(tools[0]?.description).toContain("knowledge bases");
  });

  test("invalid arguments are refused with the REFUSAL marker", async () => {
    const tools = knowledgeTools({
      retriever: retrieverReturning(hitOutcome),
    });
    const answer = await tools[0]?.execute({ query: "" });
    expect(answer).toBe("Refused. Invalid knowledge arguments.");
    const extra = await tools[0]?.execute({
      query: "q",
      unexpected: true,
    });
    expect(extra).toBe("Refused. Invalid knowledge arguments.");
  });

  test("hit: returns untrusted-marked JSON with n/title/source/score/content", async () => {
    const tools = knowledgeTools({
      retriever: retrieverReturning(hitOutcome),
    });
    const answer = await tools[0]?.execute({ query: "风险准备金率" });
    if (!answer) throw new Error("no answer");
    expect(isMarkedUntrusted(answer)).toBe(true);
    // 信封是 notice + <untrusted_data> 包裹的 JSON 尾随 </untrusted_data>；取首尾
    // 大括号之间的部分才是纯 JSON。
    const envelope = answer.slice(
      answer.indexOf("{"),
      answer.lastIndexOf("}") + 1,
    );
    const parsed = JSON.parse(envelope) as {
      results: {
        n: number;
        title: string;
        source: string;
        score: number;
        content: string;
      }[];
    };
    expect(parsed.results.length).toBe(2);
    expect(parsed.results[0]).toEqual({
      n: 1,
      title: "风险手册",
      source: "file",
      score: 0.877,
      content: "风险准备金率的内容",
    });
  });

  test("miss: returns an untrusted-marked note JSON", async () => {
    const tools = knowledgeTools({
      retriever: retrieverReturning({ status: "miss" }),
    });
    const answer = await tools[0]?.execute({ query: "不存在的东西" });
    if (!answer) throw new Error("no answer");
    expect(answer).toContain("no matching content in the knowledge bases");
    expect(isMarkedUntrusted(answer)).toBe(true);
  });

  test("degraded: plain note JSON, never thrown, never Refused-prefixed", async () => {
    for (const reason of [
      "timeout",
      "unavailable",
      "circuit-open",
      "error",
    ] as const) {
      const tools = knowledgeTools({
        retriever: retrieverReturning({ status: "degraded", reason }),
      });
      const answer = await tools[0]?.execute({ query: "q" });
      expect(answer).toBe(
        JSON.stringify({
          results: [],
          note: "knowledge retrieval is temporarily unavailable",
        }),
      );
      expect(answer?.startsWith("Refused.")).toBe(false);
    }
  });

  test("retrieve throwing degrades to the note JSON instead of erroring the run", async () => {
    const tools = knowledgeTools({
      retriever: {
        retrieve: async () => {
          throw new Error("boom");
        },
      },
    });
    const answer = await tools[0]?.execute({ query: "q" });
    expect(answer).toContain("temporarily unavailable");
  });

  test("kb_id outside the configured set returns a note without calling upstream", async () => {
    const captured: { query?: string } = {};
    let retrieveCalls = 0;
    const retriever: KnowledgeRetriever = {
      retrieve: async (query) => {
        retrieveCalls += 1;
        captured.query = query;
        return hitOutcome;
      },
    };
    const tools = knowledgeTools({
      retriever,
      kbIds: ["kb1", "kb2"],
    });
    const answer = await tools[0]?.execute({ query: "q", kb_id: "kb-x" });
    expect(JSON.parse(String(answer))).toEqual({
      results: [],
      note: "knowledge base kb-x is not available",
    });
    expect(retrieveCalls).toBe(0);
  });

  test("kb_id inside the configured set scopes the retrieval and forwards overrides", async () => {
    const captured: {
      query?: string;
      overrides?: Record<string, unknown>;
    } = {};
    const tools = knowledgeTools({
      retriever: retrieverReturning(hitOutcome, captured),
      kbIds: ["kb1"],
    });
    await tools[0]?.execute({ query: "风险", kb_id: "kb1", top_k: 7 });
    expect(captured.query).toBe("风险");
    // 工具路径的超时档固定 10s，top_k 与 kb 范围透传。
    expect(captured.overrides).toEqual({
      timeoutMs: 10_000,
      topK: 7,
      kbIds: ["kb1"],
    });
  });

  test("initiator is carried on the tool for the audit gateway", () => {
    const initiator: AuditInitiator = { kind: "person" };
    const tools = knowledgeTools({
      retriever: retrieverReturning({ status: "miss" }),
      initiator,
    });
    expect(tools[0]?.initiator).toBe(initiator);
    // 未传时字段缺省而非 undefined 显式存在。
    const bare = knowledgeTools({
      retriever: retrieverReturning({ status: "miss" }),
    });
    expect(bare[0]?.initiator).toBeUndefined();
  });

  test("parameters schema is strict with bounded fields", () => {
    const tools = knowledgeTools({
      retriever: retrieverReturning({ status: "miss" }),
    });
    const schema = tools[0]?.parameters;
    if (!schema) throw new Error("no schema");
    expect(schema.safeParse({ query: "q" }).success).toBe(true);
    expect(
      schema.safeParse({ query: "q", kb_id: "kb1", top_k: 3 }).success,
    ).toBe(true);
    expect(schema.safeParse({ query: "q", top_k: 11 }).success).toBe(false);
    expect(schema.safeParse({ query: "q", top_k: 1.5 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: "q", extra: 1 }).success).toBe(false);
  });
});
