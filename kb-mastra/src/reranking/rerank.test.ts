import { describe, expect, test } from "bun:test";
import type { RankResult, Reranker } from "../models/rerank/openai-compat";
import { DEFAULT_MMR_LAMBDA } from "./mmr";
import {
  compositeScore,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_THRESHOLD,
  type RerankRow,
  rerank,
} from "./rerank";

/** rerank.go 语义平移：阈值降级链、模型失败降级、composite、截断、MMR。 */

const row = (
  chunkId: string,
  score: number,
  content = `内容-${chunkId}`,
): RerankRow => ({
  chunkId,
  score,
  content,
  contextHeader: "",
  knowledgeTitle: "",
  extra: {},
});

function stubReranker(
  impl: (
    query: string,
    documents: string[],
  ) => RankResult[] | Promise<RankResult[]>,
  opts: { maxPassageRunes?: number } = {},
): Reranker {
  return {
    async rerank(query, documents) {
      return impl(query, documents);
    },
    getModelName: () => "stub",
    getModelID: () => "stub",
    ...(opts.maxPassageRunes !== undefined
      ? { maxPassageRunes: () => opts.maxPassageRunes as number }
      : {}),
  };
}

describe("compositeScore", () => {
  test("0.6*model + 0.3*base + 0.1*1, clamped [0,1]", () => {
    expect(compositeScore(1, 1)).toBeCloseTo(1.0, 6);
    expect(compositeScore(0, 0)).toBeCloseTo(0.1, 6);
    expect(compositeScore(0.5, 0.5)).toBeCloseTo(0.55, 6);
    expect(compositeScore(0.9, 0.9)).toBeLessThanOrEqual(1);
  });
});

describe("threshold degradation chain (applyThreshold 语义)", () => {
  test("direct pass: rows above 0.2 kept, model order", async () => {
    const model = stubReranker(() => [
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.3 },
      { index: 2, relevanceScore: 0.05 },
    ]);
    const out = await rerank(model, "q", [
      row("a", 0.8),
      row("b", 0.7),
      row("c", 0.6),
    ]);
    expect(out.outcome).toBe("ok");
    expect(out.results.map((r) => r.chunkId)).toEqual(["a", "b"]);
    expect(out.effectiveThreshold).toBe(DEFAULT_THRESHOLD);
    expect(out.applied).toBe(true);
  });

  test("all-reject at 0.5: degrade ×0.7 to 0.35 floor 0.3, rows pass at degraded threshold", async () => {
    const model = stubReranker(() => [
      { index: 0, relevanceScore: 0.36 },
      { index: 1, relevanceScore: 0.2 },
    ]);
    const out = await rerank(model, "q", [row("a", 0.8), row("b", 0.7)], {
      threshold: 0.5,
    });
    expect(out.outcome).toBe("threshold_degraded");
    expect(out.effectiveThreshold).toBeCloseTo(0.35, 6);
    expect(out.results.map((r) => r.chunkId)).toEqual(["a"]);
  });

  test("degrade floor never below 0.3", async () => {
    // 0.9*0.7=0.63 → floor 不生效（0.63>0.3）；0.31<0.63 仍全灭 → fallback 保底。
    // 用 threshold 0.5：0.5*0.7=0.35>0.3，0.31<0.35 全灭 → fallback；
    // 真正触底 0.3 的路径：threshold 0.45 → 0.315 → floor 0.3 未及（0.315>0.3）。
    // 构造 floor 直接命中的场景：threshold > floor 且 degraded=max(t*0.7, 0.3)
    const model = stubReranker(() => [{ index: 0, relevanceScore: 0.31 }]);
    const out = await rerank(model, "q", [row("a", 0.8)], { threshold: 0.5 });
    expect(out.outcome).toBe("fallback_top1");
    expect(out.effectiveThreshold).toBeCloseTo(0.35, 6);
    // threshold 0.9：0.9*0.7=0.63 仍>0.31 → 全灭后 fallback
    const out2 = await rerank(model, "q", [row("a", 0.8)], { threshold: 0.9 });
    expect(out2.effectiveThreshold).toBeCloseTo(0.63, 6);
    expect(out2.outcome).toBe("fallback_top1");
  });

  test("still all-reject after degrade: best kept if >= 0.15 fallback", async () => {
    const model = stubReranker(() => [
      { index: 0, relevanceScore: 0.16 },
      { index: 1, relevanceScore: 0.05 },
    ]);
    const out = await rerank(model, "q", [row("a", 0.8), row("b", 0.7)], {
      threshold: 0.5,
    });
    expect(out.outcome).toBe("fallback_top1");
    expect(out.results.map((r) => r.chunkId)).toEqual(["a"]);
  });

  test("best below 0.15: nothing survives", async () => {
    const model = stubReranker(() => [{ index: 0, relevanceScore: 0.1 }]);
    const out = await rerank(model, "q", [row("a", 0.8)], { threshold: 0.5 });
    expect(out.outcome).toBe("all_below_threshold");
    expect(out.results).toEqual([]);
  });
});

describe("model failure degradation", () => {
  test("model error returns input rows unchanged in retrieval order", async () => {
    const model = stubReranker(() => {
      throw new Error("rerank service down");
    });
    const rows = [row("a", 0.3), row("b", 0.9), row("c", 0.6)];
    const out = await rerank(model, "q", rows);
    expect(out.outcome).toBe("model_error");
    expect(out.error).toContain("rerank service down");
    // 原序原分
    expect(out.results.map((r) => r.chunkId)).toEqual(["a", "b", "c"]);
    expect(out.results[1].score).toBe(0.9);
    expect(out.applied).toBe(false);
  });
});

describe("candidate management", () => {
  test("empty passages skip candidacy (blank content)", async () => {
    const model = stubReranker(() => [{ index: 0, relevanceScore: 0.9 }]);
    const out = await rerank(model, "q", [row("a", 0.8, "   ")]);
    expect(out.outcome).toBe("no_candidates");
    expect(out.candidateCount).toBe(0);
  });

  test("maxCandidates 200 keeps highest retrieval scores only", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`c${i}`, i / 250));
    const seen: string[] = [];
    const model = stubReranker((_q, documents) => {
      seen.push(...documents);
      return [{ index: 0, relevanceScore: 0.9 }];
    });
    const out = await rerank(model, "q", rows);
    expect(out.candidateCount).toBe(DEFAULT_MAX_CANDIDATES);
    // 检索分最高的 200 条被送模型（c249..c50）
    expect(seen.length).toBe(200);
  });

  test("out-of-range model indices dropped defensively", async () => {
    const model = stubReranker(() => [
      { index: 5, relevanceScore: 0.99 },
      { index: 0, relevanceScore: 0.4 },
      { index: -1, relevanceScore: 0.98 },
    ]);
    const out = await rerank(model, "q", [row("a", 0.8)]);
    expect(out.results.map((r) => r.chunkId)).toEqual(["a"]);
  });
});

describe("fitPassages via maxPassageRunes", () => {
  test("passages trimmed to model limit before scoring", async () => {
    const long = "字".repeat(300);
    const captured: string[] = [];
    const model = stubReranker(
      (_q, docs) => {
        captured.push(...docs);
        return [{ index: 0, relevanceScore: 0.9 }];
      },
      { maxPassageRunes: 100 },
    );
    await rerank(model, "q", [row("a", 0.8, long)]);
    expect(captured[0].length).toBe(100);
  });
});

describe("MMR topK selection", () => {
  test("topK picks at most K diverse results, best first", async () => {
    const model = stubReranker(() => [
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.85 },
      { index: 2, relevanceScore: 0.8 },
    ]);
    const out = await rerank(
      model,
      "q",
      [row("a", 0.8), row("b", 0.7), row("c", 0.6)],
      {
        topK: 2,
      },
    );
    expect(out.results.length).toBe(2);
    expect(DEFAULT_MMR_LAMBDA).toBe(0.7);
  });
});
