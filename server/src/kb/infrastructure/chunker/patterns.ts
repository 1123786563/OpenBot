/**
 * 多语言正则模式：WeKnora chunker/patterns.go 直译。
 * heading 与 heuristic 两个 splitter 共用的结构信号源（章节标记/编号/分隔线等），
 * priority 由 heuristic splitter 用于给候选边界排序。
 */

export const PRIO_FORM_FEED = 100;
export const PRIO_NUMBERED_HEAD = 90;
export const PRIO_CHAPTER_MARKER = 85;
export const PRIO_ALL_CAPS_HEADING = 70;
export const PRIO_VISUAL_SEP = 60;
export const PRIO_PAGE_FOOTER = 50;
export const PRIO_BLANK_BLOCK = 40;

export const LANG_ENGLISH = "en";
export const LANG_GERMAN = "de";
export const LANG_CHINESE = "zh";
export const LANG_MIXED = "mixed";

/** ATX Markdown 标题（行首 # 1-6 个）。捕获组：hashes、标题文本。 */
export const markdownHeadingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/m;

/** PDF 转换器的换页控制字符。 */
export const formFeedPattern = /\f/;

/** 数字/罗马编号行（"1. Intro"、"2.3 Methods"、"IV. Results"、"2.2.1 用户与权限"）。 */
export const numberedSectionPattern =
  /^[ \t]*(?:\d+(?:\.\d+){1,3}\.?|(?:\d+|[IVX]{1,5})\.)[ \t]+\S.{0,200}$/m;

/** 全大写短行（无 Markdown 标题的段落题名，≥4 字母、≤~10 词，容忍尾冒号）。 */
export const allCapsHeadingPattern = /^[ \t]*([A-ZÄÖÜ][A-ZÄÖÜ -]{3,80}):?\s*$/m;

/** 水平分隔线（--- / === / *** / ___）。 */
export const visualSeparatorPattern =
  /^[ \t]*(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*$/m;

/** 三个及以上连续换行（硬章节断）。 */
export const excessiveBlanksPattern = /\n{3,}/;

/** "Seite X von Y" / "Page X of Y" / 页码 行。 */
export const pageFooterPattern =
  /^[ \t]*(?:Seite|Page|页码?)\s+\d+(?:\s*(?:von|of|\/)\s*\d+)?[ \t]*$/im;

/** 德/英/中章节标记。 */
export const germanChapterPattern =
  /^[ \t]*(?:Kapitel|Abschnitt|Teil)\s+(?:[0-9]+|[IVX]{1,5})[.: ].{0,200}$/m;
export const englishChapterPattern =
  /^[ \t]*(?:Chapter|Section|Part)\s+(?:[0-9]+|[IVX]{1,5})[.: ].{0,200}$/m;
export const chineseChapterPattern =
  /^[ \t]*第[ \t]*[一二三四五六七八九十百千零〇0-9]+[ \t]*(?:章|节|節|部分|篇)[ \t]?.{0,200}$/m;

/** 语言对应的句级分隔符（细粒度二次切分用）。 */
export function sentenceSeparators(lang: string): string[] {
  switch (lang) {
    case LANG_CHINESE:
      return ["。", "！", "？", "；", "\n"];
    case LANG_GERMAN:
    case LANG_ENGLISH:
      return [". ", "! ", "? ", "; ", "\n"];
    default:
      return ["。", "！", "？", "；", ". ", "! ", "? ", "; ", "\n"];
  }
}

/** 语言提示对应的章节正则；空/未知列表返回全部（自动检测文档仍可命中）。 */
export function chapterPatternsForLangs(langs: string[]): RegExp[] {
  const all = [
    germanChapterPattern,
    englishChapterPattern,
    chineseChapterPattern,
  ];
  if (langs.length === 0) return all;
  const out: RegExp[] = [];
  for (const l of langs) {
    switch (l) {
      case LANG_GERMAN:
        out.push(germanChapterPattern);
        break;
      case LANG_ENGLISH:
        out.push(englishChapterPattern);
        break;
      case LANG_CHINESE:
        out.push(chineseChapterPattern);
        break;
    }
  }
  return out.length > 0 ? out : all;
}
