import { describe, expect, test } from "bun:test";
import {
  applyOverlapAligned,
  dropBoundsInsideSpans,
  findHeuristicBoundaries,
  splitByHeuristicsImpl,
} from "./heuristic-splitter";
import { defaultConfig, runeLen } from "./splitter";

/** WeKnora heuristic_splitter_test.go 用例平移。 */

const cfg = { ...defaultConfig(), chunkSize: 512, chunkOverlap: 80 };

describe("findHeuristicBoundaries", () => {
  test("form feed is the strongest boundary", () => {
    const text = "第一段内容\f第二段内容";
    const bounds = findHeuristicBoundaries(text, []);
    expect(bounds.some((b) => b.runeStart === text.indexOf("\f"))).toBe(true);
  });

  test("chinese chapter markers detected (第一章/第3节)", () => {
    const text = "前言。\n第一章 概述\n内容。\n第 3 节 详情\n更多内容。";
    const bounds = findHeuristicBoundaries(text, ["zh"]);
    const starts = bounds.map((b) => b.runeStart);
    expect(starts).toContain(text.indexOf("第一章"));
    expect(starts).toContain(text.indexOf("第 3 节"));
  });

  test("english chapter markers detected", () => {
    const text =
      "Intro text.\nChapter 1 Beginning\nBody.\nSection 2 More\nEnd.";
    const bounds = findHeuristicBoundaries(text, ["en"]);
    const starts = bounds.map((b) => b.runeStart);
    expect(starts).toContain(text.indexOf("Chapter 1"));
    expect(starts).toContain(text.indexOf("Section 2"));
  });

  test("numbered sections and all-caps headings detected", () => {
    const text =
      "text\n1. Introduction here\nmore\n2.3 Methods described\nplain\nOVERVIEW SECTION\nend";
    const bounds = findHeuristicBoundaries(text, []);
    const starts = bounds.map((b) => b.runeStart);
    expect(starts).toContain(text.indexOf("1. Introduction"));
    expect(starts).toContain(text.indexOf("2.3 Methods"));
    expect(starts).toContain(text.indexOf("OVERVIEW"));
  });

  test("visual separators and page footers detected", () => {
    const text = "para one\n----------\npara two\nPage 3 of 10\npara three";
    const bounds = findHeuristicBoundaries(text, []);
    const starts = bounds.map((b) => b.runeStart);
    expect(starts).toContain(text.indexOf("----------"));
    expect(starts).toContain(text.indexOf("Page 3 of 10"));
  });

  test("markers inside fenced code blocks are skipped", () => {
    const text = "text\n```\nChapter 9 Inside Code\n```\nafter";
    const bounds = findHeuristicBoundaries(text, ["en"]);
    expect(
      bounds.some((b) => text.slice(b.runeStart).startsWith("Chapter 9")),
    ).toBe(false);
  });

  test("excessive blanks produce a boundary at run end", () => {
    const text = "第一段。\n\n\n\n第二段。";
    const bounds = findHeuristicBoundaries(text, []);
    const b = bounds.find((x) => x.runeStart === text.indexOf("第二段"));
    expect(b).toBeDefined();
  });

  test("duplicate offsets keep a single (highest-priority) boundary", () => {
    // 换页后紧跟三个换行：\f 边界(100) 与 \n{3,} run 结束边界(40) 同偏移。
    const text = "段落。\n\f\n\n\n下一块内容。";
    const runes = Array.from(text);
    const feedOffset = runes.indexOf("\f");
    const afterFeed = feedOffset + 1 + 3; // \f 之后紧跟 \n\n\n → run 结束同偏移处
    const bounds = findHeuristicBoundaries(text, []);
    const atSame = bounds.filter((b) => b.runeStart === afterFeed);
    expect(atSame.length).toBe(1);
  });
});

describe("dropBoundsInsideSpans", () => {
  test("drops bounds strictly inside spans, keeps edge-aligned ones", () => {
    const spans = [
      { start: 10, end: 30 },
      { start: 50, end: 60 },
    ];
    const bounds = [
      { runeStart: 15, priority: 1 }, // 内部 → 丢
      { runeStart: 10, priority: 1 }, // 边缘 → 留
      { runeStart: 30, priority: 1 }, // 边缘 → 留
      { runeStart: 40, priority: 1 }, // 区间外 → 留
      { runeStart: 55, priority: 1 }, // 内部 → 丢
    ];
    const out = dropBoundsInsideSpans(bounds, spans);
    expect(out.map((b) => b.runeStart)).toEqual([10, 30, 40]);
  });
});

describe("applyOverlapAligned", () => {
  const runes = Array.from("aaaa\nbbbb\ncccc\ndddd");

  test("prefers the nearest boundary inside the 2x overlap window", () => {
    const bounds = [
      { runeStart: 5, priority: 1 },
      { runeStart: 10, priority: 1 },
    ];
    // curEnd=15, overlap=4 → target 11, window [7,15)：最近边界 10
    expect(applyOverlapAligned(runes, 15, 4, bounds)).toBe(10);
  });

  test("falls back to the previous newline before the target", () => {
    const bounds: { runeStart: number; priority: number }[] = [];
    // curEnd=14, overlap=4 → target 10, 无边界 → 从 10 向前找 \n（index 9）→ 10
    expect(applyOverlapAligned(runes, 14, 4, bounds)).toBe(10);
  });

  test("zero overlap returns curEnd", () => {
    expect(applyOverlapAligned(runes, 14, 0, [])).toBe(14);
  });
});

describe("splitByHeuristicsImpl", () => {
  test("no boundaries falls through to legacy", () => {
    const text = `普通段落。${"无结构标记的内容。".repeat(40)}`;
    const out = splitByHeuristicsImpl(
      text,
      { ...cfg, chunkSize: 100, chunkOverlap: 20 },
      null,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(runeLen(c.content)).toBe(c.end - c.start);
  });

  test("oversize blocks between boundaries delegate to legacy inner split", () => {
    const bigBlock = Array.from(
      { length: 30 },
      (_, i) => `普通行${i}没有结构`,
    ).join("\n");
    const text = `第一章 开始\n${bigBlock}\n第二章 结束\n${bigBlock}`;
    const out = splitByHeuristicsImpl(
      text,
      { ...cfg, chunkSize: 120, chunkOverlap: 20 },
      null,
    );
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) {
      expect(runeLen(c.content)).toBe(c.end - c.start);
      expect(runeLen(c.content)).toBeLessThanOrEqual(7500);
    }
  });

  test("overlap actually overlaps (WeKnora regression: 重叠真实存在)", () => {
    // 边界间隔小于 chunkSize 的均匀结构：chunk 间应有内容重叠
    const sections = Array.from(
      { length: 24 },
      (_, i) => `第${i + 1}节 标题\n${"节内容填充。".repeat(8)}`,
    );
    const text = sections.join("\n");
    const out = splitByHeuristicsImpl(
      text,
      { ...cfg, chunkSize: 150, chunkOverlap: 40 },
      null,
    );
    expect(out.length).toBeGreaterThan(1);
    let overlapFound = false;
    for (let i = 1; i < out.length; i += 1) {
      // 下一 chunk 的起点早于上一 chunk 的终点 = 有重叠
      if (out[i].start < out[i - 1].end) overlapFound = true;
    }
    expect(overlapFound).toBe(true);
  });
});
