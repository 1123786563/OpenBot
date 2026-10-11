/**
 * Qdrant REST 客户端的窄类型层（修订 A12：裸 fetch，不用官方 SDK）。
 *
 * kb-mastra 只用 6 个端点（GET/PUT collection、PUT points、POST points/query、
 * POST points/delete、PUT index），REST 契约 1.x 稳定。超时+错误分类三行搞定，
 * 与 OpenBot 代理层 client.ts 的「薄 fetch 客户端」先例一致。接口隔离在本
 * 目录内，若换 @qdrant/js-client-rest 不动 service 层。
 */

import type {
  CollectionInfo,
  CreateCollectionConfig,
  PointStruct,
  QdrantFilter,
  QueryPointsBody,
  QueryPointsResponse,
} from "./types";

/** 所有非 2xx 折成的统一错误：status 供调用方判定重试/熔断语义。 */
export class QdrantError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QdrantError";
    this.status = status;
  }
}

/** Qdrant 客户端构造项。 */
export type QdrantClientOptions = {
  baseUrl: string;
  apiKey?: string;
  /** 单请求超时（毫秒）；默认 30s（ensureCollection 建索引可能较慢）。 */
  timeoutMs?: number;
  /** 测试注入 fetch。 */
  fetchImpl?: typeof fetch;
};

export class QdrantClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QdrantClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 发请求并解析 JSON；非 2xx 折 QdrantError（message 带 body 摘要）。 */
  private async request<T>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        ...(body !== undefined
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
        ...(this.apiKey !== "" ? { headers: { "api-key": this.apiKey } } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new QdrantError(
          response.status,
          `Qdrant ${method} ${path} responded ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      // 200 with empty body (PUT collection) → 返回空对象。
      const text = await response.text();
      return (text === "" ? {} : JSON.parse(text)) as T;
    } catch (error) {
      if (error instanceof QdrantError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new QdrantError(
          504,
          `Qdrant ${method} ${path} timed out after ${timeoutMs ?? this.timeoutMs}ms.`,
        );
      }
      // 网络错误（连接拒绝/DNS）：折 503 语义，调用方按不可达处理。
      throw new QdrantError(
        503,
        `Qdrant ${method} ${path} is unreachable: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- collection ----

  /** GET /collections/{name}：404 折 null（ensureCollection 的存在性分支）。 */
  async getCollection(name: string): Promise<CollectionInfo | null> {
    try {
      return await this.request<CollectionInfo>(
        "GET",
        `/collections/${encodeURIComponent(name)}`,
      );
    } catch (error) {
      if (error instanceof QdrantError && error.status === 404) return null;
      throw error;
    }
  }

  async createCollection(
    name: string,
    config: CreateCollectionConfig,
  ): Promise<void> {
    await this.request("PUT", `/collections/${encodeURIComponent(name)}`, {
      vectors: config.vectors,
      hnsw_config: config.hnswConfig,
    });
  }

  // ---- payload 索引 ----

  /** PUT /collections/{c}/index：幂等声明（已存在的报错由调用方吞）。 */
  async createPayloadIndex(
    collection: string,
    fieldName: string,
    schema: "keyword" | "integer" | "float" | "bool" | "text" | "geo",
  ): Promise<void> {
    await this.request(
      "PUT",
      `/collections/${encodeURIComponent(collection)}/index`,
      // 1.19 契约：创建用 field_schema（schema 仅出现在 GET 响应里，
      // PUT 带 schema 会报 "Can't auto-detect field type"）。
      { field_name: fieldName, field_schema: schema },
    );
  }

  // ---- points ----

  /** PUT /points?wait=true：批量 upsert（同 id 覆盖 = 幂等 UPSERT）。 */
  async upsertPoints(collection: string, points: PointStruct[]): Promise<void> {
    await this.request(
      "PUT",
      `/collections/${encodeURIComponent(collection)}/points?wait=true`,
      { points },
    );
  }

  /** POST /points/query：统一 query 接口（1.10+）。 */
  async queryPoints(
    collection: string,
    body: QueryPointsBody,
  ): Promise<QueryPointsResponse> {
    return this.request<QueryPointsResponse>(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/query`,
      body,
    );
  }

  /** POST /points/delete?wait=true：按 filter 删除（级联/清旧索引）。 */
  async deletePointsByFilter(
    collection: string,
    filter: QdrantFilter,
  ): Promise<void> {
    await this.request(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
      { filter },
    );
  }

  /** POST /points/count：精确计数（对账/级联验证）。响应是 {result:{count}}。 */
  async countPoints(
    collection: string,
    filter?: QdrantFilter,
  ): Promise<number> {
    const response = await this.request<{ result?: { count?: number } }>(
      "POST",
      `/collections/${encodeURIComponent(collection)}/points/count`,
      { exact: true, ...(filter ? { filter } : {}) },
    );
    return response.result?.count ?? 0;
  }
}
