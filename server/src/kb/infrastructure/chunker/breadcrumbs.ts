/**
 * 面包屑合并与行尾规范化：WeKnora chunker/strategy.go 内的
 * mergeBreadcrumbs / NormalizeLineEndings 直译（拆出独立文件避免 strategy
 * 与 splitter 的循环依赖） */

/**
 * 合并父子面包屑。子级在父内容上重跑标题检测时，其首行通常重复父级末行
 * （父级开头标题在子输入顶部）；去掉该重复，避免嵌入上下文冗余。
 */
export function mergeBreadcrumbs(parent: string, child: string): string {
  if (parent === "") return child;
  if (child === "") return parent;
  const parentLines = parent.split("\n");
  const childLines = child.split("\n");
  if (
    parentLines.length > 0 &&
    childLines.length > 0 &&
    parentLines[parentLines.length - 1].trim() === childLines[0].trim()
  ) {
    childLines.shift();
  }
  if (childLines.length === 0) return parent;
  return `${parent}\n${childLines.join("\n")}`;
}

/**
 * 切分前行尾规范化：浏览器 textarea 把粘贴的 CRLF 折成 LF，上传文件保留
 * 原行尾；不规范化则同一文档产生不同字符数与切分边界。
 */
export function normalizeLineEndings(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
