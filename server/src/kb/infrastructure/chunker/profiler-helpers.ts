/**
 * profiler 复用的模式集合（patterns.ts 的再导出 + 换页符字面量）。
 * 单独成文件避免 profiler 与 heuristic splitter 之间的环状依赖。
 */
export {
  allCapsHeadingPattern,
  chineseChapterPattern,
  englishChapterPattern,
  germanChapterPattern,
  numberedSectionPattern,
  pageFooterPattern,
  visualSeparatorPattern,
} from "./patterns";

/** 换页控制字符的字面量（profiler 用计数而非正则）。 */
export const formFeedPatternLike = "\f";
