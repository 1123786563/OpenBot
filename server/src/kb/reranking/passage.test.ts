import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import { cleanPassage, fitPassages, modelPassage } from "./passage";

/** passage.go 直译验证：清洗步骤序与 ModelPassage 组装。 */

describe("cleanPassage", () => {
  test("fenced code block unwrapped to body", () => {
    expect(cleanPassage("```python\ndef hello():\n    return 42\n```")).toBe(
      "def hello():\n    return 42",
    );
  });

  test("latex block unwrapped", () => {
    expect(cleanPassage("$$E = mc^2$$")).toBe("E = mc^2");
  });

  test("html tags stripped", () => {
    expect(cleanPassage('<div class="x">内容</div>')).toBe("内容");
  });

  test("markdown image removed entirely (surrounding spaces stay, Go parity)", () => {
    expect(cleanPassage("前文 ![图](https://x/img.png) 后文")).toBe(
      "前文  后文",
    );
  });

  test("linked image unwrapped then removed", () => {
    expect(
      cleanPassage("见 [![logo](https://x/l.png)](https://ex.com) 这里"),
    ).toBe("见  这里");
  });

  test("markdown link keeps text drops url", () => {
    expect(cleanPassage("查看 [文档](https://x/doc) 继续")).toBe(
      "查看 文档 继续",
    );
  });

  test("raw urls removed", () => {
    expect(cleanPassage("访问 https://example.com/page?q=1 结束")).toBe(
      "访问  结束",
    );
  });

  test("table separator row removed, data rows flattened", () => {
    const table = "| 名称 | 数值 |\n| --- | --- |\n| 准备金 | 12% |";
    // 分隔行移除后留下空行（Go ReplaceAllString 同款）
    expect(cleanPassage(table)).toBe("名称, 数值\n\n准备金, 12%");
  });

  test("heading markers stripped keeping text", () => {
    expect(cleanPassage("## 章节标题\n正文")).toBe("章节标题\n正文");
  });

  test("blockquote marker stripped", () => {
    expect(cleanPassage("> 引用内容")).toBe("引用内容");
  });

  test("bold/italic unwrapped in correct order", () => {
    expect(cleanPassage("***重点*** 和 **粗体** 和 *斜体*")).toBe(
      "重点 和 粗体 和 斜体",
    );
  });

  test("list markers stripped", () => {
    expect(cleanPassage("- 项目一\n1. 项目二")).toBe("项目一\n项目二");
  });

  test("excessive newlines collapsed to two", () => {
    expect(cleanPassage("段一\n\n\n\n\n段二")).toBe("段一\n\n段二");
  });

  test("composite markdown document", () => {
    const doc = `# 指南

这是一个 [链接](https://x.io) 与 ![图片](https://x/img.png)。

\`\`\`js
console.log("代码");
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |
`;
    const out = cleanPassage(doc);
    expect(out).not.toContain("#");
    expect(out).not.toContain("!");
    expect(out).not.toContain("https://");
    expect(out).toContain("指南");
    expect(out).toContain("链接");
    expect(out).toContain("代码");
    expect(out).toContain("A, B");
    expect(out).toContain("1, 2");
  });
});

describe("modelPassage", () => {
  test("title + context header + cleaned body", () => {
    const out = modelPassage({
      content: "正文 **重点** 内容",
      contextHeader: "## 第二节",
      knowledgeTitle: "风险手册",
    });
    expect(out).toBe("风险手册\n\n## 第二节\n\n正文 重点 内容");
  });

  test("blank content yields blank passage regardless of headers", () => {
    expect(
      modelPassage({ content: "  ", contextHeader: "H", knowledgeTitle: "T" }),
    ).toBe("");
  });

  test("no headers = cleaned body only", () => {
    expect(modelPassage({ content: "普通正文" })).toBe("普通正文");
  });
});

describe("fitPassages", () => {
  test("trims to rune limit (code points not utf-16)", () => {
    const passages = ["字".repeat(50), "短"];
    const trimmed = fitPassages(passages, 10);
    expect(trimmed).toBe(1);
    expect(Array.from(passages[0]).length).toBe(10);
    expect(passages[1]).toBe("短");
  });

  test("limit 0 = no trim", () => {
    const passages = ["很长的".repeat(100)];
    fitPassages(passages, 0);
    expect(passages[0].length).toBe(300);
  });
});
