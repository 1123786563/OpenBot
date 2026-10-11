/**
 * 语言感知的 token 近似计数：WeKnora chunker/tokens.go 直译。
 * 不引入 tokenizer 依赖，用每语言 chars/token 比率保守估算（略高估保安全）。
 */

const charsPerToken: Record<string, number> = {
  en: 4.0,
  de: 4.5,
  zh: 1.7,
  mixed: 3.0,
};

/** 保守 token 估算；空/未知语言回退 mixed。 */
export function approxTokenCount(s: string, lang: string): number {
  if (s === "") return 0;
  let n = 0;
  for (const _ of s) n += 1;
  return approxTokenCountFromRuneLen(n, lang);
}

/** 已有 rune 长度时的免分配变体（热路径）。 */
export function approxTokenCountFromRuneLen(
  runeLen: number,
  lang: string,
): number {
  if (runeLen <= 0) return 0;
  const ratio = charsPerToken[lang] ?? charsPerToken.mixed;
  const approx = runeLen / ratio;
  if (approx < 1) return 1;
  return Math.floor(approx + 0.5);
}

const GERMAN_WORDS = [
  " der ",
  " die ",
  " das ",
  " und ",
  " ist ",
  " nicht ",
  " mit ",
  " auf ",
];

/** 粗粒度语言检测：CJK vs Latin 字符比例 + 德语变音/停用词倾向。 */
export function detectLanguage(s: string): string {
  if (s === "") return "mixed";
  let cjk = 0;
  let latin = 0;
  let umlaut = 0;
  for (const r of s) {
    const cp = r.codePointAt(0);
    if (cp === undefined) continue;
    if (isHan(cp) || isHangul(cp) || isHiragana(cp) || isKatakana(cp)) {
      cjk += 1;
    } else if (isGermanUmlaut(r)) {
      umlaut += 1;
      latin += 1;
    } else if ((r >= "a" && r <= "z") || (r >= "A" && r <= "Z")) {
      latin += 1;
    }
  }
  const total = cjk + latin;
  if (total === 0) return "mixed";
  const cjkRatio = cjk / total;
  const latinRatio = latin / total;
  if (cjkRatio >= 0.15 && latinRatio >= 0.15) return "mixed";
  if (cjkRatio > 0.3) return "zh";
  if (umlaut > 0 || hasGermanWords(s)) return "de";
  return "en";
}

function isHan(cp: number): boolean {
  return cp >= 0x4e00 && cp <= 0x9fff;
}
function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff);
}
function isHiragana(cp: number): boolean {
  return cp >= 0x3040 && cp <= 0x309f;
}
function isKatakana(cp: number): boolean {
  return cp >= 0x30a0 && cp <= 0x30ff;
}

function isGermanUmlaut(r: string): boolean {
  return "äöüÄÖÜß".includes(r);
}

function hasGermanWords(s: string): boolean {
  const sample = s.length > 512 ? s.slice(0, 512) : s;
  const lower = sample.toLowerCase();
  return GERMAN_WORDS.some((w) => lower.includes(w));
}

/** token 上限 → 近似字符预算（0.9 安全系数，宁欠勿超）。 */
export function charsForTokenLimit(tokens: number, lang: string): number {
  if (tokens <= 0) return 0;
  const ratio = charsPerToken[lang] ?? charsPerToken.mixed;
  return Math.floor(tokens * ratio * 0.9);
}
