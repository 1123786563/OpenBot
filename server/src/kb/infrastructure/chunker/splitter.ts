/**
 * chunker 基础类型与固定窗口切分器：WeKnora `internal/infrastructure/chunker/splitter.go`
 * 的一对一 TypeScript 翻译。
 *
 * 核心不变量：Chunk.Content 恰是原文 [Start, End) 的 rune（Unicode code point）切片，
 * 即 End - Start === runeCount(Content)。文档重建、UI 高亮都依赖它。
 * ContextHeader 是独立跟踪的上下文（Markdown 标题面包屑），嵌入/检索时前置，
 * 不计入 Content——两者分离才能同时保住位置不变量与语义上下文。
 */

/** 与 WeKnora splitter.go 一致的默认值（单一事实来源，前端编辑弹窗同款数字）。 */
export const DEFAULT_CHUNK_SIZE = 512;
export const DEFAULT_CHUNK_OVERLAP = 80;
export const DEFAULT_SEPARATORS = ["\n\n", "\n", "。"];

/** SplitterConfig.Strategy 的合法值（strategy.ts 解析）。 */
export type StrategyValue =
  | "auto"
  | "heading"
  | "heuristic"
  | "recursive"
  | "legacy";

export type SplitterConfig = {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  /** 空 = legacy（向后兼容存量配置）。 */
  strategy: StrategyValue | "";
  /** 近似 token 上限，0 = 用 chunkSize 字符数。 */
  tokenLimit: number;
  /** 多语言启发提示，空 = 自动检测。 */
  languages: string[];
};

export function defaultConfig(): SplitterConfig {
  return {
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    separators: [...DEFAULT_SEPARATORS],
    strategy: "",
    tokenLimit: 0,
    languages: [],
  };
}

/** 一段切分后的文本及其原文位置（rune 偏移，end-exclusive）。 */
export type Chunk = {
  content: string;
  contextHeader: string;
  seq: number;
  start: number;
  end: number;
};

/** 喂给嵌入模型的内容：ContextHeader 前置（若有）+ trim 后的正文。 */
export function embeddingContent(chunk: Chunk): string {
  const body = chunk.content.trim();
  if (chunk.contextHeader === "") return body;
  return `${chunk.contextHeader}\n\n${body}`;
}

/** chunk 内的图片引用。start/end 是 chunk content 内的偏移。 */
export type ImageRef = {
  originalRef: string;
  altText: string;
  start: number;
  end: number;
};

/** rune 计数：TS 的 string 迭代器按 code point 展开，等价 Go 的 utf8.RuneCountInString。 */
export function runeLen(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** rune 数组切片回字符串（splitter 多处按 rune 索引切）。 */
export function runesOf(s: string): string[] {
  return Array.from(s);
}

export function runeSlice(s: string, start: number, end: number): string {
  return Array.from(s).slice(start, end).join("");
}

/** 原文位置区间（rune 偏移，end-exclusive）。 */
export type Span = { start: number; end: number };

/**
 * 保护 span 的正则（不可被切断的内容）：LaTeX 块、Markdown 图片/链接（限长防空括号吞段）、
 * 表头+分隔行、表格行、围栏代码块、行内代码。逐条对照 splitter.go protectedPatterns。
 */
// 注：Go 的 (?s)（dotall）在 JS 中用 [\s\S] 表达；(?m) 用 m 标志。
const protectedPatterns: RegExp[] = [
  /\$\$[\s\S]*?\$\$/, // LaTeX block math
  // Markdown images / links: single line, bounded so a stray OCR '[' cannot swallow a paragraph.
  /!\[[^\]\n]{0,200}\]\([^)\n]{1,500}\)/,
  /\[[^\]\n]{1,200}\]\([^)\n]{1,500}\)/,
  /[ ]*(?:\|[^|\n]*)+\|[\r\n]+\s*(?:\|\s*:?-{3,}:?\s*)+\|[\r\n]+/m, // Table header+separator
  /[ ]*(?:\|[^|\n]*)+\|[\r\n]+/m, // Table rows
  /```(?:\w+)?[\r\n][\s\S]*?```/, // Fenced code blocks
  /`[^`\r\n]+`/, // Markdown inline code
];

/**
 * 把字节偏移的匹配区间转 rune 偏移（单次前向扫描）。
 * Bun/Node 的 JS 正则按 UTF-16 code unit 给索引；对含非 BMP 字符的文本与
 * Go 的 byte→rune 转换不同源，但语义等价：产出「code point 偏移」区间。
 * byteSpans 必须按 start 升序（protectedSpans 保证）。
 */
export function spansToRuneOffsets(text: string, unitSpans: Span[]): Span[] {
  if (unitSpans.length === 0) return [];
  const out: Span[] = [];
  let runeIdx = 0;
  let unitIdx = 0;
  const chars = Array.from(text);
  for (const s of unitSpans) {
    while (unitIdx < s.start && unitIdx < chars.length) {
      unitIdx += chars[unitIdx].length; // BMP=1，代理对=2
      runeIdx += 1;
    }
    const startRune = runeIdx;
    while (unitIdx < s.end && unitIdx < chars.length) {
      unitIdx += chars[unitIdx].length;
      runeIdx += 1;
    }
    out.push({ start: startRune, end: runeIdx });
  }
  return out;
}

/**
 * 找出全部互不重叠的保护区间，**直接产出 rune（code point）偏移**。
 * JS 正则按 UTF-16 code unit 给索引，本函数在收集时同步换算成 code point
 * 偏移（BMP 字符 1:1，非 BMP 代理对按 1 计），使 buildUnitsWithProtection
 * 与下游全部逻辑工作在统一的 rune 坐标系——Go 版 byte↔rune 双坐标在 TS 中
 * 收敛为单坐标，语义等价（End-Start == runeCount(Content) 不变量不变）。
 * 排序：start 升序、同 start 长者优先、去重叠。
 */
export function protectedSpans(text: string): Span[] {
  const all: Span[] = [];
  for (const pat of protectedPatterns) {
    const flags = pat.flags.includes("g") ? pat.flags : `${pat.flags}g`;
    for (const m of text.matchAll(new RegExp(pat.source, flags))) {
      if (m.index === undefined) continue;
      const whole = m[0];
      if (whole.length === 0) continue;
      // code-unit 起点 → rune 起点：数前缀里的代理对
      const prefixRunes = codePointCount(text.slice(0, m.index));
      const matchRunes = codePointCount(whole);
      all.push({ start: prefixRunes, end: prefixRunes + matchRunes });
    }
  }
  if (all.length === 0) return [];

  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  const result: Span[] = [];
  let lastEnd = 0;
  for (const m of all) {
    if (m.start >= lastEnd) {
      result.push({ start: m.start, end: m.end });
      lastEnd = m.end;
    }
  }
  return result;
}

function codePointCount(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** 兼容导出：protectedSpans 已直接产出 rune 偏移，恒等映射。 */
export function protectedSpansRune(text: string): Span[] {
  return protectedSpans(text);
}

/** 切分单元：一段文本 + 原文 rune 位置。 */
export type SplitUnit = { text: string; start: number; end: number };

/**
 * 按分隔符优先级递归切分（Python 参考实现的递归语义）：`\n\n` 切出的片仍超限时，
 * 对该片继续用后续分隔符——而不是对全文重来。chunkSize=0 关闭递归守卫。
 * 注意：切出的 pieces **包含分隔符自身**（与 Go 版一致，分隔符作为独立 piece 返回）。
 */
export function splitBySeparators(
  text: string,
  separators: string[],
  chunkSize: number,
): string[] {
  if (text === "" || separators.length === 0) return [text];
  if (chunkSize > 0 && runeLen(text) <= chunkSize) return [text];

  for (let i = 0; i < separators.length; i += 1) {
    const sep = separators[i];
    if (sep === "") continue;
    // 非捕获分割：JS split 会把捕获组混进结果，故模式不加括号，分隔符由
    // matches 单独持有再按 Go 的 interleave 顺序（splits[j], matches[j]）拼回。
    const re = new RegExp(escapeRegExp(sep), "g");
    const splits = text.split(re);
    const matches = text.match(re) ?? [];
    if (matches.length === 0) continue;

    const pieces: string[] = [];
    for (let j = 0; j < splits.length; j += 1) {
      const s = splits[j];
      if (s !== "") pieces.push(s);
      if (j < matches.length && matches[j] !== "") pieces.push(matches[j]);
    }
    if (pieces.length <= 1) continue;

    const remaining = separators.slice(i + 1);
    const out: string[] = [];
    for (const p of pieces) {
      if (chunkSize > 0 && runeLen(p) > chunkSize && remaining.length > 0) {
        out.push(...splitBySeparators(p, remaining, chunkSize));
      } else {
        out.push(p);
      }
    }
    return out;
  }
  return [text];
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 固定窗口主入口：保护 span → 非保护区按分隔符切 → 带 overlap 合并。
 * 实现在 merge.ts（依赖 header-tracker 与语义 overlap，与本文件类型互补）；
 * 这里 re-export 保持 WeKnora 的 splitter.SplitText 调用形状。 */
export { splitText } from "./merge";

/** 保护 span 超过 7500 rune 时强制按行/空格回切，防 chunk 超嵌入 API 上限。 */
const MAX_PROTECTED_SIZE = 7500;

export function buildUnitsWithProtection(
  text: string,
  protected_: Span[],
  separators: string[],
  chunkSize: number,
): SplitUnit[] {
  const units: SplitUnit[] = [];
  // 坐标系统一为 code point：保护区间的 rune 偏移需要按 rune 切原文。
  const runes = Array.from(text);
  let bytePos = 0; // rune 游标（命名保留 Go 对照）
  let runePos = 0;

  for (const p of protected_) {
    if (p.start > bytePos) {
      const pre = runes.slice(bytePos, p.start).join("");
      const parts = splitBySeparators(pre, separators, chunkSize);
      let runeOffset = runePos;
      for (const part of parts) {
        const partRuneLen = runeLen(part);
        units.push({
          text: part,
          start: runeOffset,
          end: runeOffset + partRuneLen,
        });
        runeOffset += partRuneLen;
      }
      runePos += runeLen(pre);
    }

    const protText = runes.slice(p.start, p.end).join("");
    const protRuneLen = runeLen(protText);

    if (protRuneLen > MAX_PROTECTED_SIZE) {
      const protRunes = Array.from(protText);
      let offset = 0;
      while (offset < protRunes.length) {
        let chunkEnd = offset + MAX_PROTECTED_SIZE;
        if (chunkEnd > protRunes.length) {
          chunkEnd = protRunes.length;
        } else {
          for (let i = chunkEnd - 1; i > offset && i > chunkEnd - 200; i -= 1) {
            if (protRunes[i] === "\n" || protRunes[i] === " ") {
              chunkEnd = i + 1;
              break;
            }
          }
        }
        const chunkText = protRunes.slice(offset, chunkEnd).join("");
        units.push({
          text: chunkText,
          start: runePos + offset,
          end: runePos + offset + (chunkEnd - offset),
        });
        offset = chunkEnd;
      }
    } else {
      units.push({
        text: protText,
        start: runePos,
        end: runePos + protRuneLen,
      });
    }
    runePos += protRuneLen;
    bytePos = p.end;
  }

  if (bytePos < runes.length) {
    const remaining = runes.slice(bytePos).join("");
    const parts = splitBySeparators(remaining, separators, chunkSize);
    let runeOffset = runePos;
    for (const part of parts) {
      const partRuneLen = runeLen(part);
      units.push({
        text: part,
        start: runeOffset,
        end: runeOffset + partRuneLen,
      });
      runeOffset += partRuneLen;
    }
  }

  return units;
}
