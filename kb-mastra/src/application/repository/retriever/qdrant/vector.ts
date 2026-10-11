/**
 * Qdrant 向量检索引擎：修订 §2.4 的检索实现（v1 §5.3 pgvector 段的替换物）。
 * POST /points/query {query:vector, filter must:[tenant_id, kb_id(any), enabled],
 * limit:expandedTopK clamp(100,200), with_payload:true}。
 * score=cosine similarity（Qdrant Cosine 距离下 score 即相似度，与原
 * score=1-distance 语义一致）；阈值应用侧过滤（A10：不用 score_threshold
 * 参数——融合/rerank 需要完整 score 序列）。
 */
import type {
  IndexWithScore,
  RetrieveEngine,
  RetrieveParams,
} from "../../../service/retriever/engine";
import type { QdrantClient } from "../../../../infrastructure/qdrant/client";

/** expandedTopK = clamp(top_k, 100, 200)（对齐 WeKnora 检索扩展预算）。 */
export function expandedTopK(topK: number): number {
  return Math.min(200, Math.max(100, topK));
}

export type QdrantVectorEngineDeps = {
  client: QdrantClient;
  /** collection 名（kb_chunks_{dim}；A8 单维度单 collection）。 */
  collection: string;
};

export function createQdrantVectorEngine(deps: QdrantVectorEngineDeps): RetrieveEngine {
  return {
    engineType: "qdrant",
    retrieverTypes: ["vector"],

    async retrieve(params: RetrieveParams): Promise<IndexWithScore[]> {
      const vector = params.queryVector;
      if (vector === undefined || vector.length === 0) {
        throw new Error("qdrant vector retrieve requires a query vector");
      }
      const response = await deps.client.queryPoints(deps.collection, {
        query: vector,
        filter: {
          must: [
            // 强制租户隔离——不信任客户端，参数一定来自服务端身份。
            { key: "tenant_id", match: { value: params.tenantId } },
            // 单库=单元素数组；跨库=多元素 any of。
            { key: "kb_id", match: { any: params.kbIds } },
            // 对应 IndexInfo.IsEnabled：禁用 chunk 不参与检索。
            { key: "enabled", match: { value: true } },
          ],
        },
        limit: expandedTopK(params.topK),
        with_payload: true,
      });

      const points = response.result?.points ?? [];
      const hits: IndexWithScore[] = [];
      for (const point of points) {
        // 应用侧阈值过滤（A10）：score >= threshold，完整序列留给融合/rerank。
        if (point.score < params.scoreThreshold) continue;
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        hits.push({
          chunkId: typeof payload.chunk_id === "string" ? payload.chunk_id : String(point.id),
          score: point.score,
          docId: typeof payload.doc_id === "string" ? payload.doc_id : "",
          kbId: typeof payload.kb_id === "string" ? payload.kb_id : "",
          content: typeof payload.content === "string" ? payload.content : "",
          contextHeader: typeof payload.context_header === "string" ? payload.context_header : "",
          chunkIndex: typeof payload.chunk_index === "number" ? payload.chunk_index : 0,
        });
      }
      return hits;
    },
  };
}
