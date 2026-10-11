/**
 * 十条路由注册（v1 §6.1 表）：路径/方法与 Go kb-service router.go 同形。
 * 依赖经 buildRoutes 注入（DB 查询薄层 + kb-search service），路由函数
 * 只做 HTTP 边界（解析→校验→service→装配）。
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Db } from "../db/client";
import { knowledgeBases, knowledges } from "../db/schema";
import {
  type DocRow,
  type KbHandlerDeps,
  type KbRow,
  notFound,
  requireKB,
  toWireDocument,
  toWireKB,
  toWireTask,
  validateCreateKbInput,
  validateRetrieveInput,
} from "../handler/shared";
import { errorBody, identityOf, requestIdOf } from "../middleware/api-key";
import { canAccessKB, canAdmin, canRead, canWrite } from "../middleware/auth";
import type { AppEnv } from "./app";

export type BuildRoutesDeps = {
  db: Db;
  search: KbHandlerDeps["search"];
  /** 文档创建/删除（T03 摄取管线的入口；T04 阶段返回 501 引导位）。 */
  documentIngest: {
    createFromJson(
      kb: KbRow,
      body: unknown,
    ): Promise<{ status: number; body: unknown }>;
    createFromUpload(
      kb: KbRow,
      form: FormData,
    ): Promise<{ status: number; body: unknown }>;
    deleteDocument(doc: DocRow): Promise<void>;
  } | null;
  /** 查询层覆写（测试注入桩；生产留空走 makeDbQueries(db)）。 */
  dbQueriesOverride?: KbHandlerDeps["dbQueries"];
};

/** DB 查询薄层（元数据四表直查；chunk 元数据在 kb-search 内）。 */
function makeDbQueries(db: Db): KbHandlerDeps["dbQueries"] {
  return {
    async getKB(id: string): Promise<KbRow | null> {
      const rows = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description,
        chunkSize: row.chunkingConfig.chunkSize,
        chunkOverlap: row.chunkingConfig.chunkOverlap,
        rerankModel: row.rerankModel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
    async listKBs(tenantId: string): Promise<KbRow[]> {
      const rows = await db
        .select()
        .from(knowledgeBases)
        .where(
          and(
            eq(knowledgeBases.tenantId, tenantId),
            isNull(knowledgeBases.deletedAt),
          ),
        )
        .orderBy(asc(knowledgeBases.createdAt));
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description,
        chunkSize: row.chunkingConfig.chunkSize,
        chunkOverlap: row.chunkingConfig.chunkOverlap,
        rerankModel: row.rerankModel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },
    async docCount(kbId: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(knowledges)
        .where(
          and(
            eq(knowledges.knowledgeBaseId, kbId),
            isNull(knowledges.deletedAt),
          ),
        );
      return rows[0]?.n ?? 0;
    },
    async listDocuments(kbId: string): Promise<DocRow[]> {
      const rows = await db
        .select()
        .from(knowledges)
        .where(
          and(
            eq(knowledges.knowledgeBaseId, kbId),
            isNull(knowledges.deletedAt),
          ),
        )
        .orderBy(asc(knowledges.createdAt));
      return rows.map(toDocRow);
    },
    async getDocument(docId: string): Promise<DocRow | null> {
      const rows = await db
        .select()
        .from(knowledges)
        .where(and(eq(knowledges.id, docId), isNull(knowledges.deletedAt)))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toDocRow(row);
    },
  };
}

type KnowledgeRow = typeof knowledges.$inferSelect;

function toDocRow(row: KnowledgeRow): DocRow {
  return {
    id: row.id,
    kbId: row.knowledgeBaseId,
    tenantId: row.tenantId,
    title: row.title,
    type: row.type,
    fileName: row.fileName,
    fileType: row.fileType,
    parseStatus: row.parseStatus,
    chunkCount: row.progress?.chunksTotal ?? 0,
    metadata: row.metadata ?? null,
    progress: row.progress ?? null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 挂载十条 /kb 路由（kb-service router.go 路径一一对应）。 */
export function buildRoutes(app: Hono<AppEnv>, deps: BuildRoutesDeps): void {
  const dbQueries = deps.dbQueriesOverride ?? makeDbQueries(deps.db);

  // 1. POST /kb — 建库（admin）
  app.post("/kb", async (context) => {
    const identity = identityOf(context);
    if (!canAdmin(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks admin permission",
        ),
        403,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        errorBody(requestIdOf(context), "bad_request", "invalid JSON body"),
        400,
      );
    }
    const validated = validateCreateKbInput(body as Record<string, unknown>);
    if (!validated.ok) {
      return context.json(
        errorBody(requestIdOf(context), "bad_request", validated.message),
        400,
      );
    }
    // T03 前的引导位：建库依赖 T01 骨架的 service 层写路径；此处返回明确 501。
    return context.json(
      errorBody(
        requestIdOf(context),
        "not_implemented",
        "KB creation arrives with T03 ingest wiring",
      ),
      501,
    );
  });

  // 2. GET /kb — 列表（read）
  app.get("/kb", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const kbs = await dbQueries.listKBs(identity.tenantId);
    const items = await Promise.all(
      kbs.map(async (kb) => toWireKB(kb, await dbQueries.docCount(kb.id))),
    );
    return context.json({ items, count: items.length });
  });

  // 3. GET /kb/:kbId — 详情（read）
  app.get("/kb/:kbId", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const kb = await requireKB(
      context,
      { dbQueries, search: deps.search },
      identity,
      context.req.param("kbId"),
    );
    if (kb === null) return notFound(context, "knowledge base not found");
    return context.json(toWireKB(kb, await dbQueries.docCount(kb.id)));
  });

  // 4. DELETE /kb/:kbId — 删库（admin；级联软删 T03 接线）
  app.delete("/kb/:kbId", async (context) => {
    const identity = identityOf(context);
    if (!canAdmin(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks admin permission",
        ),
        403,
      );
    }
    const kb = await requireKB(
      context,
      { dbQueries, search: deps.search },
      identity,
      context.req.param("kbId"),
    );
    if (kb === null) return notFound(context, "knowledge base not found");
    return context.json(
      errorBody(
        requestIdOf(context),
        "not_implemented",
        "KB deletion arrives with T03 ingest wiring",
      ),
      501,
    );
  });

  // 5. POST /kb/:kbId/documents — 上传（write；multipart file / url / text JSON）
  app.post("/kb/:kbId/documents", async (context) => {
    const identity = identityOf(context);
    if (!canWrite(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks write permission",
        ),
        403,
      );
    }
    const kb = await requireKB(
      context,
      { dbQueries, search: deps.search },
      identity,
      context.req.param("kbId"),
    );
    if (kb === null) return notFound(context, "knowledge base not found");
    if (deps.documentIngest === null) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "not_implemented",
          "document ingestion arrives with T03",
        ),
        501,
      );
    }
    const contentType = context.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await context.req.formData();
      return context.json(
        await deps.documentIngest.createFromUpload(kb, form),
        202 as never,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        errorBody(requestIdOf(context), "bad_request", "invalid JSON body"),
        400,
      );
    }
    const result = await deps.documentIngest.createFromJson(kb, body);
    return context.json(result.body, result.status as never);
  });

  // 6. GET /kb/:kbId/documents — 文档列表（read）
  app.get("/kb/:kbId/documents", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const kb = await requireKB(
      context,
      { dbQueries, search: deps.search },
      identity,
      context.req.param("kbId"),
    );
    if (kb === null) return notFound(context, "knowledge base not found");
    const docs = await dbQueries.listDocuments(kb.id);
    return context.json({
      items: docs.map(toWireDocument),
      count: docs.length,
    });
  });

  // 7. GET /kb/:kbId/documents/:docId — 文档详情（read）
  app.get("/kb/:kbId/documents/:docId", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const doc = await dbQueries.getDocument(context.req.param("docId"));
    if (doc === null) return notFound(context, "document not found");
    const kb = await dbQueries.getKB(doc.kbId);
    if (
      kb === null ||
      !canAccessKB(identity, { tenantId: kb.tenantId, id: kb.id })
    ) {
      return notFound(context, "document not found");
    }
    return context.json(toWireDocument(doc));
  });

  // 8. DELETE /kb/:kbId/documents/:docId — 删文档（write；先 Qdrant 后 SQL）
  app.delete("/kb/:kbId/documents/:docId", async (context) => {
    const identity = identityOf(context);
    const doc = await dbQueries.getDocument(context.req.param("docId"));
    if (doc === null) return notFound(context, "document not found");
    const kb = await dbQueries.getKB(doc.kbId);
    if (
      kb === null ||
      !canAccessKB(identity, { tenantId: kb.tenantId, id: kb.id })
    ) {
      return notFound(context, "document not found");
    }
    if (!canWrite(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks write permission",
        ),
        403,
      );
    }
    if (deps.documentIngest === null) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "not_implemented",
          "document deletion arrives with T03",
        ),
        501,
      );
    }
    await deps.documentIngest.deleteDocument(doc);
    return context.json({ deleted: true });
  });

  // 9. GET /kb/:kbId/tasks/:taskId — 任务状态（read；task_id=doc_id 投影）
  app.get("/kb/:kbId/tasks/:taskId", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const doc = await dbQueries.getDocument(context.req.param("taskId"));
    if (doc === null) return notFound(context, "task not found");
    const kb = await dbQueries.getKB(doc.kbId);
    if (
      kb === null ||
      !canAccessKB(identity, { tenantId: kb.tenantId, id: kb.id })
    ) {
      return notFound(context, "task not found");
    }
    return context.json(toWireTask(doc));
  });

  // 10. POST /kb/:kbId/retrieve — 检索（read）
  app.post("/kb/:kbId/retrieve", async (context) => {
    const identity = identityOf(context);
    if (!canRead(identity.role)) {
      return context.json(
        errorBody(
          requestIdOf(context),
          "forbidden",
          "role lacks read permission",
        ),
        403,
      );
    }
    const kb = await requireKB(
      context,
      { dbQueries, search: deps.search },
      identity,
      context.req.param("kbId"),
    );
    if (kb === null) return notFound(context, "knowledge base not found");
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        errorBody(requestIdOf(context), "bad_request", "invalid JSON body"),
        400,
      );
    }
    const validated = validateRetrieveInput(body as Record<string, unknown>);
    if (!validated.ok) {
      return context.json(
        errorBody(requestIdOf(context), "bad_request", validated.message),
        400,
      );
    }
    const { query, topK, scoreThreshold, hybrid, rerank } = validated.value;
    try {
      const outcome = await deps.search({
        tenantId: identity.tenantId,
        kbIds: [kb.id],
        query,
        topK,
        scoreThreshold,
        hybrid,
        ...(rerank ? { rerank } : {}),
      });
      return context.json({ results: outcome.results, count: outcome.count });
    } catch (_error) {
      // 上游（Qdrant/embedder）不可达：503 语义（OpenBot client 折 503 触发熔断）。
      return context.json(
        errorBody(
          requestIdOf(context),
          "unavailable",
          "knowledge service is unavailable. Try again.",
        ),
        503,
      );
    }
  });
}
