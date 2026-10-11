/**
 * mergeUnits + 语义 overlap：WeKnora splitter.go 的 mergeUnits/computeOverlap/
 * semanticOverlapWindow/findSemanticOverlapBoundary/trimUnitsPrefix 直译。
 * 职责：把 split units 合并成带 overlap 的 chunk，超绝对上限（7500）强切，
 * 活动表头前置到新 chunk（零宽 unit 不破坏位置不变量）。
 */
import {
  HeaderTracker,
  headerAlreadyPresent,
  headerColumnMismatch,
} from "./header-tracker";
import {
  buildUnitsWithProtection,
  type Chunk,
  protectedSpans,
  protectedSpansRune,
  runeLen,
  type SplitterConfig,
  type SplitUnit,
} from "./splitter";

const ABSOLUTE_MAX_SIZE = 7500;
/** 最长分隔符 \r\n\r\n 的 rune 长度：overlap 窗口额外前视量。 */
const SEMANTIC_OVERLAP_LOOKBEHIND = 4;

/** 固定窗口主入口（WeKnora splitter.SplitText）：保护区 → 分隔符切 → mergeUnits。 */
export function splitText(text: string, cfg: SplitterConfig): Chunk[] {
  if (text === "") return [];
  const chunkSize = cfg.chunkSize > 0 ? cfg.chunkSize : 512;
  const chunkOverlap = cfg.chunkOverlap < 0 ? 0 : cfg.chunkOverlap;
  const protected_ = protectedSpans(text);
  const units = buildUnitsWithProtection(
    text,
    protected_,
    cfg.separators,
    chunkSize,
  );
  return mergeUnits(units, chunkSize, chunkOverlap);
}

export function unitsText(units: SplitUnit[]): string {
  let out = "";
  for (const u of units) out += u.text;
  return out;
}

function buildChunk(units: SplitUnit[], seq: number): Chunk {
  let content = "";
  for (const u of units) content += u.text;
  return {
    content,
    contextHeader: "",
    seq,
    start: units[0].start,
    end: units[units.length - 1].end,
  };
}

export function mergeUnits(
  units: SplitUnit[],
  chunkSize: number,
  chunkOverlap: number,
): Chunk[] {
  if (units.length === 0) return [];

  const ht = new HeaderTracker();
  const chunks: Chunk[] = [];
  let current: SplitUnit[] = [];
  let curLen = 0;

  for (const u of units) {
    const uLen = runeLen(u.text);

    // 单 unit 超绝对上限：先 flush，再按行/空格回切强分。
    if (uLen > ABSOLUTE_MAX_SIZE) {
      if (current.length > 0) {
        chunks.push(buildChunk(current, chunks.length));
        current = [];
        curLen = 0;
      }
      ht.update(u.text);
      const runes = Array.from(u.text);
      let offset = 0;
      while (offset < runes.length) {
        let chunkEnd = offset + ABSOLUTE_MAX_SIZE;
        if (chunkEnd > runes.length) {
          chunkEnd = runes.length;
        } else {
          for (let i = chunkEnd - 1; i > offset && i > chunkEnd - 200; i -= 1) {
            if (runes[i] === "\n" || runes[i] === " ") {
              chunkEnd = i + 1;
              break;
            }
          }
        }
        chunks.push({
          content: runes.slice(offset, chunkEnd).join(""),
          contextHeader: "",
          seq: chunks.length,
          start: u.start + offset,
          end: u.start + chunkEnd,
        });
        offset = chunkEnd;
      }
      continue;
    }

    ht.update(u.text);
    // 表格边界 flush：新表不并进还带着旧表头的 chunk。
    if (ht.headerEndedThisUnit && current.length > 0) {
      chunks.push(buildChunk(current, chunks.length));
      current = [];
      curLen = 0;
    }
    let headers = ht.getHeaders();
    let headersLen = runeLen(headers);
    if (headersLen > chunkSize) {
      headers = "";
      headersLen = 0;
    }

    // 加入本 unit（含潜在下一 chunk 的表头预留）会超限 → flush 并保留 overlap。
    if (curLen + uLen + headersLen > chunkSize && current.length > 0) {
      chunks.push(buildChunk(current, chunks.length));
      const overlap = computeOverlap(current, chunkOverlap, chunkSize, uLen);
      current = overlap.units;
      curLen = overlap.len;

      // 表头 + 下一 unit 仍放不下时继续收缩 overlap，再前置表头。
      if (headers !== "" && headersLen + uLen <= chunkSize) {
        while (current.length > 0 && curLen + uLen + headersLen > chunkSize) {
          curLen -= runeLen(current[0].text);
          current = current.slice(1);
        }
        const overlapText = unitsText(current);
        if (
          !headerAlreadyPresent(headers, overlapText, u.text) &&
          !headerColumnMismatch(headers, u.text)
        ) {
          const startPos = current.length > 0 ? current[0].start : u.start;
          const hUnit: SplitUnit = {
            text: headers,
            start: startPos,
            end: startPos,
          };
          current = [hUnit, ...current];
          curLen += headersLen;
        }
      }
    }

    // 绝对上限兜底
    if (curLen + uLen > ABSOLUTE_MAX_SIZE) {
      if (current.length > 0) {
        chunks.push(buildChunk(current, chunks.length));
        current = [];
        curLen = 0;
      }
    }

    current.push(u);
    curLen += uLen;
  }

  if (current.length > 0) {
    chunks.push(buildChunk(current, chunks.length));
  }
  return chunks;
}

/**
 * 语义 overlap：配置的 overlap 是硬上限而非裸字符切片。优先级：段落断 > 换行 >
 * 句末（。？！ / ". " 等）；同优先级取窗口内最早（保留尽量大的 overlap）。
 * 窗口内无合法语义边界则不保留 overlap。
 */
export function computeOverlap(
  current: SplitUnit[],
  chunkOverlap: number,
  chunkSize: number,
  nextLen: number,
): { units: SplitUnit[]; len: number } {
  if (chunkOverlap <= 0) return { units: [], len: 0 };

  let maxOverlap = chunkOverlap;
  const remaining = chunkSize - nextLen;
  if (remaining < maxOverlap) maxOverlap = remaining;
  if (maxOverlap <= 0) return { units: [], len: 0 };

  const window = semanticOverlapWindow(
    current,
    maxOverlap + SEMANTIC_OVERLAP_LOOKBEHIND,
  );
  if (window.length === 0) return { units: [], len: 0 };

  const windowText = unitsText(window);
  let originalWindowStart = runeLen(windowText) - maxOverlap;
  if (originalWindowStart < 0) originalWindowStart = 0;
  const boundaryEnd = findSemanticOverlapBoundaryEndingAtOrAfter(
    windowText,
    originalWindowStart,
  );
  if (boundaryEnd === null) return { units: [], len: 0 };

  const overlap = trimUnitsPrefix(window, boundaryEnd);
  let overlapLen = 0;
  for (const u of overlap) overlapLen += runeLen(u.text);
  if (
    overlapLen <= 0 ||
    overlapLen > maxOverlap ||
    unitsText(overlap).trim() === ""
  ) {
    return { units: [], len: 0 };
  }
  return { units: overlap, len: overlapLen };
}

/**
 * 从 current 尾部取至多 maxLen 个源字符串支持的 rune。可切入首个保留 unit
 * 内部（大段落中的语义边界仍可发现）；零宽合成 unit（表头）是硬屏障——
 * 跨过会破坏 Start/End 与 Content 的源不变量。
 */
export function semanticOverlapWindow(
  current: SplitUnit[],
  maxLen: number,
): SplitUnit[] {
  if (maxLen <= 0 || current.length === 0) return [];

  let remaining = maxLen;
  const reversed: SplitUnit[] = [];
  for (let i = current.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const u = current[i];
    const uLen = runeLen(u.text);
    if (uLen === 0) continue;
    // 表头标记是生成文本，不占原文区间：不可包含也不可跨越。
    if (u.start === u.end || u.end - u.start !== uLen) break;

    if (uLen <= remaining) {
      reversed.push(u);
      remaining -= uLen;
      continue;
    }

    const runes = Array.from(u.text);
    const start = uLen - remaining;
    reversed.push({
      text: runes.slice(start).join(""),
      start: u.start + start,
      end: u.end,
    });
    remaining = 0;
  }

  if (reversed.length === 0) return [];
  return reversed.reverse();
}

type SemanticBoundary = { start: number; end: number; priority: number };

export function findSemanticOverlapBoundary(text: string): number | null {
  return findSemanticOverlapBoundaryEndingAtOrAfter(text, 0);
}

/**
 * 返回选中分隔符之后紧跟的 rune 偏移（end-exclusive）。保护区
 * （Markdown/代码/公式）内的候选忽略；其后只剩空白的候选无效。
 * 只对 end ≥ minEnd 的候选应用优先级与最早位置规则。
 */
export function findSemanticOverlapBoundaryEndingAtOrAfter(
  text: string,
  minEnd: number,
): number | null {
  const runes = Array.from(text);
  if (runes.length === 0) return null;
  if (minEnd < 0) minEnd = 0;
  if (minEnd > runes.length) return null;

  const protected_ = protectedSpansRune(text);
  const insideProtected = (pos: number): boolean => {
    for (const p of protected_) {
      if (pos < p.start) return false;
      if (pos >= p.start && pos < p.end) return true;
    }
    return false;
  };
  const hasMeaningfulTail = (end: number): boolean =>
    end >= 0 && end < runes.length && runes.slice(end).join("").trim() !== "";

  let best: SemanticBoundary | null = null;
  const consider = (start: number, end: number, priority: number) => {
    if (
      start < 0 ||
      end <= start ||
      end < minEnd ||
      end > runes.length ||
      insideProtected(start) ||
      !hasMeaningfulTail(end)
    ) {
      return;
    }
    if (
      best === null ||
      priority < best.priority ||
      (priority === best.priority && start < best.start)
    ) {
      best = { start, end, priority };
    }
  };

  // 段落断 rune 标记：避免其组成换行再作为低优先级候选重复出现。
  const paragraphRune = new Array<boolean>(runes.length).fill(false);
  for (let i = 0; i < runes.length; i += 1) {
    if (
      i + 3 < runes.length &&
      runes[i] === "\r" &&
      runes[i + 1] === "\n" &&
      runes[i + 2] === "\r" &&
      runes[i + 3] === "\n"
    ) {
      consider(i, i + 4, 1);
      for (let j = i; j < i + 4; j += 1) paragraphRune[j] = true;
      i += 3;
    } else if (
      i + 1 < runes.length &&
      runes[i] === "\n" &&
      runes[i + 1] === "\n"
    ) {
      consider(i, i + 2, 1);
      paragraphRune[i] = true;
      paragraphRune[i + 1] = true;
      i += 1;
    }
  }

  for (let i = 0; i < runes.length; i += 1) {
    if (paragraphRune[i]) continue;
    if (
      runes[i] === "\r" &&
      i + 1 < runes.length &&
      runes[i + 1] === "\n" &&
      !paragraphRune[i + 1]
    ) {
      consider(i, i + 2, 2);
      i += 1;
      continue;
    }
    if (runes[i] === "\n") consider(i, i + 1, 2);
  }

  for (let i = 0; i < runes.length; i += 1) {
    switch (runes[i]) {
      case "。":
      case "？":
      case "！":
        consider(i, i + 1, 3);
        break;
      case ".":
      case "?":
      case "!":
        if (i + 1 < runes.length && runes[i + 1] === " ") consider(i, i + 2, 3);
        break;
    }
  }

  // 闭包内赋值不被 TS 窄化追踪，用中间变量断开 never 推断。
  const found = best as SemanticBoundary | null;
  return found !== null ? found.end : null;
}

/** 去掉 unitsText 前 prefixLen 个源 rune，保留剩余 unit 的原位置。 */
export function trimUnitsPrefix(
  units: SplitUnit[],
  prefixLen: number,
): SplitUnit[] {
  if (prefixLen <= 0) return units.map((u) => ({ ...u }));

  let remaining = prefixLen;
  const out: SplitUnit[] = [];
  for (const u of units) {
    const uLen = runeLen(u.text);
    if (remaining >= uLen) {
      remaining -= uLen;
      continue;
    }
    if (remaining > 0) {
      const runes = Array.from(u.text);
      out.push({
        text: runes.slice(remaining).join(""),
        start: u.start + remaining,
        end: u.end,
      });
      remaining = 0;
    } else {
      out.push({ ...u });
    }
  }
  return out;
}

// protectedSpans 在本模块被 protectedSpansRune 间接使用；显式引用避免被误删。
export const _protectedSpansUsed = protectedSpans;
