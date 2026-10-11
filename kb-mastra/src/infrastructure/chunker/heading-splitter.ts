/**
 * Tier 1：Markdown 标题感知切分。WeKnora chunker/heading_splitter.go 直译。
 * 有正规标题结构的文档按标题边界切，每个 chunk 携带活动标题面包屑
 * （ContextHeader，不进 Content，保住 End-Start==len(Content) 不变量）。
 * 段落超预算时交给 legacy 切分器做内部分段，子 chunk 面包屑反映其起始处
 * 最深的活动标题。
 */
import { HeadingHierarchy } from "./heading-hierarchy";
import { markdownHeadingPattern } from "./patterns";
import {
  type DocProfile,
  dominantHeadingLevel,
  profileDocument,
} from "./profiler";
import {
  type Chunk,
  runeLen,
  type SplitterConfig,
  splitText,
} from "./splitter";

type HeadingBoundary = {
  runeStart: number;
  line: string; // 原始标题行；"" 表示首边界
};

export function splitByHeadingsImpl(
  text: string,
  cfg: SplitterConfig,
  profile: DocProfile | null,
): Chunk[] {
  if (text === "") return [];
  const prof = profile ?? profileDocument(text);
  const primaryLevel = dominantHeadingLevel(prof);
  if (primaryLevel === 0) return splitText(text, cfg);

  const bounds = findHeadingBoundaries(text, primaryLevel);
  if (bounds.length <= 1) return splitText(text, cfg);

  const runes = Array.from(text);
  const hierarchy = new HeadingHierarchy();

  const out: Chunk[] = [];
  let seq = 0;

  for (let i = 0; i < bounds.length; i += 1) {
    const b = bounds[i];
    const endRune =
      i + 1 < bounds.length ? bounds[i + 1].runeStart : runes.length;
    if (b.line !== "") hierarchy.observe(b.line);
    // 面包屑在本节起点快照；节内更深的子标题只更新层级、不改本节面包屑。
    const breadcrumb = hierarchy.breadcrumbWithHashes();
    const sectionStart = hierarchy.snapshot();
    observeSubHeadings(
      runes.slice(b.runeStart, endRune).join(""),
      primaryLevel,
      hierarchy,
    );

    const sectionRunes = runes.slice(b.runeStart, endRune);
    const sectionContent = sectionRunes.join("");
    const secLen = sectionRunes.length;
    if (secLen === 0) continue;

    const bcLen = runeLen(breadcrumb);
    // 单 chunk 节：整节输出，面包屑单独跟踪（不占 Content 尺寸）。
    if (bcLen + 2 + secLen <= cfg.chunkSize) {
      out.push({
        content: sectionContent,
        contextHeader: breadcrumb,
        seq,
        start: b.runeStart,
        end: endRune,
      });
      seq += 1;
      continue;
    }

    // 节太大：legacy 切分器做内部分段（不缩 Content 预算——面包屑不计入）。
    const subBreadcrumbs = sectionBreadcrumbs(
      sectionRunes,
      primaryLevel,
      sectionStart,
    );
    const subChunks = splitText(sectionContent, cfg);
    for (const sub of subChunks) {
      out.push({
        content: sub.content,
        contextHeader: breadcrumbAtOffset(
          subBreadcrumbs,
          sub.start,
          breadcrumb,
        ),
        seq,
        start: b.runeStart + sub.start,
        end: b.runeStart + sub.end,
      });
      seq += 1;
    }
  }

  return coalesceTinyChunks(out, cfg.chunkSize);
}

/**
 * 合并相邻小 chunk（共享标题上下文），避免主节普遍偏短的文档（FAQ/安装日志/
 * 变更清单）触发 validator 的「过多小 chunk」而一路跌到 legacy。
 * 安全性：仅 cur.end === next.start 时合并（保住位置不变量，天然跳过可能
 * 有 overlap 的 legacy 子 chunk）；运行尺寸到 merge target（≈ChunkSize/2）即停。
 */
export function coalesceTinyChunks(input: Chunk[], chunkSize: number): Chunk[] {
  if (input.length <= 1 || chunkSize <= 0) return input;
  let target = Math.floor(chunkSize / 2);
  if (target < 200) target = 200;

  const out: Chunk[] = [];
  let cur = { ...input[0] };
  let curLen = runeLen(cur.content);

  for (let i = 1; i < input.length; i += 1) {
    const next = input[i];
    const nextLen = runeLen(next.content);
    const sharedHeader = commonHeadingPrefix(
      cur.contextHeader,
      next.contextHeader,
    );
    if (
      sharedHeader !== "" &&
      cur.end === next.start &&
      curLen < target &&
      curLen + nextLen <= chunkSize
    ) {
      cur = {
        ...cur,
        content: cur.content + next.content,
        contextHeader: sharedHeader,
        end: next.end,
      };
      curLen += nextLen;
      continue;
    }
    out.push(cur);
    cur = { ...next };
    curLen = nextLen;
  }
  out.push(cur);

  for (let i = 0; i < out.length; i += 1) out[i].seq = i;
  return out;
}

/** 两个面包屑的最长行对齐公共前缀。 */
export function commonHeadingPrefix(a: string, b: string): string {
  if (a === b) return a;
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.min(la.length, lb.length);
  let common = 0;
  for (let i = 0; i < n; i += 1) {
    if (la[i] !== lb[i]) break;
    common = i + 1;
  }
  if (common === 0) return "";
  return la.slice(0, common).join("\n");
}

/**
 * 偏移 0 一个边界 + 每个 level ≤ primaryLevel 且不在围栏代码块内的标题一个边界。
 * 标题检测按整行进行。
 */
export function findHeadingBoundaries(
  text: string,
  primaryLevel: number,
): HeadingBoundary[] {
  const runes = Array.from(text);
  const bounds: HeadingBoundary[] = [{ runeStart: 0, line: "" }];
  if (runes.length === 0) return bounds;

  let pos = 0;
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      pos += runeLen(line);
      if (i < lines.length - 1) pos += 1;
      continue;
    }
    if (!inFence) {
      const m = markdownHeadingPattern.exec(line);
      if (m !== null) {
        const level = m[1].length;
        if (level >= 1 && level <= primaryLevel && pos > 0) {
          bounds.push({ runeStart: pos, line });
        }
        if (level >= 1 && level <= primaryLevel && pos === 0) {
          bounds[0].line = line;
        }
      }
    }
    pos += runeLen(line);
    if (i < lines.length - 1) pos += 1;
  }
  return bounds;
}

/** 把节内 level > primaryLevel 的子标题喂给层级栈，保持后续节面包屑正确。 */
export function observeSubHeadings(
  sectionText: string,
  primaryLevel: number,
  h: HeadingHierarchy,
): void {
  if (sectionText === "") return;
  let inFence = false;
  for (const line of sectionText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = markdownHeadingPattern.exec(line);
    if (m === null) continue;
    if (m[1].length > primaryLevel) h.observe(line);
  }
}

type SectionBreadcrumb = { runeStart: number; breadcrumb: string };

/**
 * 遍历节内更深的子标题（level > primaryLevel），记录各自生效的 rune 偏移与
 * 面包屑。seed 是节起点的层级状态（已含节标题及其祖先）。结果按 runeStart
 * 升序且总是以 seed 面包屑（偏移 0）开头。
 */
export function sectionBreadcrumbs(
  sectionRunes: string[],
  primaryLevel: number,
  seed: HeadingHierarchy,
): SectionBreadcrumb[] {
  const h = seed.clone();
  const result: SectionBreadcrumb[] = [
    { runeStart: 0, breadcrumb: h.breadcrumbWithHashes() },
  ];
  let pos = 0;
  let inFence = false;
  const lines = sectionRunes.join("").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      pos += runeLen(line);
      if (i < lines.length - 1) pos += 1;
      continue;
    }
    if (!inFence) {
      const m = markdownHeadingPattern.exec(line);
      if (m !== null && m[1].length > primaryLevel) {
        h.observe(line);
        result.push({ runeStart: pos, breadcrumb: h.breadcrumbWithHashes() });
      }
    }
    pos += runeLen(line);
    if (i < lines.length - 1) pos += 1;
  }
  return result;
}

/** 偏移处生效的面包屑：最后一个 runeStart ≤ offset 的条目。 */
export function breadcrumbAtOffset(
  bcs: SectionBreadcrumb[],
  offset: number,
  fallback: string,
): string {
  let bc = fallback;
  for (const e of bcs) {
    if (e.runeStart > offset) break;
    bc = e.breadcrumb;
  }
  return bc;
}
