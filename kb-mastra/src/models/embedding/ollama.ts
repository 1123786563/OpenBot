/**
 * Ollama / OpenAI 兼容 Embedder（WeKnora models/embedding/ollama.go 的 TS 对应物）。
 * transport 承载协议细节，本文件只做 Embedder 接口适配与维度声明。
 */
import type { Embedder } from "./embedder";
import { type EmbedTransport, createEmbedTransport } from "./transport";

export type OllamaEmbedderOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 声明维度（KB_EMBED_DIMENSIONS）；0 = 以首次实测为准。 */
  dimensions?: number;
  protocol?: "ollama" | "openai";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const transport: EmbedTransport = createEmbedTransport({
    baseUrl: options.baseUrl,
    model: options.model,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  let observedDimensions = options.dimensions ?? 0;

  return {
    async embed(text) {
      const vector = await transport.embed(text);
      if (observedDimensions === 0 && vector.length > 0) observedDimensions = vector.length;
      return vector;
    },
    async batchEmbed(texts) {
      const vectors = await transport.embedBatch(texts);
      if (observedDimensions === 0 && vectors.length > 0 && (vectors[0]?.length ?? 0) > 0) {
        observedDimensions = vectors[0].length;
      }
      return vectors;
    },
    getModelName() {
      return options.model;
    },
    getDimensions() {
      return observedDimensions;
    },
    getModelID() {
      return options.model;
    },
  };
}
