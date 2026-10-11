import { describe, expect, test } from "bun:test";
import { mergeBreadcrumbs, normalizeLineEndings } from "./breadcrumbs";
import { type Chunk, defaultConfig, runeLen } from "./splitter";
import {
  deriveParentChildConfigs,
  ensureDefaults,
  mapChildrenToSource,
  normalizeSplitterConfig,
  split,
  splitParentChild,
  splitWithDiagnostics,
} from "./strategy";
import { validateChunks } from "./validator";

/** WeKnora strategy_test.go + parent_child_offsets_test.go 用例平移。 */

const cfg = defaultConfig();

describe("split（策略链）", () => {
  test("heading document selects heading tier via auto", () => {
    const text = Array.from(
      { length: 5 },
      (_, i) => `# 章节${i}\n\n${"本节内容说明。".repeat(20)}`,
    ).join("\n\n");
    const { chunks, diagnostics } = splitWithDiagnostics(text, {
      ...cfg,
      strategy: "auto",
    });
    expect(diagnostics.selectedTier).toBe("heading");
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((_c) => validateChunks(chunks, runeLen(text), 512).ok),
    ).toBe(true);
  });

  test("heading on a headingless document delegates its output (tier label stays heading)", () => {
    // splitByHeadingsImpl 无标题时直接调 splitText（legacy 实现），输出经 heading
    // 层交回且 validator 通过——selectedTier 仍记 heading（Go 版同款：层标签
    // 描述尝试的层，不区分层内部转发的实现）。
    const text = `无标题文档。${"普通句子。".repeat(60)}`;
    const { chunks, diagnostics } = splitWithDiagnostics(text, {
      ...cfg,
      strategy: "heading",
      chunkSize: 100,
    });
    expect(diagnostics.tierChain).toEqual(["heading", "legacy"]);
    expect(diagnostics.rejected.length).toBe(0); // heading 层输出直接通过
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("heuristic document picks heuristic tier", () => {
    const body = "正文句子。".repeat(30);
    const text = `第一章 引言\n${body}\n\n第二章 方法\n${body}`;
    const { diagnostics } = splitWithDiagnostics(text, {
      ...cfg,
      strategy: "auto",
      chunkSize: 200,
    });
    expect(diagnostics.tierChain).toContain("heuristic");
  });

  test("recursive is an alias of legacy", () => {
    const text = `文档。${"内容。".repeat(100)}`;
    const { diagnostics } = splitWithDiagnostics(text, {
      ...cfg,
      strategy: "recursive",
    });
    expect(diagnostics.tierChain).toEqual(["legacy"]);
  });

  test("empty strategy string means legacy", () => {
    const text = `文档。${"内容。".repeat(100)}`;
    const { diagnostics } = splitWithDiagnostics(text, {
      ...cfg,
      strategy: "",
    });
    expect(diagnostics.tierChain).toEqual(["legacy"]);
  });

  test("empty text returns no chunks", () => {
    expect(split("", cfg)).toEqual([]);
  });

  test("always returns at least one chunk for non-empty text", () => {
    const text = "单独一句。";
    expect(split(text, cfg).length).toBe(1);
  });
});

describe("parent-child（4096/384 与偏移不变量）", () => {
  test("deriveParentChildConfigs: 4096/384 defaults, child overlap = size/5, languages copied", () => {
    const base = {
      ...cfg,
      strategy: "auto" as const,
      tokenLimit: 500,
      languages: ["zh"],
    };
    const { parent, child } = deriveParentChildConfigs(base, 0, 0);
    expect(parent.chunkSize).toBe(4096);
    expect(child.chunkSize).toBe(384);
    expect(child.chunkOverlap).toBe(Math.floor(384 / 5));
    expect(parent.chunkOverlap).toBe(base.chunkOverlap);
    expect(child.languages).toEqual(["zh"]);
    expect(parent.tokenLimit).toBe(0); // TokenLimit 只拷给子级
    expect(child.tokenLimit).toBe(500);
  });

  test("children offsets map back to the document (parent_child_offsets_test.go)", () => {
    const body = "这是一个较长的段落，用来撑爆父块预算。".repeat(30);
    const text = Array.from(
      { length: 20 },
      (_, i) => `# 标题${i}\n\n${body}`,
    ).join("\n\n");
    const { parents, children } = splitParentChild(
      text,
      { ...cfg, chunkSize: 600 },
      { ...cfg, chunkSize: 120 },
    );
    expect(children.length).toBeGreaterThan(parents.length);
    expect(children.length).toBeGreaterThan(1);
    // 子块 End-Start == runeCount(Content)；内容是原文切片
    const runes = Array.from(text);
    for (const c of children) {
      expect(c.end - c.start).toBe(runeLen(c.content));
      expect(runes.slice(c.start, c.end).join("")).toBe(c.content);
    }
    // 子 Seq 全局唯一且稠密
    for (let i = 0; i < children.length; i += 1)
      expect(children[i].seq).toBe(i);
    // parentIndex 语义：-1 = 无父块（该父未被真正细分）；否则指向 parents 下标
    for (const c of children) {
      expect(c.parentIndex >= -1).toBe(true);
      if (c.parentIndex >= 0) expect(c.parentIndex < parents.length).toBe(true);
    }
  });

  test("single unsplit parent has parentIndex -1 and children carry its content", () => {
    const text = "短文档只有一句。";
    const { parents, children } = splitParentChild(text, cfg, {
      ...cfg,
      chunkSize: 512,
    });
    expect(parents.length).toBe(0); // 未细分 → 不入库
    expect(children.length).toBe(1);
    expect(children[0].parentIndex).toBe(-1);
    expect(children[0].content).toBe(text);
  });

  test("mapChildrenToSource: synthetic table-header prefix excluded from mapped span", () => {
    // 父块 content 30 rune（表头 21 + 正文 9），源区间 [100,109) 只覆盖正文 9 rune。
    const parent: Chunk = {
      content: "| A | B |\n| --- | --- |\n真实正文内容。",
      contextHeader: "",
      seq: 0,
      start: 100,
      end: 109,
    };
    const rawChildren: Chunk[] = [
      {
        content: "| A | B |\n| --- | --- |\n真实",
        contextHeader: "",
        seq: 0,
        start: 0,
        end: 20,
      },
      { content: "正文内容。", contextHeader: "", seq: 1, start: 21, end: 30 },
    ];
    const mapped = mapChildrenToSource(parent, rawChildren);
    // content 31 rune（表头 9+13+2 换行 + 正文 7），offset = 109-31 = 78。
    // child[1]: start=max(100, 78+21)=99→100（clamp 到父起点），end=78+30=108。
    expect(mapped.length).toBe(1);
    expect(mapped[0].start).toBe(100);
    expect(mapped[0].end).toBe(108);
    // 全在合成前缀内的 child[0]：end=78+20=98 < 100 → 丢弃
  });
});

describe("mergeBreadcrumbs", () => {
  test("drops the duplicated parent tail / child head line", () => {
    expect(mergeBreadcrumbs("# Top\n## Sub", "## Sub\n### Deep")).toBe(
      "# Top\n## Sub\n### Deep",
    );
  });

  test("no overlap concatenates with newline", () => {
    expect(mergeBreadcrumbs("# Top", "## Other")).toBe("# Top\n## Other");
  });

  test("child identical to parent collapses", () => {
    expect(mergeBreadcrumbs("# Top", "# Top")).toBe("# Top");
  });

  test("empty sides pass through", () => {
    expect(mergeBreadcrumbs("", "# A")).toBe("# A");
    expect(mergeBreadcrumbs("# A", "")).toBe("# A");
  });
});

describe("normalizeLineEndings", () => {
  test("CRLF and lone CR collapse to LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  test("text without CR passes through untouched", () => {
    expect(normalizeLineEndings("plain")).toBe("plain");
  });
});

describe("config normalization", () => {
  test("normalizeSplitterConfig fills zero values with 512/80/defaults", () => {
    const out = normalizeSplitterConfig({
      ...cfg,
      chunkSize: 0,
      chunkOverlap: -5,
      separators: [],
    });
    expect(out.chunkSize).toBe(512);
    expect(out.chunkOverlap).toBe(80);
    expect(out.separators).toEqual(["\n\n", "\n", "。"]);
  });

  test("ensureDefaults caps overlap at half the chunk size", () => {
    const out = ensureDefaults({ ...cfg, chunkSize: 100, chunkOverlap: 90 });
    expect(out.chunkOverlap).toBe(50);
  });

  test("ensureDefaults clamps chunkSize to the token budget", () => {
    // zh: 1.7 chars/token，300 tokens → 300*1.7*0.9=459 < 512
    const out = ensureDefaults({
      ...cfg,
      chunkSize: 512,
      tokenLimit: 300,
      languages: ["zh"],
    });
    expect(out.chunkSize).toBe(459);
  });
});
