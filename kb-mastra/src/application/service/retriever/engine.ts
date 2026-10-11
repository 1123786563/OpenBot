/**
 * 检索引擎抽象：接口（WeKnora types/interfaces/retriever.go 对应物）+
 * composite（引擎级失败=丢弃候选）+ factory/registry（P1 仅注册 qdrant）+
 * keywords no-op（BM25 降级通道，接口/注册/融合分支代码全保留）。
 */

/** 检索类型（P1 实际只用 vector；keywords 是保留接缝）。 */
export type RetrieverType = "vector" | "keywords";

/** 单条检索参数（对齐 WeKnora RetrieveParams 的 P1 面）。 */
export type RetrieveParams = {
  retrieverType: RetrieverType;
  tenantId: string;
  kbIds: string[];
  /** 查询向量（vector 型必填）。 */
  queryVector?: number[];
  /** 查询文本（keywords 型用；P1 不会被调用）。 */
  queryText?: string;
  topK: number;
  /** 应用侧阈值（vector：相似度下限；keywords：BM25 下限）。 */
  scoreThreshold: number;
};

/** 检索命中行（对齐 WeKnora IndexWithScore 的 P1 面 + payload 取回字段）。 */
export type IndexWithScore = {
  chunkId: string;
  score: number;
  docId: string;
  kbId: string;
  content: string;
  contextHeader: string;
  chunkIndex: number;
};

export type RetrieveResult = {
  retrieverType: RetrieverType;
  retrieverEngineType: string;
  results: IndexWithScore[];
  /** 结果级失败（部分命中与失败并存时携带；引擎级失败走 error 抛出）。 */
  error?: Error;
};

/** 检索引擎接口（WeKnora RetrieveEngineService 对应物）。 */
export interface RetrieveEngine {
  /** 引擎标识（日志/registry）。 */
  readonly engineType: string;
  /** 引擎支持的检索类型。 */
  readonly retrieverTypes: readonly RetrieverType[];
  retrieve(params: RetrieveParams): Promise<IndexWithScore[]>;
}
