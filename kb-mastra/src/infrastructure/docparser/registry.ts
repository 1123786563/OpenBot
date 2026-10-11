/**
 * 解析引擎路由与双引擎实现：WeKnora `internal/infrastructure/docparser/`
 * 的 engine_registry + simple（本地 md/txt/csv/json）+ builtin（DocReader
 * gRPC）三件的路由层。anydoc/mineru/paddleocr_vl 引擎 P1 不注册（设计 §5.1
 * TODO 注册点），走 builtin 兜底。
 */
import type { ReadResult } from "../sanitize";
import { builtinGrpcParser, unavailableBuiltinParser } from "./builtin-grpc";
import { simpleParser } from "./simple";

/**
 * DocReader gRPC 客户端的最小接口。真实实现由 A 线的 src/docreader/client.ts
 * 提供（@grpc/grpc-js + 生成桩，30min 调用超时对齐 WeKnora DOCREADER_CALL_TIMEOUT）；
 * 测试与独立使用注入 mock。接口只暴露 Read 一个方法——registry 不关心
 * ListEngines/ReadStream（P1 用 Read + 50MB 上限，超限 422）。
 */
export interface DocReaderClient {
  read(request: {
    fileContent?: Uint8Array;
    fileName?: string;
    fileType?: string;
    url?: string;
    title?: string;
    requestId?: string;
  }): Promise<{
    markdownContent: string;
    imageRefs: {
      filename: string;
      originalRef: string;
      mimeType: string;
      storageKey: string;
    }[];
    imageDirPath: string;
    metadata: Record<string, string>;
    error: string;
    sourceBlocks: { start: number; end: number; locatorJson: string }[];
  }>;
}

/** 解析器接口：输入（文件字节或 URL）→ ReadResult。 */
export type Parser = {
  /** 引擎名（诊断/日志用）。 */
  name: string;
  /** 该引擎支持的扩展名（小写、不带点）；空 = 兜底引擎。 */
  extensions: readonly string[];
  parseFile(input: {
    fileContent: Uint8Array;
    fileName: string;
    fileType: string;
  }): Promise<ReadResult>;
  parseURL(url: string, title?: string): Promise<ReadResult>;
};

/** simple 引擎处理的本地可读文本类型。 */
export const SIMPLE_EXTENSIONS = ["md", "txt", "csv", "json"] as const;

/** 路由规则：md/txt/csv/json → simple；其余（pdf/docx/pptx/xlsx/html/epub…）→ builtin。 */
export function resolveParser(
  fileType: string,
  registry: ParserRegistry,
): Parser {
  return registry.forExtension(fileType);
}

export class ParserRegistry {
  private parsers: Parser[] = [];
  private fallback: Parser;

  constructor(fallback: Parser) {
    this.fallback = fallback;
  }

  register(parser: Parser): void {
    this.parsers.push(parser);
  }

  forExtension(fileType: string): Parser {
    const ext = normalizeExtension(fileType);
    for (const p of this.parsers) {
      if (p.extensions.includes(ext)) return p;
    }
    return this.fallback;
  }
}

export function normalizeExtension(fileType: string): string {
  const raw = fileType.trim().toLowerCase();
  const withoutDot = raw.startsWith(".") ? raw.slice(1) : raw;
  return withoutDot;
}

/**
 * 构建默认注册表：simple（本地文本四类）+ builtin-gpc 兜底。
 * docReaderClient 为 null 时（docreader 服务未配置），builtin 引擎的
 * parse 调用会抛错——路由层不静默降级，让摄取管线把它记为 failed。
 */
export function createParserRegistry(
  docReaderClient: DocReaderClient | null,
): ParserRegistry {
  const registry = new ParserRegistry(
    docReaderClient !== null
      ? builtinGrpcParser(docReaderClient)
      : unavailableBuiltinParser(),
  );
  registry.register(simpleParser());
  return registry;
}
