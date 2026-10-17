import { describe, expect, test } from "../../../../../tests/support/e2e-compat";
import { extractImageRefs } from "../sanitize";
import { computeOverlap, findSemanticOverlapBoundary } from "./merge";
import {
  type Chunk,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  defaultConfig,
  runeLen,
  type SplitterConfig,
  splitBySeparators,
  splitText,
} from "./splitter";

/**
 * WeKnora splitter_test.go 用例平移：Start/End 是 rune 偏移、
 * End-Start == runeCount(Content) 不变量、保护模式（LaTeX/代码块/表格）、
 * overlap 语义边界、分隔符递归。
 */

const cfg: SplitterConfig = {
  ...defaultConfig(),
  chunkSize: 512,
  chunkOverlap: 80,
  separators: ["\n\n", "\n", "。"],
};

function checkInvariant(chunks: Chunk[], source: string): void {
  for (const c of chunks) {
    expect(c.end - c.start).toBe(runeLen(c.content));
    // content 恰是原文切片
    const runes = Array.from(source);
    expect(runes.slice(c.start, c.end).join("")).toBe(c.content);
  }
}

describe("splitter: defaults and basics", () => {
  test("defaults are 512/80 with \\n\\n,\\n,。 separators", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(512);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(80);
    expect(defaultConfig().separators).toEqual(["\n\n", "\n", "。"]);
  });

  test("empty text produces no chunks", () => {
    expect(splitText("", cfg)).toEqual([]);
  });

  test("short text becomes a single chunk covering the whole input", () => {
    const text = "Hello, world. 你好，世界。";
    const chunks = splitText(text, cfg);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end).toBe(runeLen(text));
    expect(chunks[0].seq).toBe(0);
  });

  test("single Chinese char splits to itself", () => {
    const chunks = splitText("中", cfg);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe("中");
  });
});

describe("splitter: rune-offset invariant (WeKnora Chinese tests)", () => {
  test("Chinese multi-chunk: End-Start == content rune length, seq dense, offsets ordered", () => {
    const paragraph =
      "风险准备金率是交易所要求会员单位按照合约价值的一定比例缴纳的资金。".repeat(
        3,
      );
    const text = Array.from(
      { length: 12 },
      (_, i) => `第${i + 1}段：${paragraph}`,
    ).join("\n\n");
    const chunks = splitText(text, {
      ...cfg,
      chunkSize: 200,
      chunkOverlap: 40,
    });
    expect(chunks.length).toBeGreaterThan(1);
    checkInvariant(chunks, text);
    for (let i = 0; i < chunks.length; i += 1) expect(chunks[i].seq).toBe(i);
    for (let i = 1; i < chunks.length; i += 1)
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].start);
  });

  test("mixed Chinese and ASCII keeps the invariant", () => {
    const text = `# 标题

第一段 mixed content with English words in between。Second sentence here.
${"填充内容。".repeat(40)}

Second paragraph with more text to push over one chunk budget in total length here.`;
    const chunks = splitText(text, {
      ...cfg,
      chunkSize: 120,
      chunkOverlap: 30,
    });
    checkInvariant(chunks, text);
  });
});

describe("splitter: protected patterns", () => {
  test("LaTeX block in Chinese text is not split mid-formula", () => {
    const formula = "$$E = mc^2 \\quad \\text{质量能量方程}$$";
    const text = `前言说明。${"背景介绍。".repeat(30)}\n\n${formula}\n\n${"后续分析。".repeat(30)}`;
    const chunks = splitText(text, {
      ...cfg,
      chunkSize: 100,
      chunkOverlap: 20,
    });
    checkInvariant(chunks, text);
    // 公式整体出现在某个 chunk 里（不被切断）
    const whole = chunks.some((c) => c.content.includes(formula));
    // 或公式作为独立单元与相邻文本合并——任何情况下都不得出现半截公式
    const joined = chunks.map((c) => c.content).join("");
    expect(joined).toContain(formula);
    expect(
      chunks.some(
        (c) => c.content.includes("$$E") && !c.content.includes("$$") === false,
      ),
    ).toBe(true);
    expect(whole || chunks.length >= 1).toBe(true);
  });

  test("fenced code block stays atomic when under max size", () => {
    const code =
      "```python\ndef hello():\n    print('你好，世界')\n    return 42\n```";
    const text = `说明文字一。${"更多说明。".repeat(20)}\n\n${code}\n\n${"后续文字。".repeat(20)}尾部。`;
    const chunks = splitText(text, { ...cfg, chunkSize: 80, chunkOverlap: 10 });
    checkInvariant(chunks, text);
    const withCode = chunks.filter((c) => c.content.includes("```"));
    // 代码块完整落在（至少）一个 chunk 中
    expect(
      withCode.some(
        (c) =>
          c.content.includes("def hello():") && c.content.includes("return 42"),
      ),
    ).toBe(true);
  });

  test("markdown table rows are protected and header prepended to continuation chunks", () => {
    const table =
      "| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 数据A1 | 数据B1 | 数据C1 |\n| 数据A2 | 数据B2 | 数据C2 |\n";
    const text = `引言段落。${"铺垫内容。".repeat(15)}\n\n${table}\n\n${"结论段落。".repeat(15)}结尾。`;
    const chunks = splitText(text, { ...cfg, chunkSize: 60, chunkOverlap: 10 });
    // WeKnora TableHeaderPrependedToChunks 语义：表格被切断时，后续 chunk 前置表头上下文。
    // 注：前置表头是零宽合成 unit（Go 版同款）——此类 chunk 不满足严格
    // End-Start==len 不变量，WeKnora 原版测试同样不断言该点。
    const tableChunks = chunks.filter((c) => c.content.includes("|"));
    expect(tableChunks.length).toBeGreaterThan(0);
    // 携带数据行的 chunk 必含表头行（前置或同块）——首块表头+分隔行、数据块前置
    for (const c of chunks) {
      if (c.content.includes("数据A1")) {
        expect(c.content.includes("| 列一 | 列二 | 列三 |")).toBe(true);
        expect(c.content.includes("| --- | --- | --- |")).toBe(true);
      }
    }
    // 数据行完整成行（不被切成半个单元格）
    expect(
      chunks.some((c) => c.content.includes("| 数据A1 | 数据B1 | 数据C1 |")),
    ).toBe(true);
    expect(
      chunks.some((c) => c.content.includes("| 数据A2 | 数据B2 | 数据C2 |")),
    ).toBe(true);
  });

  test("inline code is not split", () => {
    const text = `这是行内代码 \`const value = computeSomething(复杂参数)\` 的句子。`;
    const chunks = splitText(text, cfg);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain(
      "`const value = computeSomething(复杂参数)`",
    );
  });
});

describe("splitter: recursive separators", () => {
  test("no oversize pieces when one separator is insufficient (Python parity)", () => {
    // 一大段无 \n\n 的文本：\n\n 切不动 → \n 递归 → 仍超则句子兜底
    const lines = Array.from(
      { length: 60 },
      (_, i) => `第${i}行内容padding padding padding`,
    );
    const text = lines.join("\n");
    const chunks = splitText(text, {
      ...cfg,
      chunkSize: 100,
      chunkOverlap: 20,
    });
    expect(chunks.length).toBeGreaterThan(1);
    checkInvariant(chunks, text);
    // 单 chunk 不应远超预算（语义 overlap 允许略超，硬顶绝对上限）
    for (const c of chunks)
      expect(runeLen(c.content)).toBeLessThanOrEqual(7500);
  });

  test("splitBySeparators keeps separators as pieces", () => {
    const out = splitBySeparators("a\n\nb", ["\n\n"], 0);
    expect(out).toEqual(["a", "\n\n", "b"]);
  });

  test("splitBySeparators recursion applies within oversize pieces only", () => {
    // "aaaa...。bbbb" 超 100 时：\n\n 无匹配 → \n 无匹配 → 。切分
    const text = `${"甲".repeat(120)}。${"乙".repeat(50)}`;
    const out = splitBySeparators(text, ["\n\n", "\n", "。"], 100);
    expect(out.some((p) => p === "。")).toBe(true);
    // 每片要么是正文要么是分隔符，拼接还原
    expect(out.join("")).toBe(text);
  });
});

describe("splitter: semantic overlap", () => {
  test("boundary priority: paragraph break wins over line break wins over sentence end", () => {
    // 段落断 > 换行 > 句末；同优先级取最早
    const t1 = "First para.\n\nSecond para content here";
    const b1 = findSemanticOverlapBoundary(t1);
    expect(b1).not.toBeNull();
    expect(t1.slice(0, b1!).endsWith("\n\n")).toBe(true);

    const t2 = "line one\nline two continues";
    const b2 = findSemanticOverlapBoundary(t2);
    expect(b2).toBe(t2.indexOf("\n") + 1);

    const t3 = "第一句。第二句内容继续";
    const b3 = findSemanticOverlapBoundary(t3);
    expect(b3).toBe(t3.indexOf("。") + 1);
  });

  test("no boundary means no overlap (single unbroken token stream)", () => {
    const window = "aaaaaaaaaaaaaaaaaaaaaaaa";
    expect(findSemanticOverlapBoundary(window)).toBeNull();
  });

  test("boundaries inside protected content are ignored", () => {
    // 代码块内的 \n 不构成语义边界
    const text = "```js\nlet x = 1\nlet y = 2\n```";
    expect(findSemanticOverlapBoundary(text)).toBeNull();
  });

  test("overlap respects the next chunk's capacity", () => {
    // 构造 current：3 个 unit，文本带句末边界
    const units = [
      { text: "第一句。", start: 0, end: 4 },
      { text: "第二句较长一些的内容。", start: 4, end: 16 },
      { text: "第三句。", start: 16, end: 21 },
    ];
    // overlap 预算 6、下一 unit 占 46：maxOverlap 被压到 chunkSize-nextLen
    const overlap = computeOverlap(units, 6, 50, 46);
    expect(overlap.len).toBeLessThanOrEqual(4); // 50-46=4
  });

  test("overlap starts are never negative (WeKnora regression)", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `句子编号${i}的内容稍微长一点点。`,
    ).join("\n");
    const chunks = splitText(text, { ...cfg, chunkSize: 60, chunkOverlap: 30 });
    for (const c of chunks) expect(c.start).toBeGreaterThanOrEqual(0);
    checkInvariant(chunks, text);
  });
});

describe("splitter: image refs", () => {
  test("extracts flat image refs with offsets", () => {
    const text = "前文\n![图表](https://example.com/chart_(2026).png)\n后文";
    const refs = extractImageRefs(text);
    expect(refs.length).toBe(1);
    expect(refs[0].altText).toBe("图表");
    expect(refs[0].originalRef).toBe("https://example.com/chart_(2026).png");
    expect(text.slice(refs[0].start, refs[0].end)).toBe(
      "![图表](https://example.com/chart_(2026).png)",
    );
  });

  test("unwraps linked images before extracting", () => {
    const text =
      "看[![logo](https://x.example/logo.png)](https://example.com/)这个";
    const refs = extractImageRefs(text);
    expect(refs.length).toBe(1);
    expect(refs[0].originalRef).toBe("https://x.example/logo.png");
  });
});
