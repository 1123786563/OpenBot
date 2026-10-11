import { describe, expect, test } from "bun:test";
import { DEFAULT_MMR_LAMBDA, jaccard, selectMMR, tokenizeSimple } from "./mmr";

/** MMR + 分词 + Jaccard（gojieba→Intl.Segmenter 替代的等价性验证）。 */

describe("tokenizeSimple", () => {
  test("Chinese text segmented into multi-rune words", () => {
    const tokens = tokenizeSimple("风险准备金率是核心风控指标");
    // ICU Squoia 词级切分（与 gojieba 粒度差异已在设计 §7.4 预告——只影响
    // token-Jaccard 的粒度，不影响功能面）。断言实际切分产物的稳定子集。
    expect(tokens.has("风险")).toBe(true);
    expect(tokens.has("核心")).toBe(true);
    expect(tokens.has("指标")).toBe(true);
    // 单字 token（率/是/风/控/金）被过滤：集合只含多字词
    expect([...tokens].every((t) => Array.from(t).length > 1)).toBe(true);
    expect(tokens.size).toBeGreaterThan(2);
  });

  test("English whitespace split, lowercase, single-char dropped", () => {
    const tokens = tokenizeSimple("The Quick Brown fox");
    expect([...tokens].sort()).toEqual(["brown", "fox", "quick", "the"]);
  });

  test("punctuation-only tokens dropped", () => {
    expect(tokenizeSimple("。，！？").size).toBe(0);
    expect(tokenizeSimple("").size).toBe(0);
  });

  test("mixed content keeps both scripts' words", () => {
    const tokens = tokenizeSimple("使用 Rerank 模型重排");
    expect(tokens.has("rerank")).toBe(true);
    expect(tokens.has("模型")).toBe(true);
  });
});

describe("jaccard", () => {
  test("identical sets = 1, disjoint = 0, both empty = 0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  test("overlap ratio", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // inter=2 union=4
    expect(jaccard(a, b)).toBeCloseTo(0.5, 6);
  });

  test("small set drives large set (symmetry)", () => {
    const small = new Set(["x"]);
    const large = new Set(["x", "y", "z", "w"]);
    // inter=1 union=4
    expect(jaccard(small, large)).toBeCloseTo(0.25, 6);
    expect(jaccard(large, small)).toBeCloseTo(0.25, 6);
  });
});

describe("selectMMR", () => {
  const item = (score: number, passage: string) => ({ score, passage });

  test("k<=0 or empty returns empty", () => {
    expect(selectMMR([], 3, 0.7)).toEqual([]);
    expect(selectMMR([item(1, "a")], 0, 0.7)).toEqual([]);
  });

  test("k >= n returns all, highest score first", () => {
    const items = [item(0.5, "alpha"), item(0.9, "beta"), item(0.7, "gamma")];
    const picks = selectMMR(items, 5, DEFAULT_MMR_LAMBDA);
    expect(picks).toEqual([1, 2, 0]); // beta(0.9) → gamma(0.7) → alpha(0.5)
  });

  test("redundant candidate loses to diverse one at equal score", () => {
    // 三个同分候选：A/B 文本几乎相同，C 完全不同
    const items = [
      item(0.9, "风险准备金率是交易所要求的资金"),
      item(0.9, "风险准备金率是交易所要求的资金比例"),
      item(0.9, "用户登录流程包含密码校验"),
    ];
    const picks = selectMMR(items, 2, DEFAULT_MMR_LAMBDA);
    expect(picks.length).toBe(2);
    // 第一选 A（并列取早）；第二选 C（B 与 A 高冗余被 MMR 惩罚）
    expect(picks[0]).toBe(0);
    expect(picks[1]).toBe(2);
  });

  test("high-score redundant still beats low-score diverse when lambda weight dominates", () => {
    const items = [
      item(0.95, "风险准备金率说明"),
      item(0.94, "风险准备金率说明补充"),
      item(0.20, "完全不同的低分主题"),
    ];
    const picks = selectMMR(items, 2, DEFAULT_MMR_LAMBDA);
    expect(picks).toEqual([0, 1]);
  });

  test("incremental redundancy: third pick accounts for both selected", () => {
    // C 与 A、B 都各有一半重叠；D 只与 B 重叠。第三选应偏好 D。
    const items = [
      item(0.9, "alpha beta gamma"),
      item(0.85, "gamma delta epsilon"),
      item(0.8, "alpha delta zeta"), // 与 A 共 alpha、与 B 共 delta
      item(0.8, "epsilon eta theta"), // 与 B 共 epsilon
    ];
    const picks = selectMMR(items, 3, DEFAULT_MMR_LAMBDA);
    expect(picks.length).toBe(3);
    expect(picks).toContain(3);
  });
});
