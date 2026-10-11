/**
 * ensureCollection 启动自检（修订 R2/R-Q1/R-Q2/R-Q3）：存在性 + 维度 + distance
 * 校验 + payload 索引幂等声明。collection 命名 `kb_chunks_{dim}`（A8：按维度
 * 单 collection；tenant/kb 隔离靠 payload filter）。
 *
 * 三分支语义：
 *   404 → 建 collection（Cosine + hnsw m16/ef_construct 64）+ 立即声明 8 个
 *         payload 索引（建 collection 后、首次写入前——R-Q2）；
 *   200 → 校验 size/distance；不匹配 fail fast（collection 维度不可变，R-Q1）；
 *   其它 → 抛错（启动失败，503 语义）。
 *
 * 索引声明幂等：已存在时 Qdrant 报错，按「已存在」吞掉（修订 §2.2）。
 */

import { getLogger } from "../../../../shared/logger";
import { type QdrantClient, QdrantError } from "./client";
import type { Distance } from "./types";

const log = getLogger("kb-mastra");

/** WeKnora HNSW 参数照抄（v1 §4 手写 SQL 的 m=16/ef_construction=64）。 */
export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCT = 64;

/** collection 命名（A8）：kb_chunks_{dim}。 */
export function collectionName(dimension: number): string {
  return `kb_chunks_${dimension}`;
}

/** 8 个 payload 索引：7 keyword + 1 integer（修订 §2.2 表格）。 */
const PAYLOAD_INDEXES: readonly {
  field: string;
  schema: "keyword" | "integer";
}[] = [
  { field: "tenant_id", schema: "keyword" },
  { field: "kb_id", schema: "keyword" },
  { field: "doc_id", schema: "keyword" },
  { field: "chunk_id", schema: "keyword" },
  { field: "chunk_type", schema: "keyword" },
  { field: "source_type", schema: "keyword" },
  { field: "enabled", schema: "keyword" },
  { field: "chunk_index", schema: "integer" },
];

/** dimension/distance 不匹配的 fail-fast 错误（R-Q1）。 */
export class CollectionMismatchError extends Error {
  constructor(
    dimension: number,
    actual: { size?: number; distance?: Distance },
  ) {
    super(
      `Qdrant collection ${collectionName(dimension)} exists with ` +
        `size=${actual.size ?? "?"} distance=${actual.distance ?? "?"}, ` +
        `but KB_EMBED_DIMENSIONS=${dimension} expects size=${dimension} distance=Cosine. ` +
        `A collection's dimension is immutable: point KB_EMBED_DIMENSIONS back at the ` +
        `existing collection's dimension, or use a new dimension (which requires a ` +
        `fresh collection and re-embedding everything).`,
    );
    this.name = "CollectionMismatchError";
  }
}

/** 幂等声明一个 payload 索引；「已存在」错误吞掉。 */
async function ensurePayloadIndex(
  client: QdrantClient,
  collection: string,
  field: string,
  schema: "keyword" | "integer",
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, field, schema);
  } catch (error) {
    // Qdrant 对重复建索引返回 409 或带 "already exists" 的 400——按已存在吞。
    const message = (error as Error).message;
    if (
      error instanceof QdrantError &&
      (error.status === 409 ||
        (error.status === 400 && message.includes("already exists")))
    ) {
      return;
    }
    throw error;
  }
}

export type EnsureCollectionResult = {
  collection: string;
  /** 本次是否新建（false = 已存在且校验通过）。 */
  created: boolean;
};

/**
 * 启动自检入口。幂等：重复调用对已存在且匹配的 collection 是 no-op。
 */
export async function ensureCollection(
  client: QdrantClient,
  dimension: number,
): Promise<EnsureCollectionResult> {
  const name = collectionName(dimension);

  const existing = await client.getCollection(name);
  if (existing) {
    const vectors = existing.result?.config?.params?.vectors;
    const size = vectors?.size;
    const distance = vectors?.distance;
    if (size !== dimension || distance !== "Cosine") {
      // fail fast（R-Q1/R-Q3）：维度或 distance 不匹配即拒绝启动。
      throw new CollectionMismatchError(dimension, { size, distance });
    }
    // 已存在且匹配：补声明索引（上次启动中断时的兜底，幂等）。
    for (const { field, schema } of PAYLOAD_INDEXES) {
      await ensurePayloadIndex(client, name, field, schema);
    }
    log.info(
      { type: "kb-qdrant-collection-ok", collection: name, dimension },
      "kb-qdrant-collection-ok",
    );
    return { collection: name, created: false };
  }

  // 404 → 建 collection。
  await client.createCollection(name, {
    vectors: { size: dimension, distance: "Cosine" },
    hnswConfig: { m: HNSW_M, ef_construct: HNSW_EF_CONSTRUCT },
  });
  // 立即声明全部 payload 索引：建 collection 后、首次写入前（R-Q2）。
  for (const { field, schema } of PAYLOAD_INDEXES) {
    await ensurePayloadIndex(client, name, field, schema);
  }
  log.info(
    { type: "kb-qdrant-collection-created", collection: name, dimension },
    "kb-qdrant-collection-created",
  );
  return { collection: name, created: true };
}
