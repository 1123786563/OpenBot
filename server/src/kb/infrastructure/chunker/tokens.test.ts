import { describe, expect, test } from "../../../../../tests/support/e2e-compat";
import {
  dominantHeadingLevel,
  profileDocument,
  selectStrategy,
} from "./profiler";
import { approxTokenCount, charsForTokenLimit, detectLanguage } from "./tokens";

/** WeKnora tokens_test.go + profiler_test.go 用例平移。 */

describe("approxTokenCount（tokens_test.go）", () => {
  test("english ~4 chars/token", () => {
    // 40 chars / 4.0 = 10
    expect(approxTokenCount("a".repeat(40), "en")).toBe(10);
  });

  test("chinese ~1.7 chars/token, conservative rounding", () => {
    // 17 chars / 1.7 = 10
    expect(approxTokenCount("字".repeat(17), "zh")).toBe(10);
    // 2 chars / 1.7 = 1.18 → 至少 1
    expect(approxTokenCount("字".repeat(2), "zh")).toBe(1);
  });

  test("empty is 0", () => {
    expect(approxTokenCount("", "en")).toBe(0);
  });

  test("unknown lang falls back to mixed ratio", () => {
    // 30 chars / 3.0 = 10
    expect(approxTokenCount("a".repeat(30), "fr")).toBe(10);
  });
});

describe("detectLanguage", () => {
  test("english text", () => {
    expect(detectLanguage("The quick brown fox jumps over the lazy dog")).toBe(
      "en",
    );
  });

  test("german via umlauts", () => {
    expect(detectLanguage("Schöne Grüße aus München")).toBe("de");
  });

  test("german via stopwords", () => {
    expect(
      detectLanguage("Der Text ist mit dem Beispiel und nicht anders"),
    ).toBe("de");
  });

  test("chinese", () => {
    expect(detectLanguage("这是一段中文文本，用于检测语言")).toBe("zh");
  });

  test("mixed returns mixed (>=15% each)", () => {
    expect(detectLanguage("中文english混合mixed内容content文本text")).toBe(
      "mixed",
    );
  });

  test("no letters returns mixed", () => {
    expect(detectLanguage("12345 67890")).toBe("mixed");
  });
});

describe("charsForTokenLimit", () => {
  test("applies 0.9 safety margin", () => {
    // en: 100 tokens * 4.0 * 0.9 = 360
    expect(charsForTokenLimit(100, "en")).toBe(360);
  });

  test("zero tokens yields 0", () => {
    expect(charsForTokenLimit(0, "en")).toBe(0);
  });
});

describe("profileDocument（profiler_test.go）", () => {
  test("empty profile is all zeros", () => {
    const p = profileDocument("");
    expect(p.totalChars).toBe(0);
    expect(p.totalLines).toBe(0);
    expect(p.mdHeadingTotal).toBe(0);
    expect(p.detectedLangs).toEqual([]);
  });

  test("counts markdown headings by level", () => {
    const text = "# A\n## B\n## C\n### D\nbody";
    const p = profileDocument(text);
    expect(p.mdHeadingCounts.get(1)).toBe(1);
    expect(p.mdHeadingCounts.get(2)).toBe(2);
    expect(p.mdHeadingCounts.get(3)).toBe(1);
    expect(p.mdHeadingTotal).toBe(4);
  });

  test("dominant level: >=3 occurrences wins; else deepest present", () => {
    expect(dominantHeadingLevel(profileDocument("# A\n# B\n# C\n## D"))).toBe(
      1,
    );
    // 只有 1 个 H1 + 1 个 H2：无层级到 3 → 最深出现的（H2）
    expect(dominantHeadingLevel(profileDocument("# A\n## B\nbody"))).toBe(2);
    expect(dominantHeadingLevel(profileDocument("no headings"))).toBe(0);
  });

  test("numbered sections counted", () => {
    const p = profileDocument("1. Intro\n2. Methods\n2.1 Detail\nplain");
    expect(p.numberedSectionCount).toBe(3);
  });

  test("german chapters counted", () => {
    const p = profileDocument("Kapitel 1: Anfang\nKapitel 2: Mitte");
    expect(p.germanChapterCount).toBe(2);
  });

  test("chinese chapters counted", () => {
    const p = profileDocument("第一章 引言\n第三章 方法");
    expect(p.chineseChapterCount).toBe(2);
  });

  test("form feed counted", () => {
    const p = profileDocument("page1\fpage2\fpage3");
    expect(p.formFeedCount).toBe(2);
  });

  test("detects code blocks and ratio", () => {
    const code = "```js\nlet a = 1;\nlet b = 2;\n```";
    const text = `${"word ".repeat(10)}\n${code}`;
    const p = profileDocument(text);
    expect(p.hasCode).toBe(true);
    expect(p.codeRatio).toBeGreaterThan(0);
    expect(p.codeRatio).toBeLessThan(1);
  });

  test("detects tables", () => {
    const p = profileDocument("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(p.hasTables).toBe(true);
  });

  test("line statistics", () => {
    const p = profileDocument("short\nmuch longer line here\nmid line");
    expect(p.totalLines).toBe(3);
    expect(p.avgLineLen).toBeGreaterThan(5);
    expect(p.stdLineLen).toBeGreaterThan(0);
  });
});

describe("selectStrategy", () => {
  test("heading-heavy doc gets heading tier first", () => {
    const text = Array.from({ length: 8 }, (_, i) => `# H${i}\nbody`).join(
      "\n",
    );
    const chain = selectStrategy(profileDocument(text));
    expect(chain[0]).toBe("heading");
    expect(chain[chain.length - 1]).toBe("legacy");
  });

  test("marker-heavy doc gets heuristic tier", () => {
    const text = Array.from(
      { length: 8 },
      (_, i) => `1. Point ${i}\nbody`,
    ).join("\n");
    const chain = selectStrategy(profileDocument(text));
    expect(chain).toContain("heuristic");
  });

  test("plain doc goes straight to legacy", () => {
    const chain = selectStrategy(
      profileDocument("plain prose only. ".repeat(20)),
    );
    expect(chain).toEqual(["legacy"]);
  });

  test("null profile falls back to legacy only", () => {
    expect(selectStrategy(null)).toEqual(["legacy"]);
  });
});
