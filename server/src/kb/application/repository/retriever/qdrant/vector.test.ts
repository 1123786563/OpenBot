import { describe, expect, test } from "../../../../../../../tests/support/e2e-compat";
import type { QdrantClient } from "../../../../infrastructure/qdrant/client";
import type {
  QueryPointsBody,
  QueryPointsResponse,
  ScoredPoint,
} from "../../../../infrastructure/qdrant/types";
import type { RetrieveParams } from "../../../service/retriever/engine";
import { createQdrantVectorEngine, expandedTopK } from "./vector";

/**
 * 修订 §2.4 检索实现验证：请求体三 must filter / expandedTopK clamp /
 * score 语义 / 应用侧阈值过滤 / payload 取回映射。mock QdrantClient，
 * 断言逐字段请求体（T04 验收：filter 缺一不可）。
 */

type CapturedCall = { collection: string; body: QueryPointsBody };

function makeClient(response: QueryPointsResponse): {
  client: QdrantClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = {
    queryPoints: async (collection: string, body: QueryPointsBody) => {
      calls.push({ collection, body });
      return response;
    },
  } as unknown as QdrantClient;
  return { client, calls };
}

function point(
  id: string,
  score: number,
  payload: Record<string, unknown>,
): ScoredPoint {
  return { id, score, payload };
}

const baseParams: RetrieveParams = {
  retrieverType: "vector",
  tenantId: "tenant-a",
  kbIds: ["kb-1"],
  queryVector: [0.1, 0.2, 0.3],
  topK: 5,
  scoreThreshold: 0.15,
};

describe("expandedTopK clamp(100,200)", () => {
  test("topK below 100 lifts to 100", () => {
    expect(expandedTopK(5)).toBe(100);
    expect(expandedTopK(1)).toBe(100);
    expect(expandedTopK(99)).toBe(100);
  });
  test("topK between 100..200 stays", () => {
    expect(expandedTopK(100)).toBe(100);
    expect(expandedTopK(150)).toBe(150);
    expect(expandedTopK(200)).toBe(200);
  });
  test("topK above 200 caps at 200", () => {
    expect(expandedTopK(500)).toBe(200);
  });
});

describe("qdrant vector engine request shape", () => {
  test("filter must contain tenant_id / kb_id(any) / enabled=true — 缺一不可", async () => {
    const { client, calls } = makeClient({ result: { points: [] } });
    const engine = createQdrantVectorEngine({
      client,
      collection: "kb_chunks_1024",
    });
    await engine.retrieve(baseParams);
    expect(calls.length).toBe(1);
    const body = calls[0].body;
    expect(calls[0].collection).toBe("kb_chunks_1024");
    expect(body.query).toEqual([0.1, 0.2, 0.3]);
    expect(body.with_payload).toBe(true);
    expect(body.limit).toBe(100); // expandedTopK(5)=100
    const must = body.filter.must;
    expect(must.length).toBe(3);
    // tenant_id 强制隔离（值来自服务端身份，非客户端参数）
    expect(must).toContainEqual({
      key: "tenant_id",
      match: { value: "tenant-a" },
    });
    // kb_id 单库 = 单元素 any
    expect(must).toContainEqual({ key: "kb_id", match: { any: ["kb-1"] } });
    // enabled=true 检索条件
    expect(must).toContainEqual({ key: "enabled", match: { value: true } });
  });

  test("multi-KB request carries any-of list", async () => {
    const { client, calls } = makeClient({ result: { points: [] } });
    const engine = createQdrantVectorEngine({
      client,
      collection: "kb_chunks_1024",
    });
    await engine.retrieve({ ...baseParams, kbIds: ["kb-1", "kb-2", "kb-3"] });
    expect(calls[0].body.filter.must).toContainEqual({
      key: "kb_id",
      match: { any: ["kb-1", "kb-2", "kb-3"] },
    });
  });

  test("missing query vector throws", async () => {
    const { client } = makeClient({ result: { points: [] } });
    const engine = createQdrantVectorEngine({ client, collection: "c" });
    const { queryVector: _omit, ...withoutVector } = baseParams;
    await expect(
      engine.retrieve(withoutVector as RetrieveParams),
    ).rejects.toThrow(/query vector/);
  });
});

describe("score semantics and app-side threshold", () => {
  test("score = similarity passed through; threshold filters below-threshold hits", async () => {
    const response: QueryPointsResponse = {
      result: {
        points: [
          point("c1", 0.92, {
            chunk_id: "c1",
            doc_id: "d1",
            kb_id: "kb-1",
            content: "高相关",
            context_header: "标题",
            chunk_index: 3,
          }),
          point("c2", 0.1, {
            chunk_id: "c2",
            doc_id: "d1",
            kb_id: "kb-1",
            content: "低相关",
            chunk_index: 4,
          }),
          point("c3", 0.15, {
            chunk_id: "c3",
            doc_id: "d2",
            kb_id: "kb-1",
            content: "恰好阈值",
            chunk_index: 0,
          }),
        ],
      },
    };
    const { client } = makeClient(response);
    const engine = createQdrantVectorEngine({ client, collection: "c" });
    const hits = await engine.retrieve({ ...baseParams, scoreThreshold: 0.15 });
    // 0.10 < 0.15 被应用侧过滤；0.15 恰好等于阈值保留（>= 语义）
    expect(hits.map((h) => h.chunkId)).toEqual(["c1", "c3"]);
    expect(hits[0].score).toBe(0.92);
    expect(hits[0].content).toBe("高相关");
    expect(hits[0].contextHeader).toBe("标题");
    expect(hits[0].chunkIndex).toBe(3);
    expect(hits[0].docId).toBe("d1");
  });

  test("all scores stay in [0,1] (cosine similarity contract)", async () => {
    const response: QueryPointsResponse = {
      result: {
        points: [
          point("c1", 1.0, {}),
          point("c2", 0.0, {}),
          point("c3", 0.55, {}),
        ],
      },
    };
    const { client } = makeClient(response);
    const engine = createQdrantVectorEngine({ client, collection: "c" });
    const hits = await engine.retrieve({ ...baseParams, scoreThreshold: 0 });
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  test("threshold 0 keeps everything", async () => {
    const response: QueryPointsResponse = {
      result: {
        points: [
          point("c1", 0.001, { chunk_id: "c1" }),
          point("c2", 0.999, {}),
        ],
      },
    };
    const { client } = makeClient(response);
    const engine = createQdrantVectorEngine({ client, collection: "c" });
    const hits = await engine.retrieve({ ...baseParams, scoreThreshold: 0 });
    expect(hits.length).toBe(2);
  });

  test("missing payload fields fall back to safe defaults", async () => {
    const response: QueryPointsResponse = {
      result: {
        points: [
          { id: "uuid-no-payload-chunk", score: 0.7, payload: undefined },
        ],
      },
    };
    const { client } = makeClient(response);
    const engine = createQdrantVectorEngine({ client, collection: "c" });
    const hits = await engine.retrieve({ ...baseParams, scoreThreshold: 0 });
    expect(hits.length).toBe(1);
    expect(hits[0].chunkId).toBe("uuid-no-payload-chunk"); // payload.chunk_id 缺失回退 point id
    expect(hits[0].content).toBe("");
    expect(hits[0].chunkIndex).toBe(0);
  });
});
