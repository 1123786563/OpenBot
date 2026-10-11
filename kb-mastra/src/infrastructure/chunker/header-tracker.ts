/**
 * 表头上下文跟踪：WeKnora chunker/header_tracker.go 的直译。
 *
 * 大 Markdown 表格跨多个 chunk 时，后续 chunk 丢失表头上下文。headerTracker
 * 检测表头并把「表头+分隔行」作为活动 header，mergeUnits 在 flush 后向新
 * chunk 前置（零宽 unit，不占原文位置，不破坏 End-Start==len(Content)）。
 */
import { runeLen } from "./splitter";

const markdownTableHookPriority = 15;

type HeaderHook = {
  startPattern: RegExp;
  endPattern: RegExp;
  priority: number;
};

const defaultHeaderHooks: HeaderHook[] = [
  {
    startPattern:
      /^\s*(?:\|[^|\n]*)+[\r\n]+\s*(?:\|\s*:?-{3,}:?\s*)+\|?[\r\n]+$/i,
    endPattern: /^\s*$|^\s*[^|\s].*$/i,
    priority: 15,
  },
];

const tableRowPattern = /^\s*(?:\|[^|\n]*)+\|\s*$/m;

export class HeaderTracker {
  private hooks = defaultHeaderHooks;
  private activeHeaders = new Map<number, string>();
  private endedHeaders = new Set<number>();
  private pendingExtend = new Set<number>();
  private pendingTableBreak = false;
  headerEndedThisUnit = false;

  /** 检查一个 split unit 的文本，更新活动表头状态。 */
  update(split: string): void {
    this.headerEndedThisUnit = false;

    if (this.pendingTableBreak) {
      this.pendingTableBreak = false;
      if (this.activeHeaders.has(markdownTableHookPriority)) {
        if (firstTableRowColumnCount(split) > 0) {
          this.clearTableHeader();
          this.headerEndedThisUnit = true;
        } else {
          this.clearTableHeader();
        }
      }
    }

    // 1. 活动表头遇到结束标记（空行/非表格行）
    for (const hook of this.hooks) {
      if (this.activeHeaders.has(hook.priority)) {
        if (hook.endPattern.test(split)) {
          this.endedHeaders.add(hook.priority);
          this.activeHeaders.delete(hook.priority);
          this.pendingExtend.delete(hook.priority);
        }
      }
    }

    // 1b. 段落分隔吃掉表间空行：标记 pendingTableBreak 下一 unit 再判；列数变化即终止表头。
    if (this.activeHeaders.has(markdownTableHookPriority)) {
      if (!this.pendingExtend.has(markdownTableHookPriority)) {
        if (splitEndsWithParagraphBreak(split)) {
          this.pendingTableBreak = true;
        } else {
          this.endTableHeaderOnColumnMismatch(split);
        }
      }
    }

    // 2. 空列名表头（"||"）用首个数据行补列名
    for (const p of [...this.pendingExtend]) {
      const active = this.activeHeaders.get(p);
      if (active !== undefined && tableRowPattern.test(split)) {
        const sep = extractSeparatorLine(active);
        this.activeHeaders.set(p, split + sep);
      }
      this.pendingExtend.delete(p);
    }

    // 3. 新表头开始标记（非活动、非已结束的 hook）
    for (const hook of this.hooks) {
      if (this.activeHeaders.has(hook.priority)) continue;
      if (this.endedHeaders.has(hook.priority)) continue;
      const m = hook.startPattern.exec(split);
      if (m !== null && m[0] !== "") {
        this.activeHeaders.set(hook.priority, m[0]);
        if (isEmptyTableHeaderRow(m[0])) {
          this.pendingExtend.add(hook.priority);
        }
      }
    }

    // 4. 全部结束后清空 ended 集，让后续表格可再被跟踪
    if (this.activeHeaders.size === 0) {
      this.endedHeaders.clear();
    }
  }

  /** 全部活动表头拼接（priority 降序）。 */
  getHeaders(): string {
    if (this.activeHeaders.size === 0) return "";
    const entries = [...this.activeHeaders.entries()].sort(
      (a, b) => b[0] - a[0],
    );
    return entries.map(([, text]) => text).join("\n");
  }

  private clearTableHeader(): void {
    this.endedHeaders.add(markdownTableHookPriority);
    this.activeHeaders.delete(markdownTableHookPriority);
    this.pendingExtend.delete(markdownTableHookPriority);
  }

  private endTableHeaderOnColumnMismatch(split: string): void {
    const header = this.activeHeaders.get(markdownTableHookPriority);
    if (header === undefined) return;
    const rowCols = firstTableRowColumnCount(split);
    const headerCols = headerTableColumnCount(header);
    if (rowCols > 0 && headerCols > 0 && rowCols !== headerCols) {
      this.clearTableHeader();
      this.headerEndedThisUnit = true;
    }
  }
}

export function splitEndsWithParagraphBreak(split: string): boolean {
  const trimmed = split.replace(/[ \t\r]+$/, "");
  return trimmed.endsWith("\n\n") || trimmed.endsWith("\r\n\r\n");
}

/** 表头行（分隔行上一行）只含竖线与空白 → 空列名（MarkItDown 常见形态）。 */
export function isEmptyTableHeaderRow(header: string): boolean {
  const idx = header.indexOf("\n");
  if (idx < 0) return false;
  const row = header.slice(0, idx).trim();
  for (const r of row) {
    if (r !== "|" && r !== " " && r !== "\t") return false;
  }
  return true;
}

export function extractSeparatorLine(header: string): string {
  for (const line of header.split("\n")) {
    if (line.includes("---")) return `${line}\n`;
  }
  return "";
}

/** 按 cell 分隔符切表格行；`\|` 转义视为 cell 内文本（GFM 语义）。 */
export function splitTableCells(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let backslashes = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "\\") {
      backslashes += 1;
      continue;
    }
    if (c === "|" && backslashes % 2 === 0) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
    backslashes = 0;
  }
  parts.push(line.slice(start));
  return parts;
}

export function tableRowColumnCount(line: string): number {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return 0;
  let parts = splitTableCells(trimmed);
  if (parts.length > 0 && parts[0].trim() === "") parts = parts.slice(1);
  if (parts.length > 0 && parts[parts.length - 1].trim() === "")
    parts = parts.slice(0, -1);
  return parts.length;
}

export function firstTableRowColumnCount(text: string): number {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && tableRowPattern.test(line)) {
      return tableRowColumnCount(trimmed);
    }
  }
  return 0;
}

export function headerTableColumnCount(header: string): number {
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || line.includes("---")) continue;
    const n = tableRowColumnCount(trimmed);
    if (n > 0) return n;
  }
  return 0;
}

/** 下一 unit 是否开了列数不同的新表（mergeUnits 据此决定不前置旧表头）。 */
export function headerColumnMismatch(
  headers: string,
  nextUnit: string,
): boolean {
  const headerCols = headerTableColumnCount(headers);
  const rowCols = firstTableRowColumnCount(nextUnit);
  return headerCols > 0 && rowCols > 0 && headerCols !== rowCols;
}

/** 表头列名行是否已在 overlap/下一 unit 中出现（防重复前置）。 */
export function headerAlreadyPresent(
  headers: string,
  overlapText: string,
  unitText: string,
): boolean {
  if (overlapText.includes(headers) || unitText.includes(headers)) return true;
  const colRow = headerColumnRow(headers);
  if (colRow === "") return false;
  return overlapText.includes(colRow) || unitText.includes(colRow);
}

/** 从表头串提取列名行（首个非空、非 ---、非纯竖线行）。 */
export function headerColumnRow(header: string): string {
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.includes("---")) continue;
    let onlyPipes = true;
    for (const r of trimmed) {
      if (r !== "|" && r !== " " && r !== "\t") {
        onlyPipes = false;
        break;
      }
    }
    if (!onlyPipes) return trimmed;
  }
  return "";
}

// 让 tree-shaking/类型检查确认 runeLen 被 header 相关路径引用（语义上无需，避免未用 import 报错）。
export const _runeLenUsed = runeLen;
