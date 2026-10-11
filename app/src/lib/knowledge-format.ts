/**
 * 知识库页面的展示格式化工具，从 WeKnora `utils/files.ts` / `utils/index.ts`
 * 直译：字节体积的 B/KB/MB 人读格式与 `YYYY-MM-DD HH:mm:ss` 日期串。纯函数、
 * 框架无关，供文档列表行内使用。
 */

/**
 * 字节数格式化为 B / KB / MB。
 *
 * null/undefined/空串/非正数返回空串——调用方以真值判断决定是否渲染，列表行
 * 里"0 B"没有信息量。字符串输入按十进制解析（上游 wire format 偶见字符串数字）。
 */
export function formatFileSize(bytes?: number | string | null): string {
  if (bytes == null || bytes === "") return "";
  const n = typeof bytes === "string" ? Number.parseInt(bytes, 10) : bytes;
  if (Number.isNaN(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 任意可被 Date 解析的输入格式化为本地时区 `YYYY-MM-DD HH:mm:ss`。
 * 解析失败返回空串而不是 "Invalid Date"。
 */
export function formatStringDate(date: string | number | Date): string {
  const parsed = new Date(date);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
  );
}
