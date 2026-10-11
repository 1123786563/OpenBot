/**
 * kb-mastra HTTP 入口：启动自检（迁移 + ensureCollection）→ 组装十条路由
 * （buildRoutes + T03 摄取接线 + T04 检索链）→ Bun.serve。
 *
 * 装配一览：
 *   kbAdmin        —— knowledge_bases 建/删（kb-service 的 CreateKB/DELETE 语义）
 *   documentIngest —— 三入口创建（file/url/text）+ 文档级联删（knowledge-* 服务）
 *   search         —— hybridSearch（embedder + qdrant composite + keywords no-op）
 */

import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getLogger } from "../../shared/logger";
import { hybridSearch } from "./application/service/kb-search";
import {
  createFileKnowledge,
  createTextKnowledge,
  createUrlKnowledge,
  DuplicateDocumentError,
} from "./application/service/knowledge-create";
import { deleteKnowledge, deleteKnowledgeBase } from "./application/service/knowledge-delete";
import { createCompositeRetrieveEngine } from "./application/service/retriever/composite";
import { createDefaultRegistry } from "./application/service/retriever/registry";
import { createIndexWriter } from "./application/repository/retriever/qdrant/index-writer";
import { loadConfig } from "./config";
import { getDb } from "./db/client";
import { knowledgeBases } from "./db/schema";
import { QdrantClient } from "./infrastructure/qdrant/client";
import { collectionName, ensureCollection } from "./infrastructure/qdrant/collections";
import { createBatchEmbedder } from "./models/embedding/batch";
import { withConcurrency } from "./models/embedding/concurrency";
import { createOllamaEmbedder } from "./models/embedding/ollama";
import { createApp } from "./router/app";
import { buildRoutes } from "./router/routes";
import { enqueueDocumentProcess } from "./tasks/queue";

const log = getLogger("kb-mastra");

const config = loadConfig();

/**
 * 启动自检：迁移（pg_advisory_lock 互斥）→ ensureCollection（存在性/维度/
 * distance 校验 + payload 索引幂等声明）。幂等：重复启动安全；失败 fail fast。
 */
async function startupChecks(): Promise<QdrantClient> {
  const { runMigrations } = await import("./db/migrate");
  await runMigrations();

  const qdrant = new QdrantClient({
    baseUrl: config.qdrantUrl,
    ...(config.qdrantApiKey !== "" ? { apiKey: config.qdrantApiKey } : {}),
  });
  await ensureCollection(qdrant, config.embedDimensions);
  return qdrant;
}

const qdrantClient = await startupChecks().catch((error: unknown) => {
  log.error(
    {
      type: "kb-mastra-startup-failed",
      error: (error as Error).name,
      message: (error as Error).message,
    },
    "kb-mastra-startup-failed",
  );
  process.exit(1);
});

// ---- 装配 ----

const db = getDb();
const collection = collectionName(config.embedDimensions);
const indexWriter = createIndexWriter(qdrantClient, collection, {
  batchSize: config.qdrantBatch,
});

const embedder = withConcurrency(
  createBatchEmbedder(
    createOllamaEmbedder({
      baseUrl: config.ollamaBaseUrl,
      model: config.embedModel,
      dimensions: config.embedDimensions,
    }),
    { batchSize: config.batchEmbedSize },
  ),
  { maxConcurrency: config.embedMaxConcurrency },
);

const registry = createDefaultRegistry({ client: qdrantClient, collection });
const composite = createCompositeRetrieveEngine(registry.engines());

const createDeps = { db, storageRoot: config.storageLocalPath };

const app = createApp();
buildRoutes(app, {
  db,
  async search(request) {
    const outcome = await hybridSearch(
      { embedder, composite, db },
      {
        tenantId: request.tenantId,
        kbIds: request.kbIds,
        query: request.query,
        topK: request.topK,
        scoreThreshold: request.scoreThreshold,
        hybrid: request.hybrid,
        ...(request.rerank !== undefined ? { rerank: request.rerank } : {}),
      },
    );
    return { results: outcome.results, count: outcome.count };
  },
  kbAdmin: {
    async createKb(identity, input) {
      const id = randomUUID();
      await db.insert(knowledgeBases).values({
        id,
        tenantId: identity.tenantId,
        name: input.name,
        description: input.description,
        chunkingConfig: {
          chunkSize: input.chunkSize,
          chunkOverlap: input.chunkOverlap,
          separators: ["\n\n", "\n", "。"],
          strategy: "auto",
        },
        embeddingModelId: input.embedder || config.embedModel,
        ...(input.rerankModel !== null ? { rerankModel: input.rerankModel } : {}),
      });
      const [row] = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt)))
        .limit(1);
      if (!row) return { status: 500, body: { error: "creation failed" } };
      log.info({ type: "kb-created", kbId: id }, "kb-created");
      return {
        status: 200,
        body: {
          id: row.id,
          tenant_id: row.tenantId,
          name: row.name,
          description: row.description,
          embedder: row.embeddingModelId,
          chunk_size: row.chunkingConfig.chunkSize,
          chunk_overlap: row.chunkingConfig.chunkOverlap,
          ...(row.rerankModel !== null
            ? { rerank_model: row.rerankModel }
            : {}),
          doc_count: 0,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
        },
      };
    },
    async deleteKb(kb) {
      await deleteKnowledgeBase(
        { db, indexWriter },
        { tenantId: kb.tenantId, kbId: kb.id },
      );
    },
  },
  documentIngest: {
    /** JSON 体：url / text(manual) 两型（kb-service AddDocumentInput 契约）。 */
    async createFromJson(kb, body) {
      const parsed = body as {
        type?: unknown;
        title?: unknown;
        content?: unknown;
        url?: unknown;
      };
      const type = parsed.type;
      const title = typeof parsed.title === "string" ? parsed.title : undefined;
      const requestId = `req-${randomUUID().slice(0, 8)}`;
      const common = {
        requestId,
        tenantId: kb.tenantId,
        kbId: kb.id,
        embeddingModelId: "config",
      };
      try {
        if (type === "url") {
          if (typeof parsed.url !== "string" || parsed.url.trim() === "") {
            return { status: 400, body: { error: "url is required" } };
          }
          const result = await createUrlKnowledge(createDeps, {
            ...common,
            url: parsed.url.trim(),
            ...(title !== undefined ? { title } : {}),
          });
          return { status: 202, body: { task_id: result.knowledgeId, doc_id: result.knowledgeId } };
        }
        if (type === "text") {
          if (typeof parsed.content !== "string" || parsed.content.trim() === "") {
            return { status: 400, body: { error: "content is required" } };
          }
          const result = await createTextKnowledge(createDeps, {
            ...common,
            content: parsed.content,
            ...(title !== undefined ? { title } : {}),
          });
          return { status: 202, body: { task_id: result.knowledgeId, doc_id: result.knowledgeId } };
        }
        return { status: 400, body: { error: "type must be url or text" } };
      } catch (error) {
        if (error instanceof DuplicateDocumentError) {
          return { status: 409, body: { error: "duplicate", doc_id: error.existingId } };
        }
        return { status: 500, body: { error: (error as Error).message } };
      }
    },
    /** multipart：file + title（OpenBot uploadDocumentFile 契约）。 */
    async createFromUpload(kb, form) {
      const file = form.get("file");
      const titleField = form.get("title");
      const title =
        typeof titleField === "string" && titleField.trim() !== ""
          ? titleField.trim()
          : undefined;
      if (!(file instanceof File)) {
        return { status: 400, body: { error: "file field is required" } };
      }
      if (file.size > config.maxFileSizeMb * 1024 * 1024) {
        return {
          status: 422,
          body: { error: `file exceeds ${config.maxFileSizeMb}MB limit` },
        };
      }
      const requestId = `req-${randomUUID().slice(0, 8)}`;
      try {
        const result = await createFileKnowledge(createDeps, {
          requestId,
          tenantId: kb.tenantId,
          kbId: kb.id,
          embeddingModelId: config.embedModel,
          fileName: file.name,
          ...(title !== undefined ? { title } : {}),
          fileContent: new Uint8Array(await file.arrayBuffer()),
        });
        return { status: 202, body: { task_id: result.knowledgeId, doc_id: result.knowledgeId } };
      } catch (error) {
        if (error instanceof DuplicateDocumentError) {
          return { status: 409, body: { error: "duplicate", doc_id: error.existingId } };
        }
        return { status: 500, body: { error: (error as Error).message } };
      }
    },
    async deleteDocument(doc) {
      await deleteKnowledge(
        { db, indexWriter },
        { tenantId: doc.tenantId, kbId: doc.kbId, knowledgeId: doc.id },
      );
    },
  },
});

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});

log.info({ type: "kb-mastra-started", port: server.port }, "kb-mastra-started");

// 优雅退出（compose stop → SIGTERM）。
process.on("SIGTERM", () => {
  log.info({ type: "kb-mastra-stopping" }, "kb-mastra-stopping");
  server.stop(true);
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
