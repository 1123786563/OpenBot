/**
 * Tier 2：启发式边界驱动切分。WeKnora chunker/heuristic_splitter.go 直译。
 * 无 Markdown 标题但有可识别结构线索（换页/编号节/多语言章节标记/分隔线/
 * 全大写题名/页脚）的文档：找全部候选边界 → 贪心装箱（装到下一块超预算），
 * 超预算块递归交给 legacy 切分器。保护区（表格/代码/公式）内的边界丢弃。
 */
import {
  allCapsHeadingPattern,
  chapterPatternsForLangs,
  numberedSectionPattern,
  PRIO_ALL_CAPS_HEADING,
  PRIO_BLANK_BLOCK,
  PRIO_CHAPTER_MARKER,
  PRIO_FORM_FEED,
  PRIO_NUMBERED_HEAD,
  PRIO_PAGE_FOOTER,
  PRIO_VISUAL_SEP,
  pageFooterPattern,
  visualSeparatorPattern,
} from "./patterns";
import type { DocProfile } from "./profiler";
import {
  type Chunk,
  protectedSpansRune,
  runeLen,
  type Span,
  type SplitterConfig,
  splitText,
} from "./splitter";

type Boundary = { runeStart: number; priority: number };

export function splitByHeuristicsImpl(
  text: string,
  cfg: SplitterConfig,
  _profile: DocProfile | null,
): Chunk[] {
  if (text === "") return [];
  const runes = Array.from(text);
  const totalRunes = runes.length;
  if (totalRunes <= cfg.chunkSize) return splitText(text, cfg);

  let bounds = findHeuristicBoundaries(text, cfg.languages);
  // 丢弃严格落在保护区内部（非边缘）的边界——在那里切会切断原子内容。
  const prot = protectedSpansRune(text);
  if (prot.length > 0) bounds = dropBoundsInsideSpans(bounds, prot);
  if (bounds.length === 0) return splitText(text, cfg);

  // 文末哨兵让装箱器能 flush；开头无 0 边界则补。
  bounds.push({ runeStart: totalRunes, priority: 0 });
  if (bounds[0].runeStart !== 0) bounds.unshift({ runeStart: 0, priority: 0 });

  // 贪心装箱。
  const out: Chunk[] = [];
  let seq = 0;
  let chunkStart = bounds[0].runeStart;
  let curEnd = chunkStart;
  let minChunkSize = Math.floor(cfg.chunkSize / 4);
  if (minChunkSize < 50) minChunkSize = 50;

  for (let i = 1; i < bounds.length; i += 1) {
    const nextEnd = bounds[i].runeStart;
    const blockLen = nextEnd - curEnd;

    if (blockLen > cfg.chunkSize) {
      // 上一边界到本边界之间的块本身就超预算：flush 已积累内容，块递归切分。
      if (curEnd - chunkStart > 0) {
        appendChunk(out, runes, chunkStart, curEnd, () => (seq += 1));
        chunkStart = curEnd;
      }
      seq = appendOversizeBlock(out, runes, curEnd, nextEnd, cfg, seq);
      curEnd = nextEnd;
      chunkStart = nextEnd;
      continue;
    }

    // 加入本块会超预算？
    const accumulated = nextEnd - chunkStart;
    if (accumulated > cfg.chunkSize && curEnd - chunkStart >= minChunkSize) {
      appendChunk(out, runes, chunkStart, curEnd, () => (seq += 1));
      // overlap 起点对齐最近的语义边界或换行，不切在行中/词中。
      chunkStart = applyOverlapAligned(runes, curEnd, cfg.chunkOverlap, bounds);
    }
    curEnd = nextEnd;
  }

  if (curEnd > chunkStart) {
    appendChunk(out, runes, chunkStart, curEnd, () => (seq += 1));
  }
  return out;
}

/** 升序边界；同偏移丢弃低优先级重复。 */
export function findHeuristicBoundaries(
  text: string,
  langs: string[],
): Boundary[] {
  const bounds: Boundary[] = [];

  // 换页符：最强单字符边界。
  let pos = 0;
  for (const r of text) {
    if (r === "\f") bounds.push({ runeStart: pos, priority: PRIO_FORM_FEED });
    pos += 1;
  }

  // 逐行模式。
  const lines = text.split("\n");
  const chapterPatterns = chapterPatternsForLangs(langs);
  let linePos = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence) {
      const runeStart = linePos;
      let added = false;
      for (const pat of chapterPatterns) {
        if (pat.test(line)) {
          bounds.push({ runeStart, priority: PRIO_CHAPTER_MARKER });
          added = true;
          break;
        }
      }
      if (!added && numberedSectionPattern.test(line)) {
        bounds.push({ runeStart, priority: PRIO_NUMBERED_HEAD });
        added = true;
      }
      if (!added && allCapsHeadingPattern.test(line)) {
        bounds.push({ runeStart, priority: PRIO_ALL_CAPS_HEADING });
        added = true;
      }
      if (!added && visualSeparatorPattern.test(line)) {
        bounds.push({ runeStart, priority: PRIO_VISUAL_SEP });
        added = true;
      }
      if (!added && pageFooterPattern.test(line)) {
        bounds.push({ runeStart, priority: PRIO_PAGE_FOOTER });
      }
    }
    linePos += runeLen(line);
    if (i < lines.length - 1) linePos += 1;
  }

  // 连续空行（\n{3,}）：匹配 run 的结束处（干净落入下一段）。
  for (const m of text.matchAll(/\n{3,}/g)) {
    if (m.index === undefined) continue;
    const runeStart = runeLen(text.slice(0, m.index + m[0].length));
    bounds.push({ runeStart, priority: PRIO_BLANK_BLOCK });
  }

  if (bounds.length === 0) return [];

  bounds.sort((a, b) => a.runeStart - b.runeStart || b.priority - a.priority);
  const deduped: Boundary[] = [];
  let prev = -1;
  for (const b of bounds) {
    if (b.runeStart !== prev) {
      deduped.push(b);
      prev = b.runeStart;
    }
  }
  return deduped;
}

/** 丢弃严格落在保护区内部（start < pos < end）的边界；边缘保留。spans 按 start 升序。 */
export function dropBoundsInsideSpans(
  bounds: Boundary[],
  spans: Span[],
): Boundary[] {
  if (spans.length === 0) return bounds;
  const out: Boundary[] = [];
  for (const b of bounds) {
    let inside = false;
    for (const s of spans) {
      if (s.start >= b.runeStart) break; // 后续 span 起点在 b 之后，不可能包含 b
      if (b.runeStart < s.end) {
        inside = true;
        break;
      }
    }
    if (!inside) out.push(b);
  }
  return out;
}

function appendChunk(
  out: Chunk[],
  runes: string[],
  start: number,
  end: number,
  bumpSeq: () => number,
): void {
  if (end <= start) return;
  const raw = runes.slice(start, end).join("");
  if (raw.trim() === "") return; // 边界聚集偶尔产生的纯空白片跳过
  out.push({ content: raw, contextHeader: "", seq: bumpSeq(), start, end });
}

function appendOversizeBlock(
  out: Chunk[],
  runes: string[],
  start: number,
  end: number,
  cfg: SplitterConfig,
  seq: number,
): number {
  if (end <= start) return seq;
  const subText = runes.slice(start, end).join("");
  const subs = splitText(subText, cfg);
  let s = seq;
  for (const sub of subs) {
    out.push({
      content: sub.content,
      contextHeader: "",
      seq: s,
      start: start + sub.start,
      end: start + sub.end,
    });
    s += 1;
  }
  return s;
}

/**
 * 下一 chunk 的起始偏移：目标 curEnd-overlap，但优先吸附到窗口
 * [curEnd-2*overlap, curEnd) 内最近的边界，其次 target 前最近的换行——
 * 避免 chunk 从行中/词中开始。curEnd 本身是边界（flush 点）必被排除。
 */
export function applyOverlapAligned(
  runes: string[],
  curEnd: number,
  overlap: number,
  bounds: Boundary[],
): number {
  if (overlap <= 0) return curEnd;
  let target = curEnd - overlap;
  if (target < 0) target = 0;
  let windowStart = curEnd - 2 * overlap;
  if (windowStart < 0) windowStart = 0;

  let bestBound = -1;
  for (const b of bounds) {
    if (
      b.runeStart >= windowStart &&
      b.runeStart < curEnd &&
      b.runeStart > bestBound
    ) {
      bestBound = b.runeStart;
    }
  }
  if (bestBound >= 0) return bestBound;

  for (let i = target; i > windowStart && i < runes.length; i -= 1) {
    if (runes[i] === "\n") return i + 1;
  }
  return target;
}
