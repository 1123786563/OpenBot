/**
 * DocReader gRPC 冒烟脚本（T01 验收项：验证 bun + @grpc/grpc-js + proto-loader
 * 组合可加载 proto、可连接 docreader 服务、可发起 RPC）。
 *
 * 用法：
 *   DOCREADER_ADDR=localhost:50051 bun scripts/grpc-smoke.ts
 *
 * 三级结论：
 *   1. proto 加载 + 客户端构造成功 → bun 档可行（核心结论，不需要服务在线）；
 *   2. 服务在线时 ListEngines/Read 成功 → 全链路验证；
 *   3. 服务不在线 → 连接超时/拒绝不算失败（记录 proto 结论即可），退出码 2。
 */

import * as grpc from "@grpc/grpc-js";
import { load, type PackageDefinition } from "@grpc/proto-loader";
import { getLogger } from "../../shared/logger";

const log = getLogger("kb-mastra");

const addr = process.env.DOCREADER_ADDR ?? "localhost:50051";
const protoPath = new URL("../proto/docreader.proto", import.meta.url).pathname;

/** loader 选项对齐 WeKnora docreader client 的加载参数。 */
const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

type DocReaderClient = {
  listEngines: (
    request: Record<string, unknown>,
    callback: (error: Error | null, response: unknown) => void,
    deadline?: number,
  ) => void;
  read: (
    request: Record<string, unknown>,
    callback: (error: Error | null, response: unknown) => void,
    deadline?: number,
  ) => void;
  waitForReady: (
    deadline: Date,
    callback: (error: Error | null) => void,
  ) => void;
  close: () => void;
};

async function main(): Promise<number> {
  // 第 1 级：proto 加载（bun 档结论的核心证据）。
  const packageDefinition: PackageDefinition = await load(
    protoPath,
    LOADER_OPTIONS,
  );
  const loaded = grpc.loadPackageDefinition(packageDefinition) as Record<
    string,
    Record<string, unknown>
  >;
  const DocReaderCtor = loaded.docreader?.DocReader as unknown as new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ) => DocReaderClient;
  if (typeof DocReaderCtor !== "function") {
    throw new Error("docreader.DocReader not found in the loaded proto.");
  }
  log.info(
    { type: "kb-grpc-proto-loaded", services: Object.keys(loaded) },
    "kb-grpc-proto-loaded",
  );

  const client = new DocReaderCtor(addr, grpc.credentials.createInsecure());

  // 第 2 级：连接 + ListEngines（服务在线才有）。
  const connected = await new Promise<boolean>((resolve) => {
    client.waitForReady(new Date(Date.now() + 5_000), (error) =>
      resolve(!error),
    );
  });
  if (!connected) {
    log.warn(
      { type: "kb-grpc-smoke", reachable: false, addr },
      "kb-grpc-smoke: docreader not reachable (proto load OK — bun tier works)",
    );
    client.close();
    return 2;
  }

  const engines = await new Promise<unknown>((resolve, reject) => {
    client.listEngines({ configOverrides: {} }, (error, response) =>
      error ? reject(error) : resolve(response),
    );
  });
  log.info(
    {
      type: "kb-grpc-smoke",
      reachable: true,
      engines: JSON.stringify(engines).slice(0, 500),
    },
    "kb-grpc-smoke: docreader ListEngines OK",
  );

  // 第 3 级：Read 一个小 markdown（builtin 引擎）——全数据面验证。
  // ⚠️ keepCase:true 时请求字段必须 snake_case（file_content/file_name/
  // file_type/config.parser_engine）：camelCase 会被静默丢成空值，服务端报
  // "Unsupported file type: "。响应字段同为 snake_case（markdown_content/
  // source_blocks）。
  const smokeContent = Buffer.from(
    "# kb-mastra gRPC smoke\n\nread roundtrip body.\n",
  );
  const read = await new Promise<{
    error?: string;
    markdown_content?: string;
    source_blocks?: unknown[];
  }>((resolve, reject) => {
    client.read(
      {
        file_content: smokeContent,
        file_name: "smoke.md",
        file_type: "md",
        config: { parser_engine: "builtin" },
        request_id: "kb-grpc-smoke",
      },
      (error, response) =>
        error
          ? reject(error)
          : resolve(
              response as {
                error?: string;
                markdown_content?: string;
                source_blocks?: unknown[];
              },
            ),
      Date.now() + 60_000,
    );
  });
  const readOk = !read.error;
  const markdownChars = read.markdown_content?.length ?? 0;
  if (!readOk || markdownChars === 0) {
    throw new Error(
      `docreader Read failed: error=${read.error ?? "(empty markdown)"}`,
    );
  }
  log.info(
    {
      type: "kb-grpc-smoke-read",
      readOk,
      markdownChars,
      sourceBlocks: read.source_blocks?.length ?? 0,
    },
    "kb-grpc-smoke: docreader Read OK",
  );
  client.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error(
      {
        type: "kb-grpc-smoke-failed",
        error: (error as Error).name,
        message: (error as Error).message,
      },
      "kb-grpc-smoke-failed",
    );
    process.exit(1);
  },
);
