import { describe, expect, test } from "bun:test";
import {
  fuseOrDeduplicate,
  RRF_K,
  RRF_KEYWORD_WEIGHT,
  RRF_VECTOR_WEIGHT,
} from "./kb-search";

/** 融合三分支（knowledgebase_search_fusion.go 语义平移）。 */

type Row = {
  chunkId: string;
  score: number;
  docId: string;
  kbId: string;
  content: string;
  contextHeader: string;
  chunkIndex: number;
};

const row = (chunkId: string, score: number): Row => ({
  chunkId,
  score,
  docId: `d-${chunkId}`,
  kbId: "kb1",
  content: chunkId,
  contextHeader: "",
  chunkIndex: 0,
});

describe("fuseOrDeduplicate 三分支", () => {
  test("vector-only: keeps original cosine scores, dedups by chunk keeping highest, sorts desc", () => {
    const out = fuseOrDeduplicate(
      [
        [row("c1", 0.8), row("c2", 0.95), row("c1", 0.7)], // c1 重复，取 0.8
      ],
      [],
    );
    expect(out.map((r) => r.chunkId)).toEqual(["c2", "c1"]);
    expect(out[1].score).toBe(0.8);
  });

  test("vector-only across multiple lists dedups globally", () => {
    const out = fuseOrDeduplicate(
      [
        [row("c1", 0.6)],
        [row("c1", 0.9), row("c2", 0.5)],
      ],
      [],
    );
    expect(out.map((r) => r.chunkId)).toEqual(["c1", "c2"]);
    expect(out[0].score).toBe(0.9);
  });

  test("keyword-only: unbounded BM25 rescaled by its own list max into [0,1]", () => {
    const out = fuseOrDeduplicate(
      [],
      [[row("k1", 12.0), row("k2", 6.0), row("k3", 3.0)]],
    );
    expect(out[0].chunkId).toBe("k1");
    expect(out[0].score).toBeCloseTo(1.0, 6);
    expect(out[1].score).toBeCloseTo(0.5, 6);
    expect(out[2].score).toBeCloseTo(0.25, 6);
  });

  test("keyword-only already in [0,1] stays unchanged", () => {
    const out = fuseOrDeduplicate([], [[row("k1", 0.8), row("k2", 0.4)]]);
    expect(out[0].score).toBe(0.8);
  });

  test("hybrid RRF: chunk ranked 1st by both scores 1.0 (normalized max)", () => {
    const vector = [row("both", 0.9), row("v-only", 0.85), row("shared", 0.8)];
    const keyword = [row("both", 11.0), row("shared", 5.0), row("k-only", 4.0)];
    const out = fuseOrDeduplicate([vector], [keyword]);
    // both：RRF = 0.7/(60+1) + 0.3/(60+1)，最大值=(0.7+0.3)/(60+1) → 归一=1.0
    expect(out[0].chunkId).toBe("both");
    expect(out[0].score).toBeCloseTo(1.0, 6);
    // 分数全在 [0,1]
    for (const r of out) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1.000001);
    }
    // shared（双方 rank=2）应高于 k-only（仅 kw rank=3）
    const shared = out.find((r) => r.chunkId === "shared");
    const kOnly = out.find((r) => r.chunkId === "k-only");
    expect(shared!.score).toBeGreaterThan(kOnly!.score);
  });

  test("hybrid with kw empty arrays degrades to vector-only branch", () => {
    // P1 实际路径：keywords no-op 返回空 → keywordLists 长度 0 → vector-only
    const out = fuseOrDeduplicate([[row("c1", 0.8)]], []);
    expect(out[0].score).toBe(0.8); // 原始余弦分未被 RRF 改写
  });

  test("RRF constants match WeKnora defaults (k=60, 0.7/0.3)", () => {
    expect(RRF_K).toBe(60);
    expect(RRF_VECTOR_WEIGHT).toBe(0.7);
    expect(RRF_KEYWORD_WEIGHT).toBe(0.3);
  });

  test("best rank across lists: chunk keeps its best position in either list", () => {
    // c1 在 listA rank=2、listB rank=1 → best rank 1
    const out = fuseOrDeduplicate(
      [
        [row("x", 0.9), row("c1", 0.8)],
        [row("c1", 0.7), row("y", 0.6)],
      ],
      [[row("c1", 10)]],
    );
    const c1 = out.find((r) => r.chunkId === "c1");
    // vRank=1 kRank=1 → 1.0
    expect(c1?.score).toBeCloseTo(1.0, 6);
  });
});
