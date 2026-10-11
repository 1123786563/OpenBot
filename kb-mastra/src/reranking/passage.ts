/**
 * passage 清洗与构建：WeKnora reranking/passage.go 直译。
 * CleanPassage 剥 Markdown/结构噪音；ModelPassage = 标题 + 面包屑 + 清洗后正文。
 */
import { runeLen } from "../../infrastructure/chunker/splitter";

// Go 内联标志转 JS：(?s)→[\s\S]，(?m)→m。
const RE_CODE_BLOCK = /```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```/;
const RE_LATEX_BLOCK = /\$\$([\s\S]*?)\$\$/;
const RE_HTML_TAG = /<\/?[a-zA-Z][^>]*>/;
const RE_LINKED_IMAGE =
  /\[!\[([^\]]*)\]\(([^()\s]*(?:\([^)]*\)[^()\s]*)*)\)\]\([^()\s]*(?:\([^)]*\)[^()\s]*)*\)/g;
const RE_MARKDOWN_IMAGE = /!\[[^\]]*\]\([^()\s]*(?:\([^)]*\)[^()\s]*)*\)/g;
const RE_MARKDOWN_LINK = /\[([^\]]+)\]\([^()\s]*(?:\([^)]*\)[^()\s]*)*\)/g;
const RE_RAW_URL = /https?:\/\/[^\s)\]>]+/g;
const RE_TABLE_SEP = /^[ \t]*\|[ \t:|-]+\|[ \t]*$/m;
const RE_TABLE_ROW = /^[ \t]*\|(.+?)\|[ \t]*$/m;
const RE_HEADING_PREFIX = /^#{1,6}\s+/gm;
const RE_BLOCKQUOTE = /^>\s?/gm;
const RE_BOLD_ITALIC_3 = /\*{3}(.+?)\*{3}/g;
const RE_BOLD_ITALIC_2 = /\*{2}(.+?)\*{2}/g;
const RE_BOLD_ITALIC_1 = /\*(.+?)\*/g;
const RE_EXCESSIVE_NEWLINES = /\n{3,}/g;
const RE_LIST_MARKER = /^[\t ]*(?:[-*+]|\d+\.)\s+/gm;

/** 剥 Markdown/结构噪音，产出干净的语义 passage（步骤序号与 Go 版一一对应）。 */
export function cleanPassage(text: string): string {
  // 1. 代码块解包（纯代码候选仍可重排）
  text = text.replace(RE_CODE_BLOCK, "$1");
  // 2. LaTeX 块解包
  text = text.replace(RE_LATEX_BLOCK, "$1");
  // 3. HTML 标签移除
  text = text.replace(RE_HTML_TAG, "");
  // 3.5 嵌套 [![alt](img)](link) → ![alt](img)，让下一步整体移除
  text = text.replace(RE_LINKED_IMAGE, "![$1]($2)");
  // 4. Markdown 图片整体移除
  text = text.replace(RE_MARKDOWN_IMAGE, "");
  // 5. Markdown 链接保留显示文本
  text = text.replace(RE_MARKDOWN_LINK, "$1");
  // 6. 裸 URL 移除
  text = text.replace(RE_RAW_URL, "");
  // 7. 表格分隔行移除
  text = text.replace(RE_TABLE_SEP, "");
  // 7.5 表格数据行转纯文本（剥 | 分隔）
  text = text.replace(RE_TABLE_ROW, (_m, inner: string) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "")
      .join(", "),
  );
  // 8. 标题标记剥除（保留标题文本）
  text = text.replace(RE_HEADING_PREFIX, "");
  // 9. 引用标记剥除
  text = text.replace(RE_BLOCKQUOTE, "");
  // 10. 粗斜体解包（*** 先于 ** 先于 *）
  text = text.replace(RE_BOLD_ITALIC_3, "$1");
  text = text.replace(RE_BOLD_ITALIC_2, "$1");
  text = text.replace(RE_BOLD_ITALIC_1, "$1");
  // 11. 列表标记剥除
  text = text.replace(RE_LIST_MARKER, "");
  // 12. 过多换行折叠
  text = text.replace(RE_EXCESSIVE_NEWLINES, "\n\n");
  return text.trim();
}

/** P1 检索行的 passage 输入形状（SearchResult 的富化字段裁剪后）。 */
export type PassageSource = {
  content: string;
  /** 标题面包屑（chunk 级 context_header）。 */
  contextHeader?: string;
  /** 文档标题（knowledge title）。 */
  knowledgeTitle?: string;
};

/**
 * 喂给重排模型的 passage：清洗后正文；非空时前置面包屑与文档标题
 * （WeKnora ModelPassage：title \n\n header \n\n body）。
 */
export function modelPassage(source: PassageSource): string {
  let passage = cleanPassage(source.content);
  if (passage.trim() === "") return passage;
  const header = source.contextHeader?.trim() ?? "";
  if (header !== "") passage = `${header}\n\n${passage}`;
  const title = source.knowledgeTitle?.trim() ?? "";
  if (title !== "") passage = `${title}\n\n${passage}`;
  return passage;
}

/** 超限 passage 截断（fitPassages：tail 截断，优先丢最不重要的部分）。 */
export function fitPassages(passages: string[], limit: number): number {
  if (limit <= 0) return 0;
  let trimmed = 0;
  for (let i = 0; i < passages.length; i += 1) {
    if (runeLen(passages[i]) > limit) {
      passages[i] = Array.from(passages[i]).slice(0, limit).join("");
      trimmed += 1;
    }
  }
  return trimmed;
}
