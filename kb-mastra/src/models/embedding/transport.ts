/**
 * Ollama / OpenAI 兼容 embedding 客户端。
 *
 * WeKnora 用 ollama/ollama/api 的官方 Go 客户端（POST /api/embed）；TS 侧按
 * 同一 HTTP 契约裸 fetch（与 qdrant client 的薄客户端先例一致）。OpenAI
 * 兼容 /v1/embeddings 是同一文件内的可选开关——OpenBot 部署常以 Ollama 的
 * OpenAI 兼容层或其它网关承载嵌入，两种形态按 base URL 一次探测后固定。
 */

export type EmbedTransportOptions = {
  baseUrl: string;
  model: string;
  /** OpenAI 兼容端点的鉴权 key（Ollama 原生无需）。 */
  apiKey?: string;
  /** 强制协议；默认探测：先 Ollama /api/embed，404 再 /v1/embeddings。 */
  protocol?: "ollama" | "openai";
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
};

export class EmbedTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedTransportError";
  }
}

type ResolvedProtocol = "ollama" | "openai";

/** 协议探测结果缓存（进程内；同一 base URL 反复探测无意义）。 */
const protocolCache = new Map<string, ResolvedProtocol>();

export type EmbedTransport = {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  protocol(): ResolvedProtocol;
};

export function createEmbedTransport(
  options: EmbedTransportOptions,
): EmbedTransport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const model = options.model;
  const apiKey = options.apiKey?.trim() ?? "";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const doFetch = options.fetchImpl ?? fetch;

  const resolved: ResolvedProtocol | undefined =
    options.protocol ?? protocolCache.get(base);

  async function post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new EmbedTransportError(
          `embed ${path} responded ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof EmbedTransportError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new EmbedTransportError(
          `embed ${path} timed out after ${timeoutMs}ms`,
        );
      }
      throw new EmbedTransportError(
        `embed ${path} is unreachable: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function vecOfOllama(body: unknown): number[] {
    const embedding =
      (body as { embeddings?: number[][]; embedding?: number[] })
        .embeddings?.[0] ?? (body as { embedding?: number[] }).embedding;
    if (!Array.isArray(embedding))
      throw new EmbedTransportError("ollama embed response missing embedding");
    return embedding;
  }

  function vecsOfOllama(body: unknown): number[][] {
    // /api/embed 批量：{embeddings: [[...],[...]]}
    const embeddings = (body as { embeddings?: number[][] }).embeddings;
    if (Array.isArray(embeddings)) return embeddings;
    return [vecOfOllama(body)];
  }

  function vecsOfOpenAI(body: unknown): number[][] {
    const data = (body as { data?: { index?: number; embedding?: number[] }[] })
      .data;
    if (!Array.isArray(data))
      throw new EmbedTransportError("openai embeddings response missing data");
    // 按 index 复原顺序（规范要求有序，防御性排序）。index 取响应字段而非数组
    // 位置——乱序响应时两者不同；缺 index 的行按出现位置兜底。
    const rows = data.map((row, position) => ({
      index: typeof row.index === "number" ? row.index : position,
      embedding: row.embedding ?? [],
    }));
    rows.sort((a, b) => a.index - b.index);
    return rows.map((r) => r.embedding);
  }

  async function callOnce(
    texts: string[],
    proto: ResolvedProtocol,
  ): Promise<number[][]> {
    if (proto === "ollama") {
      // Ollama /api/embed：单条 prompt 或批量 input。
      const body =
        texts.length === 1
          ? { model, prompt: texts[0] }
          : { model, input: texts };
      return vecsOfOllama(await post("/api/embed", body));
    }
    return vecsOfOpenAI(await post("/v1/embeddings", { model, input: texts }));
  }

  async function resolveProtocol(): Promise<ResolvedProtocol> {
    if (resolved !== undefined) return resolved;
    // 探测：Ollama 原生优先（P1 主形态），404/400 视为非 Ollama → OpenAI 兼容。
    try {
      const out = await callOnce(["probe"], "ollama");
      if (out.length === 1 && out[0].length > 0) {
        protocolCache.set(base, "ollama");
        return "ollama";
      }
    } catch {
      // fall through to openai
    }
    try {
      const out = await callOnce(["probe"], "openai");
      if (out.length === 1 && out[0].length > 0) {
        protocolCache.set(base, "openai");
        return "openai";
      }
    } catch (error) {
      throw new EmbedTransportError(
        `cannot reach embedding endpoint at ${base}: ${(error as Error).message}`,
      );
    }
    throw new EmbedTransportError(
      `embedding endpoint at ${base} returned no vector`,
    );
  }

  return {
    async embed(text) {
      const proto = await resolveProtocol();
      const out = await callOnce([text], proto);
      return out[0] ?? [];
    },
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      const proto = await resolveProtocol();
      return callOnce(texts, proto);
    },
    protocol() {
      return resolved ?? "ollama";
    },
  };
}
