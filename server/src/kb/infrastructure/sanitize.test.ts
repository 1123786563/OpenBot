import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import {
  cleanInvalidUTF8,
  EMBEDDING_MAX_CHARS,
  extractImageRefs,
  type ReadResult,
  sanitizeForEmbedding,
  sanitizeReadResult,
  unwrapLinkedImages,
} from "./sanitize";

/** WeKnora common/tools.go CleanInvalidUTF8 + knowledge_process.go sanitizeReadResult 直译验证。 */

function makeReadResult(over: Partial<ReadResult> = {}): ReadResult {
  return {
    markdownContent: "正文",
    imageDirPath: "/tmp/x",
    metadata: { k: "v" },
    error: "",
    imageRefs: [
      {
        filename: "f.png",
        originalRef: "http://x/f.png",
        mimeType: "image/png",
        storageKey: "s3://k",
      },
    ],
    sourceBlocks: [{ start: 0, end: 2, locatorJson: "{}" }],
    ...over,
  };
}

describe("cleanInvalidUTF8", () => {
  test("passes clean text through", () => {
    expect(cleanInvalidUTF8("正常文本 normal text")).toBe(
      "正常文本 normal text",
    );
  });

  test("strips NUL and replacement chars (invalid-byte decode products)", () => {
    expect(cleanInvalidUTF8("a\u0000b")).toBe("ab");
    expect(cleanInvalidUTF8("前\uFFFD后")).toBe("前后");
    expect(cleanInvalidUTF8("\u0000\uFFFD")).toBe("");
  });

  test("keeps emoji and CJK intact", () => {
    expect(cleanInvalidUTF8("🎉中文🚀")).toBe("🎉中文🚀");
  });
});

describe("sanitizeReadResult", () => {
  test("cleans every string field in place", () => {
    const result = makeReadResult({
      markdownContent: "文\u0000本",
      imageDirPath: "/tmp/\uFFFD",
      error: "err\u0000or",
      metadata: { k: "v\uFFFD" },
      imageRefs: [
        {
          filename: "f\u0000.png",
          originalRef: "http://x/\uFFFD",
          mimeType: "image/png",
          storageKey: "s\u0000",
        },
      ],
    });
    sanitizeReadResult(result);
    expect(result.markdownContent).toBe("文本");
    expect(result.imageDirPath).toBe("/tmp/");
    expect(result.error).toBe("error");
    expect(result.metadata.k).toBe("v");
    expect(result.imageRefs[0].filename).toBe("f.png");
    expect(result.imageRefs[0].originalRef).toBe("http://x/");
    expect(result.imageRefs[0].storageKey).toBe("s");
  });
});

describe("sanitizeForEmbedding", () => {
  test("strips base64 data URIs", () => {
    const content = "前文 ![img](data:image/png;base64,AAAA==) 后文";
    expect(sanitizeForEmbedding(content)).toBe("前文 ![img]() 后文");
  });

  test("truncates to 20000 code points", () => {
    const long = "字".repeat(EMBEDDING_MAX_CHARS + 100);
    const out = sanitizeForEmbedding(long);
    expect(Array.from(out).length).toBe(EMBEDDING_MAX_CHARS);
  });

  test("short content passes untouched", () => {
    expect(sanitizeForEmbedding("短内容")).toBe("短内容");
  });
});

describe("unwrapLinkedImages / extractImageRefs", () => {
  test("nested [![alt](img)](link) flattens to ![alt](img)", () => {
    expect(
      unwrapLinkedImages("[![logo](https://x/l.png)](https://example.com)"),
    ).toBe("![logo](https://x/l.png)");
  });

  test("flat image untouched by unwrap", () => {
    const flat = "![a](https://x/a.png)";
    expect(unwrapLinkedImages(flat)).toBe(flat);
  });

  test("extract multiple refs with correct offsets", () => {
    const text = "开头 ![一](https://a/1.png) 中间 ![二](https://b/2.png) 结尾";
    const refs = extractImageRefs(text);
    expect(refs.length).toBe(2);
    expect(refs[0].originalRef).toBe("https://a/1.png");
    expect(refs[1].originalRef).toBe("https://b/2.png");
    for (const r of refs) {
      expect(text.slice(r.start, r.end)).toMatch(/^!\[.*\]\(.*\)$/);
    }
  });
});
