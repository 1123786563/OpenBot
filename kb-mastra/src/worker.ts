/**
 * worker 进程入口（与 HTTP 同包双进程形态，v1 §3）：只起 BullMQ worker 不起
 * HTTP。启动顺序与 index.ts 相同的自检（迁移幂等 + ensureCollection）。
 *
 * 死信语义（v1 §5.4）：attempts 耗尽的 failed 事件 → parse_status=failed +
 * error_message。重试等待中的 job 对 task 投影不可见的问题由「行状态本身就是
 * processing/pending」覆盖（投影源是 DB 行不是 job 状态）。
 */

import { eq } from "drizzle-orm";
import { Worker } from "bullmq";
import { getLogger } from "../../shared/logger";
import { loadConfig } from "./config";
import { getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { createDocReaderClient } from "./docreader/client";
import { createParserRegistry } from "./infrastructure/docparser/registry";
import { ensureCollection } from "./infrastructure/qdrant/collections";
import { QdrantClient } from "./infrastructure/qdrant/client";
import { collectionName } from "./infrastructure/qdrant/collections";
import { createIndexWriter } from "./application/repository/retriever/qdrant/index-writer";
import { createBatchEmbedder } from "./models/embedding/batch";
import { withConcurrency } from "./models/embedding/concurrency";
import { createOllamaEmbedder } from "./models/embedding/ollama";
import { knowledges } from "./db/schema";
import { processDocument } from "./tasks/document-process";
import { JOB_DOCUMENT_PROCESS, QUEUE_NAME } from "./tasks/queue";

const log = getLogger("kb-mastra");

const config = loadConfig();

/** 组装管线的全部依赖（HTTP 侧 reparse 将来也走这里）。 */
export async function buildPipeline() {
  // 自检（幂等）。
  await runMigrations();
  const qdrantClient = new QdrantClient({
    baseUrl: config.qdrantUrl,
    ...(config.qdrantApiKey !== "" ? { apiKey: config.qdrantApiKey } : {}),
  });
  await ensureCollection(qdrantClient, config.embedDimensions);

  const db = getDb();
  const docReader = await createDocReaderClient({
    address: config.docreaderAddr,
    callTimeoutMs: config.docreaderCallTimeoutMs,
  });
  const registry = createParserRegistry(docReader);
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
  const indexWriter = createIndexWriter(
    qdrantClient,
    collectionName(config.embedDimensions),
    { batchSize: config.qdrantBatch },
  );
  return { db, registry, embedder, indexWriter };
}

const pipeline = await buildPipeline();

const connection = { url: config.redisUrl };

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name !== JOB_DOCUMENT_PROCESS) return;
    await processDocument(
      {
        db: pipeline.db,
        registry: pipeline.registry,
        embedder: pipeline.embedder,
        indexWriter: pipeline.indexWriter,
        onProgress: async (progress) => {
          // BullMQ job 进度 + knowledges.progress jsonb 双写（投影源是后者）。
          await job.updateProgress({
            chunksDone: progress.chunksDone,
            chunksTotal: progress.chunksTotal,
          });
          await pipeline.db
            .update(knowledges)
            .set({
              progress: {
                chunksTotal: progress.chunksTotal,
                chunksDone: progress.chunksDone,
                stage: progress.stage,
                updatedAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(eq(knowledges.id, job.data.knowledgeId));
        },
      },
      job.data,
    );
  },
  { connection, concurrency: 4 },
);

// 死信：attempts 耗尽 → failed 终态（v1 §5.4 对应 task_dead_letters）。
worker.on("failed", async (job, error) => {
  if (!job || job.name !== JOB_DOCUMENT_PROCESS) return;
  // attemptsMade === opts.attempts 才是耗尽（中间失败有重试）。
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await pipeline.db
    .update(knowledges)
    .set({
      parseStatus: "failed",
      errorMessage: error.message.slice(0, 2000),
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(knowledges.id, job.data.knowledgeId));
  log.error(
    {
      type: "kb-ingest-dead-letter",
      knowledgeId: job.data.knowledgeId,
      error: error.name,
    },
    "kb-ingest-dead-letter",
  );
});

log.info(
  { type: "kb-worker-started", queue: QUEUE_NAME },
  "kb-worker-started",
);

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});
