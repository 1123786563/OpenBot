/**
 * Qdrant 索引写入器（修订 §2.3 的 BatchSave 对应物）：PUT points?wait=true，
 * 40 条/批 × 5 并发（对齐 WeKnora BatchSave 40/5），point id=chunk UUID，
 * payload 七键 + content + context_header（修订 §2.2）。
 *
 * wait=true 是状态机的依赖：finalizeIndexedKnowledgeState 前必须读到己之写。
 * 同 id 覆盖 = 天然幂等 UPSERT。
 */

import pLimit from "p-limit";
import { getLogger } from "../../../../../../../shared/logger";
import type { QdrantClient } from "../../../../infrastructure/qdrant/client";
import type { PointStruct } from "../../../../infrastructure/qdrant/types";

const log = getLogger("kb");

/** 一个 point 的全部 payload 字段（修订 §2.2 表格）。 */
export type ChunkPointInput = {
  chunkId: string;
  tenantId: string;
  kbId: string;
  docId: string;
  chunkIndex: number;
  chunkType: string;
  /** P1 恒 "chunk"（A9：语义保留位）。 */
  sourceType: string;
  enabled: boolean;
  content: string;
  contextHeader: string;
  vector: number[];
};

export type IndexWriterOptions = {
  /** 批大小（KB_QDRANT_BATCH，默认 40）。 */
  batchSize?: number;
  /** 批间并发（对齐原 BatchSave 5 并发）。 */
  concurrency?: number;
};

export type UpsertProgress = {
  upserted: number;
  total: number;
};

export type IndexWriter = {
  upsertChunks: (
    inputs: readonly ChunkPointInput[],
    onProgress?: (progress: UpsertProgress) => void,
  ) => Promise<void>;
  /** 清旧索引（修订 A15 铁律：先 Qdrant 后 SQL——本函数只是 Qdrant 半边）。 */
  deleteByDoc: (tenantId: string, docId: string) => Promise<void>;
  /** KB 级联删除（删库时清整个知识库的 points）。 */
  deleteByKb: (tenantId: string, kbId: string) => Promise<void>;
};

export function createIndexWriter(
  client: QdrantClient,
  collection: string,
  options?: IndexWriterOptions,
): IndexWriter {
  const batchSize = options?.batchSize ?? 40;
  const concurrency = options?.concurrency ?? 5;

  async function upsertChunks(
    inputs: readonly ChunkPointInput[],
    onProgress?: (progress: UpsertProgress) => void,
  ): Promise<void> {
    if (inputs.length === 0) return;
    const points: PointStruct[] = inputs.map((input) => ({
      id: input.chunkId,
      vector: input.vector,
      payload: {
        tenant_id: input.tenantId,
        kb_id: input.kbId,
        doc_id: input.docId,
        chunk_id: input.chunkId,
        chunk_index: input.chunkIndex,
        chunk_type: input.chunkType,
        source_type: input.sourceType,
        enabled: input.enabled,
        content: input.content,
        context_header: input.contextHeader,
      },
    }));

    // 40/批 × 5 并发；wait=true 保证读己之写。
    const batches: PointStruct[][] = [];
    for (let i = 0; i < points.length; i += batchSize) {
      batches.push(points.slice(i, i + batchSize));
    }
    const limit = pLimit(concurrency);
    let upserted = 0;
    await Promise.all(
      batches.map((batch) =>
        limit(async () => {
          await client.upsertPoints(collection, batch);
          upserted += batch.length;
          onProgress?.({ upserted, total: points.length });
        }),
      ),
    );
    log.info(
      { type: "kb-index-upserted", collection, count: points.length },
      "kb-index-upserted",
    );
  }

  /** 清旧索引（修订 A15 铁律：先 Qdrant 后 SQL——本函数只是 Qdrant 半边）。 */
  async function deleteByDoc(tenantId: string, docId: string): Promise<void> {
    await client.deletePointsByFilter(collection, {
      must: [
        { key: "doc_id", match: { value: docId } },
        { key: "tenant_id", match: { value: tenantId } },
      ],
    });
    log.info(
      { type: "kb-index-deleted", collection, docId },
      "kb-index-deleted",
    );
  }

  /** KB 级联删除（删库时清整个知识库的 points）。 */
  async function deleteByKb(tenantId: string, kbId: string): Promise<void> {
    await client.deletePointsByFilter(collection, {
      must: [
        { key: "kb_id", match: { value: kbId } },
        { key: "tenant_id", match: { value: tenantId } },
      ],
    });
    log.info(
      { type: "kb-index-deleted-kb", collection, kbId },
      "kb-index-deleted-kb",
    );
  }

  return { upsertChunks, deleteByDoc, deleteByKb };
}
