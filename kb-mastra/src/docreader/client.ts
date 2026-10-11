/**
 * DocReader gRPC 客户端（WeKnora docreader/client + grpc_parser 的 TS 对应物）。
 *
 * 动态加载 proto/docreader.proto（@grpc/proto-loader 的 load + @grpc/grpc-js 的
 * loadPackageDefinition——v0.8.1 的 proto-loader 只导出 load/loadSync，见
 * scripts/grpc-smoke.ts 的冒烟结论）。snake_case → camelCase 映射由 loader
 * 的 keepCase:false 完成；read() 的请求/响应都是本文件内的显式类型。
 *
 * 语义对齐 WeKnora：单次调用 deadline 30min（DOCREADER_CALL_TIMEOUT_MS），
 * 调用失败抛错由摄取管线记 failed；channel 级断线由 grpc-js 自带重连（READY
 * 探测），这里不额外做应用层重试——BullMQ 的 job 重试是那层的事。
 */

import * as grpc from "@grpc/grpc-js";
import { load, type PackageDefinition } from "@grpc/proto-loader";
import { getLogger } from "../../../shared/logger";
import type { DocReaderClient } from "../infrastructure/docparser/registry";

const log = getLogger("kb-mastra");

/** loader 选项：keepCase=false 让字段变 camelCase（B 线 registry 的接口形状）。 */
const LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

/** proto 文件路径（kb-mastra/proto/docreader.proto，随包分发）。 */
const PROTO_PATH = `${import.meta.dir}/../../proto/docreader.proto`;

/** DocReader.Read 的请求/响应（camelCase 投影）。 */
type RawReadRequest = {
  fileContent?: Uint8Array;
  fileName?: string;
  fileType?: string;
  url?: string;
  title?: string;
  requestId?: string;
};

type RawReadResponse = {
  markdownContent?: string;
  imageRefs?: {
    filename?: string;
    originalRef?: string;
    mimeType?: string;
    storageKey?: string;
  }[];
  imageDirPath?: string;
  metadata?: Record<string, string>;
  error?: string;
  sourceBlocks?: { start?: number; end?: number; locatorJson?: string }[];
};

type RawClient = {
  read(
    request: RawReadRequest,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response?: RawReadResponse) => void,
  ): void;
  close(): void;
};

export type DocReaderClientOptions = {
  /** host:port，如 docreader:50051。 */
  address: string;
  /** 单次调用 deadline；默认 30min（对齐 WeKnora DOCREADER_CALL_TIMEOUT）。 */
  callTimeoutMs?: number;
  /** 测试注入已加载的包定义。 */
  packageDefinition?: PackageDefinition;
};

/**
 * 创建并预热 DocReader 客户端。load() 是异步的（读 proto 文件），所以工厂
 * 是 async；返回 registry 期待的 DocReaderClient 接口。
 */
export async function createDocReaderClient(
  options: DocReaderClientOptions,
): Promise<DocReaderClient> {
  const packageDefinition =
    options.packageDefinition ??
    (await load(PROTO_PATH, {
      ...LOADER_OPTIONS,
      // load 的类型签名不接受 as const 的字面量展开，逐字段传。
    }));

  const loaded = grpc.loadPackageDefinition(packageDefinition) as Record<
    string,
    Record<string, unknown>
  >;
  const DocReaderCtor = loaded.docreader?.DocReader as unknown as new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ) => RawClient;
  if (typeof DocReaderCtor !== "function") {
    throw new Error("docreader.DocReader not found in the loaded proto.");
  }

  const raw = new DocReaderCtor(
    options.address,
    grpc.credentials.createInsecure(),
  );
  const timeoutMs = options.callTimeoutMs ?? 1_800_000;

  log.info(
    { type: "kb-docreader-client", address: options.address },
    "kb-docreader-client",
  );

  return {
    async read(request) {
      const response = await new Promise<RawReadResponse>(
        (resolve, reject) => {
          raw.read(
            {
              ...(request.fileContent !== undefined
                ? { fileContent: request.fileContent }
                : {}),
              ...(request.fileName !== undefined
                ? { fileName: request.fileName }
                : {}),
              ...(request.fileType !== undefined
                ? { fileType: request.fileType }
                : {}),
              ...(request.url !== undefined ? { url: request.url } : {}),
              ...(request.title !== undefined ? { title: request.title } : {}),
              ...(request.requestId !== undefined
                ? { requestId: request.requestId }
                : {}),
            },
            new grpc.Metadata(),
            { deadline: new Date(Date.now() + timeoutMs) },
            (error, value) => {
              if (error) return reject(error);
              if (!value) return reject(new Error("DocReader returned nothing."));
              resolve(value);
            },
          );
        },
      );

      // WeKnora 语义：DocReader 把解析失败折进 error 字段（HTTP 200 + error）。
      // 不在客户端抛——registry/管线的失败路径统一处理 error 字段。
      return {
        markdownContent: response.markdownContent ?? "",
        imageRefs: (response.imageRefs ?? []).map((ref) => ({
          filename: ref.filename ?? "",
          originalRef: ref.originalRef ?? "",
          mimeType: ref.mimeType ?? "",
          storageKey: ref.storageKey ?? "",
        })),
        imageDirPath: response.imageDirPath ?? "",
        metadata: response.metadata ?? {},
        error: response.error ?? "",
        sourceBlocks: (response.sourceBlocks ?? []).map((block) => ({
          start: block.start ?? 0,
          end: block.end ?? 0,
          locatorJson: block.locatorJson ?? "",
        })),
      };
    },
  };
}

/** 进程退出时关 channel（index/worker 装配处调用）。 */
export function closeDocReaderClient(client: DocReaderClient): void {
  // 接口面只有 read；close 经原始句柄走——当前实现由 raw 持有，channel 随
  // 进程结束回收，无需显式关（grpc-js 的 keepalive 在进程 SIGTERM 时断开）。
  void client;
}
