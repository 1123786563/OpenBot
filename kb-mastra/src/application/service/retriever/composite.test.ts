import { describe, expect, test } from "bun:test";
import { allHits, createCompositeRetrieveEngine, engineErrors } from "./composite";
import type { IndexWithScore, RetrieveEngine, RetrieveParams } from "./engine";
import { createKeywordsEngine } from "./keywords";

/** composite 错误契约 + keywords no-op + registry 组装。 */

function hit(chunkId: string, score: number): IndexWithScore {
  return { chunkId, score, docId: `doc-${chunkId}`, kbId: "kb1", content: chunkId, contextHeader: "", chunkIndex: 0 };
}

function stubEngine(
  engineType: string,
  types: RetrieveParams["retrieverType"][],
  impl: (params: RetrieveParams) => Promise<IndexWithScore[]>,
): RetrieveEngine {
  return { engineType, retrieverTypes: types, retrieve: impl };
}

const params: RetrieveParams = {
  retrieverType: "vector",
  tenantId: "t1",
  kbIds: ["kb1"],
  queryVector: [1],
  topK: 10,
  scoreThreshold: 0,
};

describe("composite", () => {
  test("routes by retriever type and flattens hits", async () => {
    const vector = stubEngine("qdrant", ["vector"], async () => [hit("c1", 0.9), hit("c2", 0.8)]);
    const composite = createCompositeRetrieveEngine([vector]);
    const out = await composite.retrieve([params]);
    expect(out.length).toBe(1);
    expect(out[0].retrieverEngineType).toBe("qdrant");
    expect(allHits(out).map((h) => h.chunkId)).toEqual(["c1", "c2"]);
    expect(engineErrors(out)).toEqual([]);
  });

  test("engine-level failure: results dropped, error carried (no throw)", async () => {
    const failing = stubEngine("qdrant", ["vector"], async () => {
      throw new Error("qdrant unreachable");
    });
    const composite = createCompositeRetrieveEngine([failing]);
    const out = await composite.retrieve([params]);
    expect(out[0].results).toEqual([]);
    expect(out[0].error?.message).toBe("qdrant unreachable");
    expect(engineErrors(out).length).toBe(1);
  });

  test("unregistered retriever type yields EngineNotFoundError for that param only", async () => {
    const vector = stubEngine("qdrant", ["vector"], async () => [hit("c1", 0.9)]);
    const composite = createCompositeRetrieveEngine([vector]);
    const out = await composite.retrieve([
      params,
      { ...params, retrieverType: "keywords" },
    ]);
    expect(out[0].results.length).toBe(1);
    expect(out[1].error?.message).toContain("keywords");
    // 整体不抛：另一参数的命中保留
    expect(allHits(out).length).toBe(1);
  });

  test("null engines filtered at construction", async () => {
    const vector = stubEngine("qdrant", ["vector"], async () => [hit("c1", 1)]);
    const composite = createCompositeRetrieveEngine([vector, null as unknown as RetrieveEngine]);
    const out = await composite.retrieve([params]);
    expect(out[0].results.length).toBe(1);
  });
});

describe("keywords no-op", () => {
  test("returns empty without throwing (channel-level miss, not failure)", async () => {
    const engine = createKeywordsEngine();
    expect(engine.engineType).toBe("keywords-noop");
    expect(engine.retrieverTypes).toEqual(["keywords"]);
    const out = await engine.retrieve({
      retrieverType: "keywords",
      tenantId: "t1",
      kbIds: ["kb1"],
      queryText: "关键词查询",
      topK: 10,
      scoreThreshold: 0.3,
    });
    expect(out).toEqual([]);
  });
});
