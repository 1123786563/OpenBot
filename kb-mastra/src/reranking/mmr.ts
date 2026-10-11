/**
 * MMR（Maximal Marginal Relevance）选择：WeKnora reranking/mmr.go 直译。
 * 增量式：maxRedundancy 缓存每个剩余候选对已选集合的最大 Jaccard，每轮
 * 只需每候选一次比较。分词用 Intl.Segmenter("zh") 替代 gojieba
 * （设计 §7.4：仅影响 token-Jaccard 相似度，无功能等价性风险）。
 */

export const DEFAULT_MMR_LAMBDA = 0.7;

/** 含中文判定（CJK 统一表意文字）。 */
function containsChinese(text: string): boolean {
  for (const r of text) {
    const cp = r.codePointAt(0) ?? 0;
    if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  }
  return false;
}

let segmenter: Intl.Segmenter | null = null;

/** 中文分词（Intl.Segmenter，词级）；非中文回退空白切分。TokenizeSimple 对应物。 */
export function tokenizeSimple(text: string): Set<string> {
  const lower = text.trim().toLowerCase();
  if (lower === "") return new Set();
  const words: string[] = [];
  if (containsChinese(lower) && typeof Intl.Segmenter !== "undefined") {
    if (segmenter === null) segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    for (const seg of segmenter.segment(lower)) {
      words.push(seg.segment);
    }
  } else {
    words.push(...lower.split(/\s+/));
  }
  const set = new Set<string>();
  for (const w of words) {
    const trimmed = w.trim();
    // 过滤单 rune token 与纯标点/空白（Go isAllPunct 语义）
    if (trimmed.length <= 1) continue;
    if (isAllPunct(trimmed)) continue;
    // JS length 是 UTF-16 单位；用 code point 数对齐 rune 语义
    if (Array.from(trimmed).length <= 1) continue;
    set.add(trimmed);
  }
  return set;
}

function isAllPunct(s: string): boolean {
  for (const r of s) {
    if (!isPunctOrSpaceOrSymbol(r)) return false;
  }
  return true;
}

function isPunctOrSpaceOrSymbol(r: string): boolean {
  const cp = r.codePointAt(0) ?? 0;
  // ASCII 标点/符号/空白
  if (cp >= 0x21 && cp <= 0x2f) return true;
  if (cp >= 0x3a && cp <= 0x40) return true;
  if (cp >= 0x5b && cp <= 0x60) return true;
  if (cp >= 0x7b && cp <= 0x7e) return true;
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  // CJK 标点（。，！？；：、""等常用段）
  if (cp >= 0x3000 && cp <= 0x303f) return true;
  if (cp >= 0xff00 && cp <= 0xffef) return true;
  return false;
}

/** Jaccard 相似度（[0,1]；两空集为 0）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const k of small) {
    if (large.has(k)) inter += 1;
  }
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

export type MMRItem = {
  score: number;
  /** MMR 比较用的富化 passage 文本。 */
  passage: string;
};

/**
 * 按 MMR 选至多 k 个结果，返回被选下标（选择顺序）。并列取更早者。
 * mmr = lambda*score - (1-lambda)*maxRedundancy（对已选集合的最大 Jaccard）。
 */
export function selectMMR(items: MMRItem[], k: number, lambda: number): number[] {
  if (k <= 0 || items.length === 0) return [];

  const remaining = items.map((_, i) => i);
  const tokenSets = items.map((item) => tokenizeSimple(item.passage));
  const maxRedundancy = new Array<number>(items.length).fill(0);
  const selected: number[] = [];

  while (selected.length < k && remaining.length > 0) {
    let bestPos = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let pos = 0; pos < remaining.length; pos += 1) {
      const i = remaining[pos];
      const mmr = lambda * items[i].score - (1 - lambda) * maxRedundancy[i];
      if (mmr > bestScore) {
        bestScore = mmr;
        bestPos = pos;
      }
    }
    const chosen = remaining[bestPos];
    selected.push(chosen);
    remaining.splice(bestPos, 1);
    for (const i of remaining) {
      const sim = jaccard(tokenSets[i], tokenSets[chosen]);
      if (sim > maxRedundancy[i]) maxRedundancy[i] = sim;
    }
  }
  return selected;
}
