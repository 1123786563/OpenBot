/**
 * 摄取管线 worker 主流程（WeKnora ProcessDocument 的 TS 直译，v1 §5.2 +
 * 修订 §2.2/§2.3）：幂等守卫 → resolveProcessConfig → convert → sanitize →
 * buildSourceIndex → 切分 → processChunks（先 Qdrant 后 SQL 清旧 → 建 chunks
 * → 嵌入 → Qdrant upsert）→ 终态回写。
 *
 * 依赖全部注入（DocParser registry / Embedder / index-writer / db），测试与
 * 冒烟可换 mock。步骤间无隐藏状态——每步的输入输出都是显式参数。
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getLogger } from "../../../../shared/logger";
import type {
  ChunkPointInput,
  IndexWriter,
} from "../application/repository/retriever/qdrant/index-writer";
import type { Db } from "../db/client";
import type { SourceLocator } from "../db/schema";
import {
  chunkRevisions,
  chunks,
  knowledgeBases,
  knowledges,
} from "../db/schema";
import type { SplitterConfig } from "../infrastructure/chunker/splitter";
import { split } from "../infrastructure/chunker/strategy";
import type { ParserRegistry } from "../infrastructure/docparser/registry";
import {
  cleanInvalidUTF8,
  normalizeLineEndings,
  type SourceBlock,
  sanitizeForEmbedding,
} from "../infrastructure/sanitize";
import type { Embedder } from "../models/embedding/embedder";
import type { DocumentProcessPayload } from "./queue";

const log = getLogger("kb");

export type ProcessDeps = {
  db: Db;
  registry: ParserRegistry;
  embedder: Embedder;
  indexWriter: IndexWriter;
  /**
   * 本次是否为最后一次尝试（BullMQ attemptsMade+1 >= attempts）。非最终次
   * 失败不落 error_message——重试链上每次失败都会走到这里，只有最后一次
   * 的错误才是终态语义，中途覆盖会掩掉真正的首次原因。
   */
  isFinalAttempt?: boolean;
  /** 进度回调（BullMQ job.updateProgress + knowledges.progress 回写的桥）。 */
  onProgress?: (progress: {
    chunksDone: number;
    chunksTotal: number;
    stage: string;
  }) => Promise<void>;
};

/** 守卫结论：跳过原因枚举（对齐 WeKnora 幂等守卫分支）。 */
type GuardDecision =
  | { kind: "proceed"; row: typeof knowledges.$inferSelect }
  | {
      kind: "skip";
      reason:
        | "missing"
        | "deleting"
        | "cancelled"
        | "completed"
        | "attemptSuperseded";
    };

/** 幂等守卫：行不在/已软删/终态/世代号落后 → 跳过（ack 不重试）。 */
async function guard(
  db: Db,
  payload: DocumentProcessPayload,
): Promise<GuardDecision> {
  const [row] = await db
    .select()
    .from(knowledges)
    .where(eq(knowledges.id, payload.knowledgeId))
    .limit(1);
  if (!row) return { kind: "skip", reason: "missing" };
  if (row.deletedAt) return { kind: "skip", reason: "deleting" };
  if (row.parseStatus === "deleting" || row.parseStatus === "cancelled")
    return { kind: "skip", reason: row.parseStatus };
  if (row.parseStatus === "completed")
    return { kind: "skip", reason: "completed" };
  // 世代号：reparse 递增了行上的 attempt，本 job 携带旧值 → 已被取代。
  if (row.attempt !== payload.attempt)
    return { kind: "skip", reason: "attemptSuperseded" };
  return { kind: "proceed", row };
}

/** KB 的 chunking_config + 全局默认合并（WeKnora resolveProcessConfig）。 */
async function resolveProcessConfig(
  db: Db,
  kbId: string,
): Promise<SplitterConfig> {
  const [kb] = await db
    .select({ chunkingConfig: knowledgeBases.chunkingConfig })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, kbId))
    .limit(1);
  const config = kb?.chunkingConfig;
  return {
    chunkSize: config?.chunkSize ?? 512,
    chunkOverlap: config?.chunkOverlap ?? 80,
    separators: config?.separators ?? ["\n\n", "\n", "。"],
    strategy: config?.strategy ?? "auto",
    tokenLimit: 0,
    languages: [],
  };
}

/** buildSourceIndex：SourceBlock rune 偏移 → 每个 chunk 的 source_locators。 */
function locatorsForChunk(
  blocks: readonly SourceBlock[],
  start: number,
  end: number,
): SourceLocator[] {
  const locators: SourceLocator[] = [];
  for (const block of blocks) {
    // 块与 chunk 有交集（block.end 是 exclusive）。
    if (block.end <= start || block.start >= end) continue;
    try {
      const parsed = JSON.parse(block.locatorJson) as SourceLocator;
      if (parsed.type) locators.push(parsed);
    } catch {
      // locatorJson 非法：跳过该块（定位是增强信息，不是管线依赖）。
    }
  }
  return locators;
}

/** 文档失败终态（error_message 落行）。 */
async function markFailed(
  db: Db,
  knowledgeId: string,
  message: string,
): Promise<void> {
  await db
    .update(knowledges)
    .set({
      parseStatus: "failed",
      errorMessage: message.slice(0, 2000),
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(knowledges.id, knowledgeId));
}

/** 诊断：当前阶段写 progress.stage（task 投影可见，失败定位不用翻日志）。 */
async function markStage(
  db: Db,
  knowledgeId: string,
  stage: string,
): Promise<void> {
  await db
    .update(knowledges)
    .set({
      progress: {
        chunksTotal: 0,
        chunksDone: 0,
        stage,
        updatedAt: new Date().toISOString(),
      },
    })
    .where(eq(knowledges.id, knowledgeId));
}

/** markdown 清洗：UTF-8 净化 + 行尾归一（WeKnora sanitize 步骤）。 */
function cleanMarkdown(markdown: string): string {
  return normalizeLineEndings(cleanInvalidUTF8(markdown));
}

/**
 * 处理一条摄取 job。抛错 = BullMQ 重试语义；返回值仅供日志。
 * 守卫跳过不抛（ack）。
 */
export async function processDocument(
  deps: ProcessDeps,
  payload: DocumentProcessPayload,
): Promise<{ skipped?: string }> {
  const { db, registry, embedder, indexWriter } = deps;
  const isFinal = deps.isFinalAttempt ?? true;
  /** 终次失败才落 error_message（中途失败留给重试，避免覆盖首次原因）。 */
  const markFailedIfFinal = async (message: string): Promise<void> => {
    if (isFinal) await markFailed(db, payload.knowledgeId, message);
  };

  const decision = await guard(db, payload);
  if (decision.kind === "skip") {
    log.info(
      {
        type: "kb-ingest-skipped",
        reason: decision.reason,
        knowledgeId: payload.knowledgeId,
      },
      "kb-ingest-skipped",
    );
    return { skipped: decision.reason };
  }

  // processing 标记（幂等：重跑也从这里重新置 processing）。
  await db
    .update(knowledges)
    .set({ parseStatus: "processing", errorMessage: "", updatedAt: new Date() })
    .where(eq(knowledges.id, payload.knowledgeId));

  // ---- convert（三入口分发；全空 = 空文档直通 0 chunk）----
  let markdown: string;
  let sourceBlocks: SourceBlock[];
  const isEmptyDocument =
    payload.passages === "" && payload.url === "" && payload.filePath === "";
  try {
    if (isEmptyDocument) {
      markdown = "";
      sourceBlocks = [];
    } else if (payload.passages !== "") {
      // text/manual 入口：直传内容即 markdown，无 SourceBlock。
      markdown = payload.passages;
      sourceBlocks = [];
    } else if (payload.url !== "" && payload.filePath === "") {
      const parser = registry.forExtension(payload.fileType || "html");
      const result = await parser.parseURL(
        payload.url,
        payload.fileName || undefined,
      );
      if (result.error) throw new Error(result.error);
      markdown = result.markdownContent;
      sourceBlocks = result.sourceBlocks;
    } else {
      const fileContent = new Uint8Array(await readFile(payload.filePath));
      const parser = registry.forExtension(payload.fileType);
      const result = await parser.parseFile({
        fileContent,
        fileName: payload.fileName,
        fileType: payload.fileType,
      });
      if (result.error) throw new Error(result.error);
      markdown = result.markdownContent;
      sourceBlocks = result.sourceBlocks;
    }
  } catch (error) {
    // 解析失败：置 failed 并抛出——BullMQ attempts 内重试（docreader 抖动自愈）。
    await markFailedIfFinal((error as Error).message);
    throw error;
  }

  // ---- sanitize ----
  markdown = cleanMarkdown(markdown);
  sourceBlocks = sourceBlocks.filter((block) => block.end > block.start);

  // ---- 切分（策略感知；父子索引是 P1.5 接缝，v1 §5.2）----
  const config = await resolveProcessConfig(db, payload.kbId);
  const chunksOut = split(markdown, config);
  if (chunksOut.length === 0) {
    // 空文档：清残留索引后直接终态 completed（0 chunk）。
    await indexWriter.deleteByDoc(payload.tenantId, payload.knowledgeId);
    await db.delete(chunks).where(eq(chunks.knowledgeId, payload.knowledgeId));
    await db
      .update(knowledges)
      .set({
        parseStatus: "completed",
        processedAt: new Date(),
        updatedAt: new Date(),
        progress: {
          chunksTotal: 0,
          chunksDone: 0,
          stage: "done",
          updatedAt: new Date().toISOString(),
        },
      })
      .where(eq(knowledges.id, payload.knowledgeId));
    return {};
  }

  // ---- finalizing（内部 7 态）----
  await db
    .update(knowledges)
    .set({ parseStatus: "finalizing", updatedAt: new Date() })
    .where(eq(knowledges.id, payload.knowledgeId));

  // ---- processChunks ----
  // ① 清旧（修订 A15 铁律：先 Qdrant 后 SQL；幂等——重跑不翻倍的前提）。
  await markStage(db, payload.knowledgeId, "index-cleanup");
  await indexWriter.deleteByDoc(payload.tenantId, payload.knowledgeId);
  await db.delete(chunks).where(eq(chunks.knowledgeId, payload.knowledgeId));

  // ② 建 chunks 行 + chunk_revisions 首版。
  const rows = chunksOut.map((chunk, index) => ({
    id: randomUUID(),
    tenantId: payload.tenantId,
    knowledgeId: payload.knowledgeId,
    knowledgeBaseId: payload.kbId,
    content: chunk.content,
    sourceContent: chunk.content,
    contentRevision: 0,
    chunkIndex: index,
    startAt: chunk.start,
    endAt: chunk.end,
    preChunkId: "",
    nextChunkId: "",
    chunkType: "text" as const,
    contextHeader: chunk.contextHeader,
    sourceLocators: locatorsForChunk(sourceBlocks, chunk.start, chunk.end),
    contentHash: createHash("sha256").update(chunk.content).digest("hex"),
  }));
  // pre/next 链表（相邻一跳扩展依赖）。
  for (const [i, row] of rows.entries()) {
    if (i > 0) row.preChunkId = rows[i - 1]?.id;
    if (i < rows.length - 1) row.nextChunkId = rows[i + 1]?.id;
  }
  await db.insert(chunks).values(rows);
  await db.insert(chunkRevisions).values(
    rows.map((row) => ({
      id: randomUUID(),
      tenantId: row.tenantId,
      knowledgeBaseId: row.knowledgeBaseId,
      knowledgeId: row.knowledgeId,
      chunkId: row.id,
      revision: 0,
      content: row.content,
      isEnabled: true,
      editorId: "ingest",
      editSource: "ingest",
    })),
  );

  // ③ 嵌入（sanitizeForEmbedding：剥 base64/截 20000 字符；标题+面包屑前置）。
  await markStage(db, payload.knowledgeId, "embed");
  const embedInputs = rows.map((row) =>
    sanitizeForEmbedding(
      row.contextHeader !== ""
        ? `${row.contextHeader}\n\n${row.content.trim()}`
        : row.content.trim(),
    ),
  );
  let vectors: number[][];
  try {
    vectors = await embedder.batchEmbed(embedInputs);
  } catch (error) {
    await markFailedIfFinal(`embedding failed: ${(error as Error).message}`);
    throw error;
  }
  if (vectors.length !== rows.length) {
    const message = `embedder returned ${vectors.length} vectors for ${rows.length} chunks`;
    await markFailedIfFinal(message);
    throw new Error(message);
  }

  // ④ Qdrant upsert（40/批 × 5 并发，wait=true）+ 节流进度回写。
  const points: ChunkPointInput[] = rows.map((row, i) => {
    const vector = vectors[i];
    if (vector === undefined) {
      // Unreachable: the length invariant above throws before this map runs.
      throw new Error(`embedder returned no vector for chunk ${i}`);
    }
    return {
      chunkId: row.id,
      tenantId: row.tenantId,
      kbId: row.knowledgeBaseId,
      docId: row.knowledgeId,
      chunkIndex: row.chunkIndex,
      chunkType: row.chunkType,
      sourceType: "chunk" as const,
      enabled: true,
      content: row.content,
      contextHeader: row.contextHeader,
      vector,
    };
  });
  let lastProgressAt = 0;
  try {
    await indexWriter.upsertChunks(points, (progress) => {
      const now = Date.now();
      // 节流：200ms 一条，完成那条必发。
      if (now - lastProgressAt < 200 && progress.upserted < progress.total)
        return;
      lastProgressAt = now;
      void deps.onProgress?.({
        chunksDone: progress.upserted,
        chunksTotal: progress.total,
        stage: "index",
      });
    });
    await deps.onProgress?.({
      chunksDone: points.length,
      chunksTotal: points.length,
      stage: "done",
    });
  } catch (error) {
    await markFailedIfFinal(`index upsert failed: ${(error as Error).message}`);
    throw error;
  }

  // ⑤ 终态 completed + progress 落行。
  await db
    .update(knowledges)
    .set({
      parseStatus: "completed",
      processedAt: new Date(),
      updatedAt: new Date(),
      progress: {
        chunksTotal: rows.length,
        chunksDone: rows.length,
        stage: "done",
        updatedAt: new Date().toISOString(),
      },
    })
    .where(eq(knowledges.id, payload.knowledgeId));
  log.info(
    {
      type: "kb-ingest-completed",
      knowledgeId: payload.knowledgeId,
      chunks: rows.length,
    },
    "kb-ingest-completed",
  );
  return {};
}
