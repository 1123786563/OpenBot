/**
 * Embedder 接口（WeKnora models/embedding/embedder.go 对应物）。
 * P1 两个实现形态：Ollama 原生（/api/embed）与 OpenAI 兼容（/v1/embeddings），
 * 同文件内开关（ollama.ts）。批量与并发由 batch.ts/concurrency.ts 包装。
 */

export type Embedder = {
  /** 单条文本 → 向量。 */
  embed(text: string): Promise<number[]>;
  /** 批量文本 → 向量数组（顺序保持）。 */
  batchEmbed(texts: string[]): Promise<number[][]>;
  /** 模型名（KB 行 embedding_model_id 存储值）。 */
  getModelName(): string;
  /** 向量维度（Qdrant collection size 基准；0=未知，以首次调用实测为准）。 */
  getDimensions(): number;
  /** 模型 ID（多供应商目录用；P1 = modelName）。 */
  getModelID(): string;
};
