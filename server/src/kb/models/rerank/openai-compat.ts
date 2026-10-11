/**
 * Reranker 接口 + OpenAI 兼容协议适配。
 * WeKnora models/rerank/{reranker.go,protocol.go} 的对应物：
 * POST {url} {model, query, documents:[...]} → {results:[{index, relevance_score|score, document}]}。
 * document.text 双形态兼容（字符串或对象）；60s 超时。
 */

export type RankResult = {
  index: number;
  relevanceScore: number;
};

export type Reranker = {
  rerank(query: string, documents: string[]): Promise<RankResult[]>;
  getModelName(): string;
  getModelID(): string;
  /** 单文档 rune 上限（0=无文档限制）；rerank 阶段据此 fitPassages。 */
  maxPassageRunes?(query: string): number;
};

export class RerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankError";
  }
}

export type OpenAICompatRerankerOptions = {
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
};

export function createOpenAICompatReranker(
  options: OpenAICompatRerankerOptions,
): Reranker {
  const url = options.url;
  const model = options.model;
  const apiKey = options.apiKey?.trim() ?? "";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const doFetch = options.fetchImpl ?? fetch;

  async function call(
    query: string,
    documents: string[],
  ): Promise<RankResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, query, documents }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new RerankError(
          `rerank responded ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      const body = (await response.json()) as {
        results?: {
          index?: number;
          relevance_score?: number;
          score?: number;
          document?: { text?: string | { text?: string } };
        }[];
      };
      if (!Array.isArray(body.results)) {
        throw new RerankError("rerank response missing results array");
      }
      // relevance_score 优先，score 回退（WeKnora UnmarshalJSON 同款语义）。
      return body.results
        .filter((row) => typeof row.index === "number")
        .map((row) => ({
          index: row.index as number,
          relevanceScore: row.relevance_score ?? row.score ?? 0,
        }));
    } catch (error) {
      if (error instanceof RerankError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RerankError(`rerank timed out after ${timeoutMs}ms`);
      }
      throw new RerankError(
        `rerank is unreachable: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async rerank(query, documents) {
      return call(query, documents);
    },
    getModelName() {
      return model;
    },
    getModelID() {
      return model;
    },
  };
}
