/**
 * KB 路由 handler（POST/GET /kb、GET/DELETE /kb/:id）+ 文档路由（列表/单查/
 * 删除/任务）+ 检索路由。请求解析/DTO 校验/错误体/响应装配，无业务逻辑
 * （对齐 kb-service handlers.go 的边界层语义）。
 *
 * 检索/文档元数据的依赖经构造注入（测试不碰真 DB/Qdrant）。
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../router/app";
import { errorBody, identityOf, requestIdOf } from "../middleware/api-key";
import { canAccessKB, canAdmin, canRead, canWrite, type Identity } from "../middleware/auth";
import { knowledges, knowledgeBases, type IngestProgress } from "../db/schema";
import { toIso, toWireParseStatus, toWireSource } from "./wire";

// ---- 仓储薄层（handler 直查 DB；复杂检索走 kb-search service）----

export type KbHandlerDeps = {
  // 检索 service 注入（retrieve.ts 用）；这里只声明类型避免循环依赖。
  search: (request: {
    tenantId: string;
    kbIds: string[];
    query: string;
    topK: number;
    scoreThreshold: number;
    hybrid: boolean;
    rerank?: boolean;
  }) => Promise<{ results: unknown[]; count: number }>;
  dbQueries: {
    getKB(id: string): Promise<KbRow | null>;
    listKBs(tenantId: string): Promise<KbRow[]>;
    docCount(kbId: string): Promise<number>;
    listDocuments(kbId: string): Promise<DocRow[]>;
    getDocument(docId: string): Promise<DocRow | null>;
  };
};

export type KbRow = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  chunkSize: number;
  chunkOverlap: number;
  rerankModel: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocRow = {
  id: string;
  kbId: string;
  tenantId: string;
  title: string;
  type: string;
  fileName: string;
  fileType: string;
  parseStatus: string;
  chunkCount: number;
  metadata: Record<string, unknown> | null;
  progress: IngestProgress | null;
  errorMessage: string;
  createdAt: Date;
  updatedAt: Date;
};

// ---- KB ----

/** 建库请求体（kb-service createKBRequest 对齐）。 */
export type CreateKbInput = {
  name?: unknown;
  description?: unknown;
  embedder?: unknown;
  chunk_size?: unknown;
  chunk_overlap?: unknown;
  rerank_model?: unknown;
};

export function validateCreateKbInput(
  body: CreateKbInput,
): { ok: true; value: { name: string; description: string; chunkSize: number; chunkOverlap: number; rerankModel: string } } | { ok: false; message: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return { ok: false, message: "name is required" };
  return {
    ok: true,
    value: {
      name,
      description: typeof body.description === "string" ? body.description : "",
      chunkSize: typeof body.chunk_size === "number" && body.chunk_size > 0 ? body.chunk_size : 512,
      chunkOverlap:
        typeof body.chunk_overlap === "number" && body.chunk_overlap >= 0 ? body.chunk_overlap : 80,
      rerankModel: typeof body.rerank_model === "string" ? body.rerank_model : "",
    },
  };
}

/** KnowledgeBase wire 形状（model.go KnowledgeBase 逐字段）。 */
export function toWireKB(kb: KbRow, docCount: number): Record<string, unknown> {
  return {
    id: kb.id,
    tenant_id: kb.tenantId,
    name: kb.name,
    description: kb.description,
    embedder: "",
    chunk_size: kb.chunkSize,
    chunk_overlap: kb.chunkOverlap,
    ...(kb.rerankModel !== null && kb.rerankModel !== "" ? { rerank_model: kb.rerankModel } : {}),
    doc_count: docCount,
    created_at: toIso(kb.createdAt),
    updated_at: toIso(kb.updatedAt),
  };
}

/** KnowledgeDocument wire 形状（model.go Document 逐字段；manual→text）。 */
export function toWireDocument(doc: DocRow): Record<string, unknown> {
  return {
    id: doc.id,
    kb_id: doc.kbId,
    tenant_id: doc.tenantId,
    title: doc.title,
    source: toWireSource(doc.type),
    ...(doc.fileName !== "" ? { file_name: doc.fileName } : {}),
    ...(doc.fileType !== "" ? { file_type: doc.fileType } : {}),
    parse_status: toWireParseStatus(doc.parseStatus),
    chunk_count: doc.chunkCount,
    ...(doc.metadata !== null && Object.keys(doc.metadata).length > 0
      ? { metadata: doc.metadata }
      : {}),
    created_at: toIso(doc.createdAt),
    updated_at: toIso(doc.updatedAt),
  };
}

/** KnowledgeTask wire 形状（model.go Task 逐字段；任务号=文档号，进度来自 progress 回写）。 */
export function toWireTask(doc: DocRow): Record<string, unknown> {
  const progress = doc.progress;
  const wire = toWireParseStatus(doc.parseStatus);
  return {
    task_id: doc.id,
    kb_id: doc.kbId,
    doc_id: doc.id,
    status: wire,
    progress:
      progress && progress.chunksTotal > 0
        ? Math.min(100, Math.round((progress.chunksDone / progress.chunksTotal) * 100))
        : wire === "completed"
          ? 100
          : 0,
    chunks_done: progress?.chunksDone ?? 0,
    chunks_total: progress?.chunksTotal ?? 0,
    ...(doc.errorMessage !== "" && wire === "failed" ? { error: doc.errorMessage } : {}),
    created_at: toIso(doc.createdAt),
  };
}

// ---- 检索请求校验（Retrieve handler 用）----

export type RetrieveInput = {
  query?: unknown;
  top_k?: unknown;
  score_threshold?: unknown;
  hybrid?: unknown;
  rerank?: unknown;
};

export function validateRetrieveInput(
  body: RetrieveInput,
): { ok: true; value: { query: string; topK: number; scoreThreshold: number; hybrid: boolean; rerank: boolean } } | { ok: false; message: string } {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query === "") return { ok: false, message: "query is required" };
  const topK =
    typeof body.top_k === "number" && Number.isFinite(body.top_k) && body.top_k > 0
      ? Math.floor(body.top_k)
      : 5;
  const scoreThreshold =
    typeof body.score_threshold === "number" && Number.isFinite(body.score_threshold) && body.score_threshold >= 0
      ? body.score_threshold
      : 0;
  // hybrid 必须接受（P1 中间件固定传 true）；任何真值形态不 422。
  const hybrid = body.hybrid === undefined ? true : body.hybrid !== false;
  const rerank = body.rerank === true;
  return { ok: true, value: { query, topK, scoreThreshold, hybrid, rerank } };
}

// ---- 通用 helper ----

/** 越权/不存在统一 404（跨租户不泄漏存在性，对齐 kb-service 行为）。 */
export function notFound(context: Context<AppEnv>, message: string): Response {
  return context.json(errorBody(requestIdOf(context), "not_found", message), 404);
}

export function forbidden(context: Context<AppEnv>, message: string): Response {
  return context.json(errorBody(requestIdOf(context), "forbidden", message), 403);
}

/** KB 可达性检查：不存在或越权都 404。 */
export async function requireKB(
  context: Context<AppEnv>,
  deps: KbHandlerDeps,
  identity: Identity,
  kbId: string,
): Promise<KbRow | null> {
  const kb = await deps.dbQueries.getKB(kbId);
  if (kb === null) return null;
  if (!canAccessKB(identity, { tenantId: kb.tenantId, id: kb.id })) return null;
  return kb;
}

export { canRead, canWrite, canAdmin, identityOf };
