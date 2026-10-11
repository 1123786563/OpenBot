/**
 * 文档列表排序：WeKnora `views/knowledge/documentSorting.ts` 的直译，但排序
 * 字段对齐 OpenBot 上游契约——`title`（上游没有独立的 file_name 列）而非
 * `file_name`，且排序发生在**客户端**（上游 documents 列表不支持排序参数）。
 *
 * 六个组合值（updated/created/title × asc/desc）保持不变，让"选哪个排序"的
 * 交互与 WeKnora 一致；`sortDocuments` 负责真正的比较。
 */

export type DocumentSortValue =
  | "updated_desc"
  | "updated_asc"
  | "created_desc"
  | "created_asc"
  | "title_asc"
  | "title_desc";

export const DEFAULT_DOCUMENT_SORT: DocumentSortValue = "created_desc";

/** 排序依据的字段：三个可排序列，与表头一一对应。 */
export type DocumentSortField = "updated_at" | "created_at" | "title";

export interface DocumentSortOption {
  value: DocumentSortValue;
  sortBy: DocumentSortField;
  sortOrder: "asc" | "desc";
}

export const DOCUMENT_SORT_OPTIONS: readonly DocumentSortOption[] = [
  { value: "updated_desc", sortBy: "updated_at", sortOrder: "desc" },
  { value: "updated_asc", sortBy: "updated_at", sortOrder: "asc" },
  { value: "created_desc", sortBy: "created_at", sortOrder: "desc" },
  { value: "created_asc", sortBy: "created_at", sortOrder: "asc" },
  { value: "title_asc", sortBy: "title", sortOrder: "asc" },
  { value: "title_desc", sortBy: "title", sortOrder: "desc" },
];

export function getDocumentSortOption(
  value: DocumentSortValue,
): DocumentSortOption {
  return (
    DOCUMENT_SORT_OPTIONS.find((option) => option.value === value) ??
    DOCUMENT_SORT_OPTIONS.find(
      (option) => option.value === DEFAULT_DOCUMENT_SORT,
    ) ??
    DOCUMENT_SORT_OPTIONS[0]
  );
}

/** 排序的最小行形状：只依赖三个字段，测试与复用都不需要整个 KnowledgeDocument。 */
type SortableDocument = Pick<
  KnowledgeDocShape,
  "title" | "created_at" | "updated_at"
>;

/** 让 lib 层不反向依赖类型模块：字段名与 KnowledgeDocument 一致即可排序。 */
interface KnowledgeDocShape {
  title?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 稳定排序：先按所选字段比较，同序号保持输入顺序（Array.prototype.sort 在
 * 各引擎中已是稳定的，这里直接依赖）。undefined 时间戳排在最后。
 */
export function sortDocuments<T extends SortableDocument>(
  documents: readonly T[],
  value: DocumentSortValue,
): T[] {
  const { sortBy, sortOrder } = getDocumentSortOption(value);
  const direction = sortOrder === "asc" ? 1 : -1;
  return [...documents].sort((a, b) => {
    if (sortBy === "title") {
      const left = a.title ?? "";
      const right = b.title ?? "";
      // localeCompare 让中文标题按拼音序而非码点序。
      return (
        left.localeCompare(right, undefined, { numeric: true }) * direction
      );
    }
    const left = Date.parse(a[sortBy] ?? "");
    const right = Date.parse(b[sortBy] ?? "");
    // 解析失败的值统一视为 0 时间，排序结果可预期。
    return (
      ((Number.isFinite(left) ? left : 0) -
        (Number.isFinite(right) ? right : 0)) *
      direction
    );
  });
}

/** 表头点击的下一档：同字段 asc↔desc 切换，跨字段进入该字段的默认序。 */
export function nextSortValue(
  current: DocumentSortValue,
  clickedField: DocumentSortField,
): DocumentSortValue {
  const option = getDocumentSortOption(current);
  if (option.sortBy === clickedField) {
    return clickedField === "title"
      ? option.sortOrder === "asc"
        ? "title_desc"
        : "title_asc"
      : clickedField === "created_at"
        ? option.sortOrder === "asc"
          ? "created_desc"
          : "created_asc"
        : option.sortOrder === "asc"
          ? "updated_desc"
          : "updated_asc";
  }
  // 进入新字段：时间字段默认最新在前，标题默认 A→Z。
  return clickedField === "title"
    ? "title_asc"
    : clickedField === "created_at"
      ? "created_desc"
      : "updated_desc";
}
