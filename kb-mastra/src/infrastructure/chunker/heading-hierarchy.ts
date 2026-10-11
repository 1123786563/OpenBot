/**
 * Markdown 标题层级栈：WeKnora chunker/heading_hierarchy.go 直译。
 * heading splitter 用它给每个 chunk 生成面包屑（"# Top\n## Section\n### Sub"）。
 * 与 header-tracker（表格表头，有显式 start/end）不同：Markdown 标题由下一个
 * 同级或更浅的标题结束，故建模为显式层级栈。
 */
import { markdownHeadingPattern } from "./patterns";

export class HeadingHierarchy {
  /** stack[i] 是 level i+1 的标题文本（stack[0] = H1）；深于当前层的为空串。 */
  private stack: string[] = ["", "", "", "", "", ""];
  private _depth = 0;

  /** 解析一行；是标题则更新层级栈，返回 [level, heading]，否则 [0, ""]。 */
  observe(line: string): [number, string] {
    const m = markdownHeadingPattern.exec(line);
    if (m === null) return [0, ""];
    const level = m[1].length;
    if (level < 1 || level > 6) return [0, ""];
    const heading = m[2].trim();
    // 替换本层并清空更深层：前一个同级/更深的兄弟不再在作用域内。
    this.stack[level - 1] = heading;
    for (let i = level; i < 6; i += 1) this.stack[i] = "";
    if (level > this._depth) {
      this._depth = level;
    } else {
      this._depth = 0;
      for (let i = 0; i < 6; i += 1) {
        if (this.stack[i] !== "") this._depth = i + 1;
      }
    }
    return [level, heading];
  }

  /** 当前标题路径（" > " 连接），无活动标题返回 ""。 */
  breadcrumb(): string {
    if (this._depth === 0) return "";
    const parts: string[] = [];
    for (let i = 0; i < this._depth; i += 1) {
      if (this.stack[i] !== "") parts.push(this.stack[i]);
    }
    return parts.join(" > ");
  }

  /** 保留原始 # 前缀的路径（嵌回 chunk 上下文用）。 */
  breadcrumbWithHashes(): string {
    if (this._depth === 0) return "";
    let out = "";
    for (let i = 0; i < this._depth; i += 1) {
      if (this.stack[i] === "") continue;
      if (out.length > 0) out += "\n";
      out += "#".repeat(i + 1);
      out += " ";
      out += this.stack[i];
    }
    return out;
  }

  depth(): number {
    return this._depth;
  }

  reset(): void {
    this.stack = ["", "", "", "", "", ""];
    this._depth = 0;
  }

  /** 深拷贝（heading splitter 在节起点快照层级状态用）。 */
  clone(): HeadingHierarchy {
    const copy = new HeadingHierarchy();
    copy.stack = [...this.stack];
    copy._depth = this._depth;
    return copy;
  }

  /** 当前状态快照（等价 clone；命名对齐 Go 版 sectionStart := *hierarchy 值拷贝）。 */
  snapshot(): HeadingHierarchy {
    return this.clone();
  }
}
