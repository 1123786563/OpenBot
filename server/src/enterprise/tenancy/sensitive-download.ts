// server/src/enterprise/tenancy/sensitive-download.ts
// T06.06（Issue #578，原任务 P15）：逐 pull 准入的敏感文件下载代理。
//
// interfaces §5（行 419 冻结摘录）：
//   GET|HEAD /api/enterprise/files/:fileId/content 由 P15 在 ingress 清单
//   核对后注册；Range 首期只支持单区间，多区间返回 416；
//   ReadableStream<Uint8Array>、highWaterMark:0，串行 pull 中短事务准入，
//   每次至多一次 enqueue、262144 字节；下一批以下一次 pull 为界；私有、
//   no-store、无 CDN 旁路；缓冲/存储/网络等待不持 DB 锁。
//
// 准入模型（BA06/BA14/M2 验收锚）：
//   - 请求开始：mint scope（resolveScope）+ 实时复验（gate.transaction）；
//     拒绝或撤销 = canonical 404，与「对象不存在」不可区分。
//   - 每个 pull：一次短事务准入（gate.transaction + source.authorize——
//     附件族即 readAttachmentFacts 的可见性判定），撤权（成员资格 epoch
//     递增 / 停用、对象撤销）在此**当场**失效，不依赖 outbox 补偿；
//     deny = 流终止，已 enqueue 的批次（≤262144）不追回。
//   - 字节读取（source.open/read）只发生在事务之外：存储/网络等待不持
//     DB 锁；无权者零字节读取（open 在首次准入通过后才发生）。
//   - 运行时（Bun/Hono）的预读 pull 走同一准入循环：highWaterMark:0、
//     无应用层预授权队列、无额外转换缓冲——enqueue 一次一批。
//
// 分层（与 T06.01–T06.05 服务面先例同款）：
//   - 本文件：路由工厂 + 流式准入循环（本票 owned file）；
//   - attachments.ts：附件族逐 pull 准入面 authorizeContent；
//   - execution-artifacts.ts：执行工件族下载的准入半边
//     authorizeExecutionArtifactDownload（装配经它构造族源）；
//   - 生产挂载（CoworkerSeams.enterpriseSensitiveDownloads + objectStore
//     字节源）归装配接线票（T08.05 bootstrap 先例；缺省 = 该路由不挂，
//     legacy 行为逐字节不变）。

import { Hono } from "hono";
import type { PlatformScope, ScopeResolver } from "../contracts";
import type { WorkspaceGate } from "./scope-gate";

/** 单批字节上限（interfaces 冻结值：262144）。 */
export const SENSITIVE_DOWNLOAD_BATCH_BYTES = 262144;

const NOT_FOUND_BODY = { error: "not_found" } as const;

/**
 * resolver 的拒绝集（与 T06.02 conversation-actions 同款语义）。
 * WORKSPACE_REVOKED 是 gate 错误码，resolver 目前不抛（冗余但无害）；
 * 资源级 RESOURCE_NOT_FOUND 由 source.authorize 的 deny 路径覆盖，不走此处。
 */
const SCOPE_RESOLVER_REFUSALS = new Set([
  "AUTH_REQUIRED",
  "TENANT_REQUIRED",
  "WORKSPACE_REQUIRED",
  "TENANT_FORBIDDEN",
  "WORKSPACE_FORBIDDEN",
  "SCOPE_REVOKED",
  "WORKSPACE_REVOKED",
]);

/**
 * 已授权对象的字节面。`read` 在任何事务之外调用（存储等待不持锁）；
 * 返回短于 maxBytes 的数据即为 EOF。
 */
export interface SensitiveFileBytes {
  readonly sizeBytes: number;
  read(offset: number, maxBytes: number): Promise<Uint8Array>;
}

/**
 * 族源 seam：`authorize` 在短事务内被调用（每 pull 一次，撤权后当场
 * null）；`open` 只在首次准入通过后调用（无权者零字节读取）。
 */
export interface SensitiveFileSource {
  authorize(
    scope: PlatformScope,
    fileId: string,
  ): Promise<{ readonly storageKey: string } | null>;
  open(storageKey: string): Promise<SensitiveFileBytes>;
}

export interface SensitiveDownloadRoutesDeps {
  /** 可信 scope 签发（createBaScopeResolver / createScopeResolver）。 */
  readonly resolveScope: Pick<ScopeResolver, "resolve">;
  /** 实时复验（createBaWorkspaceGate / createWorkspaceGate）。 */
  readonly gate: Pick<WorkspaceGate, "transaction">;
  readonly source: SensitiveFileSource;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 单区间 Range 解析。undefined = 无 Range 头或形状无效（按全量应答）；
 * "unsatisfiable" = 可解析但不可满足（多区间 / 越界 / 空后缀）→ 416。
 */
function parseRange(
  header: string | undefined,
  sizeBytes: number,
): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  if (!header.startsWith("bytes=")) return undefined;
  const spec = header.slice("bytes=".length).trim();
  if (spec.includes(",")) return "unsatisfiable"; // 首期不支持多区间
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return undefined;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return undefined;
  if (startText === "") {
    // 后缀区间 bytes=-n：最后 n 字节。
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
    if (sizeBytes === 0) return "unsatisfiable";
    const take = Math.min(suffix, sizeBytes);
    return { start: sizeBytes - take, end: sizeBytes - 1 };
  }
  const start = Number(startText);
  if (!Number.isInteger(start) || start < 0) return undefined;
  if (start >= sizeBytes) return "unsatisfiable";
  if (endText === "") return { start, end: sizeBytes - 1 };
  const end = Number(endText);
  if (!Number.isInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, sizeBytes - 1) };
}

function baseHeaders(sizeBytes: number): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "content-length": String(sizeBytes),
    "cache-control": "private, no-store",
    "accept-ranges": "bytes",
    // 无 CDN 旁路：中间层不得缓存私有响应。
    "x-openbot-sensitive": "1",
  };
}

export function createSensitiveDownloadRoutes(
  deps: SensitiveDownloadRoutesDeps,
): Hono {
  const notFound = (context: { json(body: unknown, status: 404): Response }) =>
    context.json(NOT_FOUND_BODY, 404);

  /**
   * 一次短事务准入：mint 后的 gate 复验 + 族门判定，deny = null。
   * 任何错误（含基础设施故障）一律 fail-closed 为 deny：下载面没有
   * 可安全继续的部分应答语义，宁可 canonical 404/截断也不漏字节。
   */
  const admit = async (
    scope: PlatformScope,
    fileId: string,
  ): Promise<{ readonly storageKey: string } | null> => {
    try {
      await deps.gate.transaction(scope, async () => undefined);
    } catch {
      return null;
    }
    try {
      return await deps.source.authorize(scope, fileId);
    } catch {
      return null;
    }
  };

  const handle = async (context: {
    req: {
      param(name: string): string;
      header(name: string): string | undefined;
      raw: Request;
    };
    json(body: unknown, status: 404): Response;
  }): Promise<Response> => {
    const fileId = context.req.param("fileId");
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return notFound(context);

    // 请求开始：mint + 实时复验。拒绝/撤销与不存在同形（不泄露）。
    let scope: PlatformScope;
    try {
      scope = await deps.resolveScope.resolve(context.req.raw);
    } catch (error) {
      if (
        error instanceof Error &&
        SCOPE_RESOLVER_REFUSALS.has(error.message)
      ) {
        return notFound(context);
      }
      throw error;
    }
    const first = await admit(scope, fileId);
    if (!first) return notFound(context);
    const bytes = await deps.source.open(first.storageKey);

    const range = parseRange(context.req.header("range"), bytes.sizeBytes);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${bytes.sizeBytes}`,
          "cache-control": "private, no-store",
        },
      });
    }
    const start = range === undefined ? 0 : range.start;
    const end = range === undefined ? bytes.sizeBytes - 1 : range.end;
    const headers = baseHeaders(end - start + 1);
    if (range !== undefined) {
      headers["content-range"] = `bytes ${start}-${end}/${bytes.sizeBytes}`;
    }

    if (context.req.raw.method === "HEAD") {
      return new Response(null, {
        status: range === undefined ? 200 : 206,
        headers,
      });
    }

    let offset = start;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          const admitted = await admit(scope, fileId);
          // 撤权/撤销/对象换位：流终止。已 enqueue 的批次不追回。
          if (
            !admitted ||
            admitted.storageKey !== first.storageKey ||
            bytes.sizeBytes < end + 1
          ) {
            controller.close();
            return;
          }
          const want = Math.min(
            SENSITIVE_DOWNLOAD_BATCH_BYTES,
            end - offset + 1,
          );
          // 事务外取字节：存储等待不持 DB 锁。
          const got = await bytes.read(offset, want);
          if (got.byteLength === 0) {
            controller.close();
            return;
          }
          const piece = got.byteLength > want ? got.subarray(0, want) : got;
          // Uint8Array 的 ArrayBufferLike 背书（subarray 视图零拷贝，不引入
          // 额外转换缓冲——interfaces 禁令）。
          controller.enqueue(piece as Uint8Array & { buffer: ArrayBuffer }); // 每次 pull 至多一次 enqueue
          offset += piece.byteLength;
          if (offset > end) controller.close();
        },
      },
      // 串行 pull：desiredSize 界内每次至多一批在途——运行时预读的每一
      // 个 pull 都走同一准入循环，无应用层预授权批次。
      { highWaterMark: 0 },
    );
    return new Response(stream as unknown as BodyInit, {
      status: range === undefined ? 200 : 206,
      headers,
    });
  };

  const app = new Hono();
  app.get("/api/enterprise/files/:fileId/content", handle);
  app.on("HEAD", "/api/enterprise/files/:fileId/content", handle);
  return app;
}
