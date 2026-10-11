import { afterAll, describe, expect, test } from "bun:test";
import { QdrantClient } from "./client";
import {
  CollectionMismatchError,
  collectionName,
  ensureCollection,
} from "./collections";

/**
 * 真实 Qdrant roundtrip（T01 验收项）：需要 localhost:6333 可达。
 * 起法：docker run -d -p 6333:6333 qdrant/qdrant:1.19.2
 * 不可达时跳过（CI 无 docker 的场景），但本机验收必须全绿。
 */
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

async function qdrantUp(): Promise<boolean> {
  try {
    const response = await fetch(`${QDRANT_URL}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

const up = await qdrantUp();

/** 用独立维度避免与开发库互踩（4242 不在常用 embed 维度里）。 */
const TEST_DIM = 4242;
const TEST_COLLECTION = collectionName(TEST_DIM);

afterAll(async () => {
  if (!up) return;
  // 清理测试 collection。
  await fetch(`${QDRANT_URL}/collections/${TEST_COLLECTION}`, {
    method: "DELETE",
  }).catch(() => {});
});

describe.skipIf(!up)("ensureCollection against a live Qdrant", () => {
  test("404 → creates the collection and declares all payload indexes", async () => {
    const client = new QdrantClient({ baseUrl: QDRANT_URL });
    // 预清理：确保从 404 分支开始。
    await fetch(`${QDRANT_URL}/collections/${TEST_COLLECTION}`, {
      method: "DELETE",
    });
    const result = await ensureCollection(client, TEST_DIM);
    expect(result.created).toBe(true);
    expect(result.collection).toBe(TEST_COLLECTION);

    // 校验 collection 配置（size/distance/hnsw）。
    const info = await client.getCollection(TEST_COLLECTION);
    const vectors = info?.result?.config?.params?.vectors;
    expect(vectors?.size).toBe(TEST_DIM);
    expect(vectors?.distance).toBe("Cosine");

    // payload 索引声明齐全。索引构建是后台任务：轮询至多 5s 直到 8 个都出现。
    const declared = await waitForPayloadSchema(TEST_COLLECTION, 8, 5_000);
    for (const field of [
      "tenant_id",
      "kb_id",
      "doc_id",
      "chunk_id",
      "chunk_type",
      "source_type",
      "enabled",
    ]) {
      expect(declared[field]?.data_type).toBe("keyword");
    }
    expect(declared.chunk_index?.data_type).toBe("integer");
  });

  /** payload 索引后台构建完成前的 GET 是空对象：轮询直到声明数达标或超时。 */
  async function waitForPayloadSchema(
    collection: string,
    expectedCount: number,
    timeoutMs: number,
  ): Promise<Record<string, { data_type?: string }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetch(`${QDRANT_URL}/collections/${collection}`);
      const body = (await response.json()) as {
        result?: { payload_schema?: Record<string, { data_type?: string }> };
      };
      const schema = body.result?.payload_schema ?? {};
      if (Object.keys(schema).length >= expectedCount) return schema;
      if (Date.now() > deadline) return schema; // 超时返回现状，断言报出缺哪个。
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  test("already exists with matching config → idempotent no-op", async () => {
    const client = new QdrantClient({ baseUrl: QDRANT_URL });
    const second = await ensureCollection(client, TEST_DIM);
    expect(second.created).toBe(false);
  });

  test("dimension mismatch → fail fast", async () => {
    const client = new QdrantClient({ baseUrl: QDRANT_URL });
    // 名字里的维度与实际 vectors.size 不一致（手工建库或改名残留的形态）：
    // kb_chunks_{N} 必须恰好 N 维，ensureCollection 拒绝带病服务。
    const mismatchName = `kb_chunks_${TEST_DIM}`;
    await fetch(`${QDRANT_URL}/collections/${mismatchName}`, {
      method: "DELETE",
    }).catch(() => {});
    await client.createCollection(mismatchName, {
      vectors: { size: TEST_DIM + 7, distance: "Cosine" },
      hnswConfig: { m: 16, ef_construct: 64 },
    });
    await expect(ensureCollection(client, TEST_DIM)).rejects.toBeInstanceOf(
      CollectionMismatchError,
    );
    // 还原现场：删掉病态 collection，后续用例从 404 分支重建。
    await fetch(`${QDRANT_URL}/collections/${mismatchName}`, {
      method: "DELETE",
    }).catch(() => {});
  });

  test("roundtrip: upsert 3 → query → delete by filter → count 0", async () => {
    const client = new QdrantClient({ baseUrl: QDRANT_URL });
    await ensureCollection(client, TEST_DIM);

    // 3 个测试向量（确定性小向量，[1,0] [0,1] [1,1] 方向）。
    const points = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        vector: [1, 0, 0, 0],
        payload: {
          tenant_id: "t1",
          kb_id: "kb1",
          doc_id: "d1",
          chunk_index: 0,
        },
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        vector: [0, 1, 0, 0],
        payload: {
          tenant_id: "t1",
          kb_id: "kb1",
          doc_id: "d1",
          chunk_index: 1,
        },
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        vector: [1, 1, 0, 0],
        payload: {
          tenant_id: "t1",
          kb_id: "kb1",
          doc_id: "d2",
          chunk_index: 0,
        },
      },
    ];
    for (const point of points) {
      // 维度对齐 TEST_DIM（4242）——补零。
      point.vector = [
        ...point.vector,
        ...new Array<number>(TEST_DIM - point.vector.length).fill(0),
      ];
    }
    await client.upsertPoints(TEST_COLLECTION, points);
    expect(await client.countPoints(TEST_COLLECTION)).toBe(3);

    // query：[1,0,...] 方向应首选 point 1，filter 限定 doc_id=d1 只返回前两个。
    const queryResult = await client.queryPoints(TEST_COLLECTION, {
      query: [1, ...new Array<number>(TEST_DIM - 1).fill(0)],
      filter: {
        must: [
          { key: "tenant_id", match: { value: "t1" } },
          { key: "doc_id", match: { value: "d1" } },
        ],
      },
      limit: 10,
      with_payload: true,
    });
    const hits = queryResult.result?.points ?? [];
    expect(hits.length).toBe(2);
    expect(hits[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
    // Cosine 下 score 即 similarity ∈ (0,1]。
    expect(hits[0]?.score ?? 0).toBeGreaterThan(0.99);

    // upsert 同 id 覆盖（幂等）：重复写 point 1 不增加计数。
    await client.upsertPoints(TEST_COLLECTION, [points[0]!]);
    expect(await client.countPoints(TEST_COLLECTION)).toBe(3);

    // delete by filter（doc_id=d1）→ 只剩 d2 的一个。
    await client.deletePointsByFilter(TEST_COLLECTION, {
      must: [{ key: "doc_id", match: { value: "d1" } }],
    });
    expect(await client.countPoints(TEST_COLLECTION)).toBe(1);

    // 清光 → count 0。
    await client.deletePointsByFilter(TEST_COLLECTION, {
      must: [{ key: "kb_id", match: { value: "kb1" } }],
    });
    expect(await client.countPoints(TEST_COLLECTION)).toBe(0);
  });
});
