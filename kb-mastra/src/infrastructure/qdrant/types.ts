/**
 * Qdrant REST wire 类型的手写窄面（修订 §2.5 types.ts 职责）。
 *
 * 只声明 kb-mastra 用到的字段——完整契约见 Qdrant 1.19 OpenAPI；这里的多余
 * 字段一概不出现，少一个字段就少一处 wire 偏差（R-Q6）。
 */

export type Distance = "Cosine" | "Euclid" | "Manhattan";

export type HnswConfig = {
  m: number;
  ef_construct: number;
};

export type VectorsConfig = {
  size: number;
  distance: Distance;
};

export type CreateCollectionConfig = {
  vectors: VectorsConfig;
  hnswConfig: HnswConfig;
};

/** GET /collections/{name} 的响应（只取校验需要的 config.params 段）。 */
export type CollectionInfo = {
  result?: {
    config?: {
      params?: {
        vectors?: {
          size?: number;
          distance?: Distance;
        };
      };
    };
    status?: string;
  };
  status?: string;
};

/** filter 条件（kb-mastra 只用 match value/any 两形态）。 */
export type QdrantCondition = {
  key: string;
  match: { value?: string | number | boolean; any?: (string | number)[] };
};

export type QdrantFilter = {
  must: QdrantCondition[];
  must_not?: QdrantCondition[];
};

/** upsert 的 point：id=chunk UUIDv4 直用（A9）。 */
export type PointStruct = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

/** POST /points/query 请求体（kb-mastra 面内字段）。 */
export type QueryPointsBody = {
  query: number[];
  filter: QdrantFilter;
  limit: number;
  with_payload: boolean;
};

export type ScoredPoint = {
  id: string;
  version?: number;
  score: number;
  payload?: Record<string, unknown>;
  vector?: number[];
};

/** POST /points/query 响应：result.points 是命中列表（1.x 统一 query 接口形态）。 */
export type QueryPointsResponse = {
  result?: {
    points?: ScoredPoint[];
  };
  status?: string;
};
