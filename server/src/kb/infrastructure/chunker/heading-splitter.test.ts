import { describe, expect, test } from "../../../../../tests/support/e2e-compat";
import { HeadingHierarchy } from "./heading-hierarchy";
import {
  breadcrumbAtOffset,
  coalesceTinyChunks,
  commonHeadingPrefix,
  findHeadingBoundaries,
  sectionBreadcrumbs,
  splitByHeadingsImpl,
} from "./heading-splitter";
import { profileDocument } from "./profiler";
import { type Chunk, defaultConfig, runeLen, splitText } from "./splitter";

/** WeKnora heading_hierarchy_test.go + heading_splitter_test.go 用例平移。 */

describe("HeadingHierarchy（heading_hierarchy_test.go）", () => {
  test("linear nesting accumulates the stack", () => {
    const h = new HeadingHierarchy();
    expect(h.observe("# Top")).toEqual([1, "Top"]);
    expect(h.observe("## Section")).toEqual([2, "Section"]);
    expect(h.observe("### Sub")).toEqual([3, "Sub"]);
    expect(h.breadcrumb()).toBe("Top > Section > Sub");
    expect(h.breadcrumbWithHashes()).toBe("# Top\n## Section\n### Sub");
    expect(h.depth()).toBe(3);
  });

  test("sibling heading pops deeper levels", () => {
    const h = new HeadingHierarchy();
    h.observe("# Top");
    h.observe("## A");
    h.observe("### A1");
    h.observe("## B"); // pops A1 and A
    expect(h.depth()).toBe(2);
    expect(h.breadcrumb()).toBe("Top > B");
  });

  test("new top-level pops everything", () => {
    const h = new HeadingHierarchy();
    h.observe("# One");
    h.observe("## Deep");
    h.observe("# Two");
    expect(h.depth()).toBe(1);
    expect(h.breadcrumb()).toBe("Two");
  });

  test("non-heading lines are ignored", () => {
    const h = new HeadingHierarchy();
    expect(h.observe("plain text")).toEqual([0, ""]);
    expect(h.observe("####### seven hashes")).toEqual([0, ""]); // >6 级
    expect(h.depth()).toBe(0);
    expect(h.breadcrumb()).toBe("");
  });

  test("skip levels keeps ancestors (sparse hierarchy)", () => {
    const h = new HeadingHierarchy();
    h.observe("# Top");
    h.observe("### Deep without H2");
    expect(h.breadcrumb()).toBe("Top > Deep without H2");
    expect(h.depth()).toBe(3);
  });

  test("reset clears all state", () => {
    const h = new HeadingHierarchy();
    h.observe("# A");
    h.reset();
    expect(h.depth()).toBe(0);
    expect(h.breadcrumb()).toBe("");
  });

  test("clone snapshots independently", () => {
    const h = new HeadingHierarchy();
    h.observe("# Top");
    const snap = h.snapshot();
    h.observe("## Later");
    expect(snap.breadcrumb()).toBe("Top");
    expect(h.breadcrumb()).toBe("Top > Later");
  });
});

describe("splitByHeadingsImpl（heading_splitter_test.go）", () => {
  const cfg = { ...defaultConfig(), chunkSize: 512, chunkOverlap: 80 };

  test("sections split at dominant heading level with breadcrumb context", () => {
    const text = [
      "# 第一章 总则",
      "第一章的正文内容，说明总体目标与适用范围。".repeat(6),
      "## 1.1 目标",
      "目标小节内容，描述系统要达成的指标。".repeat(6),
      "# 第二章 流程",
      "第二章正文，描述端到端流程步骤。".repeat(6),
    ].join("\n\n");
    const profile = profileDocument(text);
    const chunks = splitByHeadingsImpl(text, cfg, profile);
    expect(chunks.length).toBeGreaterThan(1);
    // 每个 chunk 的 contextHeader 反映其所在章节路径
    const chapter1 = chunks.find((c) => c.content.includes("第一章的正文内容"));
    expect(chapter1?.contextHeader).toContain("# 第一章 总则");
    const chapter2 = chunks.find((c) => c.content.includes("第二章正文"));
    expect(chapter2?.contextHeader).toContain("# 第二章 流程");
    // 面包屑不含第二章（层级正确弹出）
    expect(chapter2?.contextHeader.includes("1.1")).toBe(false);
    // 1.1 小节：小节与其父章同 chunk（coalesce 合并，子标题行保留在 Content 中）
    // 或独立 chunk（面包屑含两级路径）——两种都符合 WeKnora 语义。
    const sub = chunks.find((c) => c.content.includes("目标小节内容"));
    expect(sub).toBeDefined();
    if (sub?.content.includes("# 第一章 总则")) {
      // 合并形态：子标题行在 Content 里可见
      expect(sub.content).toContain("## 1.1 目标");
    } else {
      // 独立形态：面包屑含完整路径
      expect(sub?.contextHeader).toContain("# 第一章 总则");
      expect(sub?.contextHeader).toContain("## 1.1 目标");
    }
    // 注：节 Content 含标题行本身（WeKnora heading_splitter 同款——标题行
    // 是节的原文起点，End-Start==len(Content) 由节区间天然保证）。
  });

  test("large section defers to legacy splitter with sub-breadcrumbs", () => {
    const bigSection = Array.from(
      { length: 40 },
      (_, i) => `要点${i}：${"详细展开说明。".repeat(12)}`,
    ).join("\n");
    const text = `# 概述\n\n简短引言。\n\n# 大节\n\n${bigSection}`;
    const profile = profileDocument(text);
    const chunks = splitByHeadingsImpl(text, cfg, profile);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(runeLen(c.content)).toBe(c.end - c.start);
  });

  test("no headings falls through to legacy", () => {
    const text = `纯文本段落一。${"内容甲。".repeat(30)}\n\n纯文本段落二。${"内容乙。".repeat(30)}`;
    const chunks = splitByHeadingsImpl(text, cfg, profileDocument(text));
    const legacy = splitText(text, cfg);
    expect(chunks).toEqual(legacy);
  });

  test("headings inside fenced code blocks are not boundaries", () => {
    const text = [
      "# 真标题",
      "正文。",
      "```markdown",
      "# 代码块里的假标题",
      "```",
      "更多正文内容。".repeat(10),
    ].join("\n");
    const bounds = findHeadingBoundaries(text, 1);
    const headingLines = bounds.map((b) => b.line).filter((l) => l !== "");
    expect(headingLines).toEqual(["# 真标题"]);
  });
});

describe("coalesceTinyChunks", () => {
  const mk = (
    content: string,
    start: number,
    end: number,
    header = "",
  ): Chunk => ({
    content,
    contextHeader: header,
    seq: 0,
    start,
    end,
  });

  test("merges adjacent small chunks sharing a header prefix, re-sequences", () => {
    const input = [
      mk("AAA", 0, 3, "# H"),
      mk("BBB", 3, 6, "# H"),
      mk("CCC", 6, 9, "# H"),
    ];
    const out = coalesceTinyChunks(input, 512);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe("AAABBBCCC");
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(9);
    expect(out[0].seq).toBe(0);
  });

  test("does not merge across a gap (non-adjacent offsets)", () => {
    const input = [
      mk("AAA", 0, 3, "# H"),
      mk("BBB", 10, 13, "# H"), // 不相邻
    ];
    const out = coalesceTinyChunks(input, 512);
    expect(out.length).toBe(2);
  });

  test("does not merge when headers diverge", () => {
    const input = [mk("AAA", 0, 3, "# H1"), mk("BBB", 3, 6, "# H2")];
    const out = coalesceTinyChunks(input, 512);
    expect(out.length).toBe(2);
  });

  test("stops merging at the size budget", () => {
    const input = [
      mk("A".repeat(200), 0, 200, "# H"),
      mk("B".repeat(200), 200, 400, "# H"),
      mk("C".repeat(200), 400, 600, "# H"),
    ];
    const out = coalesceTinyChunks(input, 512); // target=256
    expect(out.length).toBe(2);
    expect(out[0].content.length).toBe(400); // 200+200 ≤512，再并 600 会超
    expect(out[1].content.length).toBe(200);
  });
});

describe("breadcrumb helpers", () => {
  test("commonHeadingPrefix finds longest line-aligned shared prefix", () => {
    expect(commonHeadingPrefix("# A\n## B", "# A\n## B")).toBe("# A\n## B");
    expect(commonHeadingPrefix("# A\n## B", "# A\n## C")).toBe("# A");
    expect(commonHeadingPrefix("# A", "# B")).toBe("");
  });

  test("sectionBreadcrumbs + breadcrumbAtOffset resolve deepest active heading", () => {
    const section =
      "# Section\n\nbefore\n\n### Deep A\n\ncontent under A\n\n#### Deeper\n\nmore"
        .split("\n\n")
        .join("\n\n");
    const runes = Array.from(section);
    const h = new HeadingHierarchy();
    h.observe("# Section");
    const bcs = sectionBreadcrumbs(runes, 1, h);
    expect(bcs.length).toBe(3); // seed + ### Deep A + #### Deeper
    expect(bcs[0].breadcrumb).toBe("# Section");
    // offset 0 → seed；Deep A 之后 → 其路径；Deeper 之后 → 最深路径
    const deepAOffset = runes.join("").indexOf("### Deep A");
    expect(breadcrumbAtOffset(bcs, 0, "fallback")).toBe("# Section");
    expect(breadcrumbAtOffset(bcs, deepAOffset, "fallback")).toContain(
      "### Deep A",
    );
    const deeperOffset = runes.join("").indexOf("#### Deeper");
    const atDeeper = breadcrumbAtOffset(bcs, deeperOffset, "fallback");
    expect(atDeeper).toContain("#### Deeper");
    expect(atDeeper).toContain("### Deep A");
  });
});
