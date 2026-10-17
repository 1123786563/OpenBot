import { describe, expect, test } from "../../../../../tests/support/e2e-compat";
import {
  builtinGrpcParser,
  DOCREADER_MAX_READ_BYTES,
  unavailableBuiltinParser,
} from "./builtin-grpc";
import {
  createParserRegistry,
  type DocReaderClient,
  normalizeExtension,
  type Parser,
  resolveParser,
} from "./registry";
import { simpleParser } from "./simple";

/** docparser 双引擎路由验证（gRPC client 注入 mock，不起真实服务）。 */

function makeFakeClient(
  overrides: Partial<Awaited<ReturnType<DocReaderClient["read"]>>> = {},
): DocReaderClient {
  return {
    read: async () => ({
      markdownContent: "# 来自 DocReader\n\n正文段落。",
      imageRefs: [
        {
          filename: "img1.png",
          originalRef: "http://x/1.png",
          mimeType: "image/png",
          storageKey: "s3://k",
        },
      ],
      imageDirPath: "/tmp/docreader-out",
      metadata: { engine: "builtin" },
      error: "",
      sourceBlocks: [
        { start: 0, end: 10, locatorJson: '{"type":"pdf","page":1}' },
      ],
      ...overrides,
    }),
  };
}

describe("registry routing", () => {
  test("normalizeExtension strips dot and lowercases", () => {
    expect(normalizeExtension(".PDF")).toBe("pdf");
    expect(normalizeExtension("Md")).toBe("md");
    expect(normalizeExtension("txt")).toBe("txt");
  });

  test("simple types route to the simple engine", () => {
    const registry = createParserRegistry(makeFakeClient());
    for (const ext of ["md", "txt", "csv", "json"]) {
      expect(resolveParser(ext, registry).name).toBe("simple");
    }
  });

  test("rich types route to the builtin (gRPC) engine", () => {
    const registry = createParserRegistry(makeFakeClient());
    for (const ext of [
      "pdf",
      "docx",
      "pptx",
      "xlsx",
      "html",
      "epub",
      "doc",
      "unknown-ext",
    ]) {
      expect(resolveParser(ext, registry).name).toBe("builtin");
    }
  });

  test("null client still routes but builtin reports unavailable", async () => {
    const registry = createParserRegistry(null);
    expect(resolveParser("pdf", registry).name).toBe("builtin-unavailable");
    await expect(
      resolveParser("pdf", registry).parseFile({
        fileContent: new Uint8Array(),
        fileName: "a.pdf",
        fileType: "pdf",
      }),
    ).rejects.toThrow(/DocReader is not configured/);
    // simple 类型不受影响
    expect(resolveParser("md", registry).name).toBe("simple");
  });
});

describe("simple parser", () => {
  test("decodes bytes as markdown with a text source block covering all", async () => {
    const parser = simpleParser();
    const content = "# 标题\n\n正文内容。";
    const result = await parser.parseFile({
      fileContent: new TextEncoder().encode(content),
      fileName: "note.md",
      fileType: "md",
    });
    expect(result.markdownContent).toBe(content);
    expect(result.imageRefs).toEqual([]);
    expect(result.sourceBlocks.length).toBe(1);
    expect(result.sourceBlocks[0].start).toBe(0);
    expect(result.sourceBlocks[0].end).toBe(Array.from(content).length);
    expect(JSON.parse(result.sourceBlocks[0].locatorJson)).toEqual({
      type: "text",
    });
    expect(result.metadata.file_name).toBe("note.md");
  });

  test("custom decoder is honoured (injection point)", async () => {
    const parser = simpleParser(() => "固定输出");
    const result = await parser.parseFile({
      fileContent: new Uint8Array([1, 2]),
      fileName: "x.txt",
      fileType: "txt",
    });
    expect(result.markdownContent).toBe("固定输出");
  });

  test("empty file yields empty content and no source blocks", async () => {
    const parser = simpleParser();
    const result = await parser.parseFile({
      fileContent: new Uint8Array(),
      fileName: "e.txt",
      fileType: "txt",
    });
    expect(result.markdownContent).toBe("");
    expect(result.sourceBlocks).toEqual([]);
  });

  test("URL parsing is refused", async () => {
    await expect(
      simpleParser().parseURL("https://example.com/doc.md"),
    ).rejects.toThrow(/does not handle URLs/);
  });
});

describe("builtin gRPC parser", () => {
  test("maps the gRPC response into a ReadResult", async () => {
    const parser = builtinGrpcParser(makeFakeClient());
    const result = await parser.parseFile({
      fileContent: new TextEncoder().encode("%PDF-fake"),
      fileName: "doc.pdf",
      fileType: "pdf",
    });
    expect(result.markdownContent).toContain("来自 DocReader");
    expect(result.imageRefs.length).toBe(1);
    expect(result.imageRefs[0].filename).toBe("img1.png");
    expect(result.sourceBlocks[0].locatorJson).toContain('"page":1');
    expect(result.imageDirPath).toBe("/tmp/docreader-out");
  });

  test("URL mode forwards url and title", async () => {
    let seen: Record<string, unknown> = {};
    const client: DocReaderClient = {
      read: async (req) => {
        seen = { ...req };
        return makeFakeClient().read({});
      },
    };
    await builtinGrpcParser(client).parseURL(
      "https://example.com/a.html",
      "标题",
    );
    expect(seen.url).toBe("https://example.com/a.html");
    expect(seen.title).toBe("标题");
  });

  test("oversize file (>50MB) is refused before the call", async () => {
    let called = false;
    const client: DocReaderClient = {
      read: async () => {
        called = true;
        return makeFakeClient().read({});
      },
    };
    const big = new Uint8Array(DOCREADER_MAX_READ_BYTES + 1);
    await expect(
      builtinGrpcParser(client).parseFile({
        fileContent: big,
        fileName: "huge.pdf",
        fileType: "pdf",
      }),
    ).rejects.toThrow(/exceeds DocReader Read limit/);
    expect(called).toBe(false);
  });

  test("upstream error field is carried, not thrown", async () => {
    const parser = builtinGrpcParser(
      makeFakeClient({ error: "parse failed: bad pdf" }),
    );
    const result = await parser.parseFile({
      fileContent: new Uint8Array(4),
      fileName: "b.pdf",
      fileType: "pdf",
    });
    expect(result.error).toBe("parse failed: bad pdf");
  });
});

describe("unavailable builtin parser", () => {
  const parser: Parser = unavailableBuiltinParser();
  test("both modes reject with the configuration message", async () => {
    await expect(
      parser.parseFile({
        fileContent: new Uint8Array(),
        fileName: "a",
        fileType: "pdf",
      }),
    ).rejects.toThrow(/DOCREADER_ADDR/);
    await expect(parser.parseURL("https://x/a.pdf")).rejects.toThrow(
      /DOCREADER_ADDR/,
    );
  });
});
