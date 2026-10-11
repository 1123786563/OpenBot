/**
 * 批量嵌入：BATCH_EMBED_SIZE（默认 5）分批 + 失败快停。
 * WeKnora models/embedding/batch.go 的 batchEmbedder.BatchEmbedWithPool 对应物——
 * 首错即停（后续批不再发出），已完成的批丢弃，整批调用抛错交由 BullMQ 重试。
 */
import type { Embedder } from "./embedder";

export const DEFAULT_BATCH_EMBED_SIZE = 5;

export type BatchOptions = {
  /** 每批条数；≤0 回退默认 5。 */
  batchSize?: number;
};

export function createBatchEmbedder(inner: Embedder, options: BatchOptions = {}): Embedder {
  const batchSize =
    options.batchSize !== undefined && options.batchSize > 0
      ? options.batchSize
      : DEFAULT_BATCH_EMBED_SIZE;

  return {
    async embed(text) {
      return inner.embed(text);
    },
    async batchEmbed(texts) {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        // 快停语义：某批失败即抛，不再发后续批（对齐 WeKnora firstErr 检查）。
        const vectors = await inner.batchEmbed(batch);
        if (vectors.length !== batch.length) {
          throw new Error(
            `batchEmbed: expected ${batch.length} vectors, got ${vectors.length}`,
          );
        }
        out.push(...vectors);
      }
      return out;
    },
    getModelName() {
      return inner.getModelName();
    },
    getDimensions() {
      return inner.getDimensions();
    },
    getModelID() {
      return inner.getModelID();
    },
  };
}
