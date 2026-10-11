/**
 * builtin 解析引擎：经 DocReader gRPC 客户端（:50051，进程外 Python 服务）
 * 解析 pdf/docx/pptx/xlsx/html/epub 等富文档。WeKnora grpc_parser.go 的
 * 路由层直译——client 本体在 src/docreader/client.ts（A 线），本文件只做
 * 请求组装与响应映射。调用超时语义由 client 内部实现（30min，对齐
 * WeKnora DOCREADER_CALL_TIMEOUT）；断线重连同样在 client 层。
 */
import type { ReadResult } from "../sanitize";
import type { DocReaderClient, Parser } from "./registry";

/** Read 单调上限（proto 层无约束，服务侧硬顶；超限调用方应走 422）。 */
export const DOCREADER_MAX_READ_BYTES = 50 * 1024 * 1024;

export function builtinGrpcParser(client: DocReaderClient): Parser {
  return {
    name: "builtin",
    extensions: [], // 兜底引擎：未被显式注册的扩展全部走这里
    async parseFile({ fileContent, fileName, fileType }) {
      if (fileContent.byteLength > DOCREADER_MAX_READ_BYTES) {
        throw new Error(
          `file exceeds DocReader Read limit of ${DOCREADER_MAX_READ_BYTES} bytes`,
        );
      }
      const response = await client.read({
        fileContent,
        fileName,
        fileType,
      });
      return toReadResult(response);
    },
    async parseURL(url, title) {
      const response = await client.read({ url, title });
      return toReadResult(response);
    },
  };
}

/** docreader 未配置时的兜底引擎：明确报错而非静默失败。 */
export function unavailableBuiltinParser(): Parser {
  const message =
    "DocReader is not configured (DOCREADER_ADDR); rich-document parsing is unavailable";
  return {
    name: "builtin-unavailable",
    extensions: [],
    async parseFile() {
      throw new Error(message);
    },
    async parseURL() {
      throw new Error(message);
    },
  };
}

function toReadResult(
  response: Awaited<ReturnType<DocReaderClient["read"]>>,
): ReadResult {
  // 上游报错时携带 error 字段返回（service 层决定 failed 语义），不在此抛出。
  return {
    markdownContent: response.markdownContent,
    imageDirPath: response.imageDirPath,
    metadata: { ...response.metadata },
    error: response.error,
    imageRefs: response.imageRefs.map((r) => ({ ...r })),
    sourceBlocks: response.sourceBlocks.map((b) => ({ ...b })),
  };
}
