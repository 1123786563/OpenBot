/**
 * 文档画像与策略选择：WeKnora chunker/profiler.go 直译。
 * 切分前一次轻量扫描（几遍正则 + rune 计数），产出结构信号供
 * SelectStrategy 决定 heading/heuristic/legacy 层级链。
 */

import { markdownHeadingPattern } from "./patterns";
import {
  allCapsHeadingPattern,
  chineseChapterPattern,
  englishChapterPattern,
  formFeedPatternLike,
  germanChapterPattern,
  numberedSectionPattern,
  pageFooterPattern,
  visualSeparatorPattern,
} from "./profiler-helpers";
import { detectLanguage } from "./tokens";

export type DocProfile = {
  totalChars: number;
  totalLines: number;
  avgLineLen: number;
  stdLineLen: number;
  mdHeadingCounts: Map<number, number>;
  mdHeadingTotal: number;
  numberedSectionCount: number;
  allCapsShortLineCount: number;
  blankParagraphBreaks: number;
  formFeedCount: number;
  visualSepCount: number;
  germanChapterCount: number;
  englishChapterCount: number;
  chineseChapterCount: number;
  repeatedFooterCount: number;
  hasTables: boolean;
  hasCode: boolean;
  codeRatio: number;
  detectedLangs: string[];
};

export function headingDensity(p: DocProfile): number {
  if (p.totalLines === 0) return 0;
  return p.mdHeadingTotal / p.totalLines;
}

/**
 * 驱动章节切分的标题层级：优先取出现 ≥3 次的最浅层级（文档的结构主干）；
 * 否则取最深的出现过的层级（小文档 H1+几个 H2 时给更细边界）。无标题返回 0。
 */
export function dominantHeadingLevel(p: DocProfile): number {
  if (p.mdHeadingTotal === 0) return 0;
  for (let level = 1; level <= 6; level += 1) {
    if ((p.mdHeadingCounts.get(level) ?? 0) >= 3) return level;
  }
  for (let level = 6; level >= 1; level -= 1) {
    if ((p.mdHeadingCounts.get(level) ?? 0) > 0) return level;
  }
  return 0;
}

export function heuristicMarkerTotal(p: DocProfile): number {
  return (
    p.numberedSectionCount +
    p.germanChapterCount +
    p.englishChapterCount +
    p.chineseChapterCount +
    p.allCapsShortLineCount +
    p.visualSepCount +
    p.formFeedCount
  );
}

export function profileDocument(text: string): DocProfile {
  const p: DocProfile = {
    totalChars: 0,
    totalLines: 0,
    avgLineLen: 0,
    stdLineLen: 0,
    mdHeadingCounts: new Map(),
    mdHeadingTotal: 0,
    numberedSectionCount: 0,
    allCapsShortLineCount: 0,
    blankParagraphBreaks: 0,
    formFeedCount: 0,
    visualSepCount: 0,
    germanChapterCount: 0,
    englishChapterCount: 0,
    chineseChapterCount: 0,
    repeatedFooterCount: 0,
    hasTables: false,
    hasCode: false,
    codeRatio: 0,
    detectedLangs: [],
  };
  if (text === "") return p;

  let runeCount = 0;
  for (const _ of text) runeCount += 1;
  p.totalChars = runeCount;
  p.formFeedCount = countOccurrences(text, "\f");

  const lines = text.split("\n");
  p.totalLines = lines.length;

  const lengths: number[] = [];
  let inFence = false;
  let codeChars = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      p.hasCode = true;
      continue;
    }
    if (inFence) {
      for (const _ of line) codeChars += 1;
      continue;
    }

    let lineRunes = 0;
    for (const _ of line) lineRunes += 1;
    lengths.push(lineRunes);

    if (matchHeading(line, p.mdHeadingCounts)) {
      p.mdHeadingTotal += 1;
      continue;
    }
    if (numberedSectionPattern.test(line)) p.numberedSectionCount += 1;
    if (germanChapterPattern.test(line)) p.germanChapterCount += 1;
    if (englishChapterPattern.test(line)) p.englishChapterCount += 1;
    if (chineseChapterPattern.test(line)) p.chineseChapterCount += 1;
    if (allCapsHeadingPattern.test(line)) p.allCapsShortLineCount += 1;
    if (visualSeparatorPattern.test(line)) p.visualSepCount += 1;
    if (pageFooterPattern.test(line)) p.repeatedFooterCount += 1;
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) p.hasTables = true;
  }

  if (lengths.length > 0) {
    let sum = 0;
    for (const l of lengths) sum += l;
    p.avgLineLen = sum / lengths.length;
    let variance = 0;
    for (const l of lengths) {
      const d = l - p.avgLineLen;
      variance += d * d;
    }
    variance /= lengths.length;
    p.stdLineLen = Math.sqrt(variance);
  }

  if (p.totalChars > 0) p.codeRatio = codeChars / p.totalChars;

  p.blankParagraphBreaks = countOccurrences(text, "\n\n\n");

  // 语言检测取样（≤4096），避免大输入 O(N) 扫描。
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  const lang = detectLanguage(sample);
  p.detectedLangs = [lang];
  if (lang === "mixed") {
    p.detectedLangs = ["en", "de", "zh"];
  }

  return p;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function matchHeading(line: string, counts: Map<number, number>): boolean {
  const m = markdownHeadingPattern.exec(line);
  if (m === null) return false;
  const level = m[1].length;
  if (level < 1 || level > 6) return false;
  counts.set(level, (counts.get(level) ?? 0) + 1);
  return true;
}

export type StrategyTier = "heading" | "heuristic" | "legacy";

/** 有序层级链：首选 + 失败回退，legacy 永远兜底（调用方至少拿到一个结果）。 */
export function selectStrategy(p: DocProfile | null): StrategyTier[] {
  if (p === null) return ["legacy"];
  const chain: StrategyTier[] = [];

  if (
    p.mdHeadingTotal >= 3 &&
    headingDensity(p) > 0.005 &&
    dominantHeadingLevel(p) > 0
  ) {
    chain.push("heading");
  }
  if (
    heuristicMarkerTotal(p) >= 5 ||
    p.formFeedCount > 0 ||
    p.germanChapterCount + p.englishChapterCount + p.chineseChapterCount > 0
  ) {
    chain.push("heuristic");
  }
  chain.push("legacy");
  return chain;
}

// formFeedPattern 仅以字符计数形式使用；占位导出防止未用 import（正则对象本身在 helpers 中定义）。
export const _formFeedUsed = formFeedPatternLike;
