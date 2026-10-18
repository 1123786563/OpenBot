// MT037（Issue #80）共享夹具：检索候选/重排/引用面的归属限制。
//
// 契约：主库（企业测试库，MT008 support 全套受限通道）+ KB 专用测试库
// （KB_TEST_DATABASE_URL，专用受限登录属主通道跑 drizzle-kb 迁移）。缺任一
// 显式 env 由调用方整套显式 skip，绝不回退开发库、skipped 不计通过。
//
// 组成（只读消费既有交付，零改动）：
//   - MT036 support（createKbOwnershipFixture）：主库 knowledge 注册 + KB 侧
//     归属镜像行 + 归属迁移动作；
//   - kb-search 真实管线（hybridSearch + composite + qdrant 检索引擎）。
// 本票新增（全部为测试替身，生产代码零改动）：
//   - 内存向量库（QdrantClient 测试替身）：按真实引擎同语义逐字段过滤
//     （must: tenant_id match value / kb_id match any / enabled match true）、
//     余弦相似度、limit 截断、with_payload 映射；记录每次调用
//     （collection+body）——候选集合断言的引擎边界探针；
//   - 记录型 embedder / 记录型 reranker（检索端与重排端零调用计数 +
//     重排文本捕获）；
//   - KB 内容种子（knowledges + chunks 行，文档内 pre/next 链自动连接，
//     enabled=false 反例 + 向量点镜像真实 index-writer payload 键形）。

import { randomUUID } from "node:crypto";
import type { Db as KbDb } from "../../../src/kb/db/client";
import { chunks, knowledges } from "../../../src/kb/db/schema";
import type { QdrantClient } from "../../../src/kb/infrastructure/qdrant/client";
import type {
  QueryPointsBody,
  QueryPointsResponse,
  ScoredPoint,
} from "../../../src/kb/infrastructure/qdrant/types";
import type { Embedder } from "../../../src/kb/models/embedding/embedder";
import type { Reranker } from "../../../src/kb/models/rerank/openai-compat";
import { enterpriseSetupDatabaseVariable } from "../../support/enterprise-database";

/** 环境探针：企业测试库 + KB 专用测试库缺一不可，显式 skip 绝不回退开发库。 */
export function probeRetrievalRestrictionEnvironment():
  | { ok: true }
  | { ok: false; reason: string } {
  const enterpriseVariable = enterpriseSetupDatabaseVariable();
  if (!process.env[enterpriseVariable]?.trim()) {
    return {
      ok: false,
      reason: `MT037 requires ${enterpriseVariable} (dedicated openbot_enterprise_* test database) — no dev-database fallback`,
    };
  }
  if (!process.env.KB_TEST_DATABASE_URL?.trim()) {
    return {
      ok: false,
      reason:
        "MT037 requires KB_TEST_DATABASE_URL (dedicated knowledge-base test database) — no dev-database fallback",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 内存向量库：真实 QdrantClient 形状的测试替身（候选集合断言的引擎边界探针）
// ---------------------------------------------------------------------------

export type StoredVectorPoint = {
  readonly id: string;
  readonly vector: number[];
  readonly payload: Record<string, unknown>;
};

export type CapturedVectorQuery = {
  readonly collection: string;
  readonly body: QueryPointsBody;
};

export interface InMemoryVectorStore {
  readonly client: QdrantClient;
  readonly collection: string;
  /** 种子面：测试直接 push 点（payload 键形镜像真实 index-writer）。 */
  readonly points: StoredVectorPoint[];
  /** 引擎边界探针：每次 queryPoints 的 collection + 请求体逐字段捕获。 */
  readonly calls: readonly CapturedVectorQuery[];
  resetCalls(): void;
}

/** 确定性余弦（非负向量域内 ∈ [0,1]；零向量相似度 0）。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createInMemoryVectorStore(
  collection: string,
): InMemoryVectorStore {
  const points: StoredVectorPoint[] = [];
  const calls: CapturedVectorQuery[] = [];
  const client = {
    async queryPoints(
      asked: string,
      body: QueryPointsBody,
    ): Promise<QueryPointsResponse> {
      calls.push({ collection: asked, body });
      // collection 不匹配 = 真实 Qdrant 404 语义：空结果（测试不依赖报错）。
      if (asked !== collection) {
        return { result: { points: [] } };
      }
      let tenantMatch: string | undefined;
      let kbAny: string[] | undefined;
      let enabledMatch: boolean | undefined;
      for (const condition of body.filter?.must ?? []) {
        if (condition.key === "tenant_id" && "value" in condition.match) {
          tenantMatch = condition.match.value as string;
        } else if (condition.key === "kb_id" && "any" in condition.match) {
          kbAny = (condition.match.any as (string | number)[]).map(String);
        } else if (condition.key === "enabled" && "value" in condition.match) {
          enabledMatch = Boolean(condition.match.value);
        }
      }
      const query = body.query;
      const scored: ScoredPoint[] = points
        .filter(
          (p) =>
            (tenantMatch === undefined ||
              p.payload.tenant_id === tenantMatch) &&
            (kbAny === undefined || kbAny.includes(String(p.payload.kb_id))) &&
            (enabledMatch === undefined || p.payload.enabled === enabledMatch),
        )
        .map((p) => ({
          id: p.id,
          score: cosine(query, p.vector),
          payload: p.payload,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, body.limit));
      return { result: { points: scored } };
    },
  } as unknown as QdrantClient;
  return {
    client,
    collection,
    points,
    calls,
    resetCalls() {
      calls.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 确定性向量与记录型 embedder / reranker
// ---------------------------------------------------------------------------

/** FNV-1a 种子 + mulberry32 的确定性非负单位向量（可复现，无网络无模型）。 */
export function deterministicVector(text: string, dimension: number): number[] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const raw: number[] = [];
  let state = hash >>> 0;
  for (let i = 0; i < dimension; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    raw.push(((t ^ (t >>> 14)) >>> 0) / 4294967296);
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => (norm === 0 ? 0 : v / norm));
}

export interface RecordingEmbedder {
  readonly embedder: Embedder;
  /** embed() 调用计数（检索端零调用断言的探针）。 */
  embedCalls(): number;
  readonly queries: readonly string[];
  resetCalls(): void;
}

export function createRecordingEmbedder(dimension: number): RecordingEmbedder {
  const queries: string[] = [];
  return {
    embedder: {
      async embed(text: string) {
        queries.push(text);
        return deterministicVector(text, dimension);
      },
      async batchEmbed(texts: string[]) {
        return texts.map((text) => deterministicVector(text, dimension));
      },
      getModelName: () => "mt037-test-embedder",
      getDimensions: () => dimension,
      getModelID: () => "mt037-test-embedder",
    },
    embedCalls: () => queries.length,
    queries,
    resetCalls() {
      queries.length = 0;
    },
  };
}

export interface RecordingReranker {
  readonly reranker: Reranker;
  /** 每次 rerank 收到的 documents 文本（重排候选文本捕获面）。 */
  readonly documentsPerCall: readonly string[][];
  readonly queries: readonly string[];
  resetCalls(): void;
}

export function createRecordingReranker(): RecordingReranker {
  const documentsPerCall: string[][] = [];
  const queries: string[] = [];
  return {
    reranker: {
      async rerank(query: string, documents: string[]) {
        queries.push(query);
        documentsPerCall.push([...documents]);
        return documents.map((_, index) => ({
          index,
          relevanceScore: 1 - index * 0.001,
        }));
      },
      getModelName: () => "mt037-recording-reranker",
      getModelID: () => "mt037-recording-reranker",
    },
    documentsPerCall,
    queries,
    resetCalls() {
      documentsPerCall.length = 0;
      queries.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// KB 内容种子：knowledges + chunks 行 + 内存向量点（镜像 index-writer 键形）
// ---------------------------------------------------------------------------

export interface SeedChunkSpec {
  readonly key: string;
  readonly content: string;
  /** 默认 true；false = 禁用 chunk（检索不可见反例）。 */
  readonly enabled?: boolean;
}

export interface SeedDocSpec {
  readonly docKey: string;
  readonly title: string;
  /** 数组顺序即文档内链序（pre/next 自动连接）。 */
  readonly chunks: readonly SeedChunkSpec[];
}

export interface SeedResult {
  readonly docIds: ReadonlyMap<string, string>;
  readonly chunkIds: ReadonlyMap<string, string>;
}

export async function seedRetrievalContent(input: {
  kbDb: KbDb;
  store: InMemoryVectorStore;
  dimension: number;
  tenantId: string;
  kbId: string;
  docs: readonly SeedDocSpec[];
}): Promise<SeedResult> {
  const docIds = new Map<string, string>();
  const chunkIds = new Map<string, string>();
  const chunkRows: (typeof chunks.$inferInsert)[] = [];
  for (const doc of input.docs) {
    const docId = randomUUID();
    docIds.set(doc.docKey, docId);
    await input.kbDb.insert(knowledges).values({
      id: docId,
      tenantId: input.tenantId,
      knowledgeBaseId: input.kbId,
      type: "manual",
      title: doc.title,
      embeddingModelId: "mt037-test-embedder",
      parseStatus: "completed",
    });
    for (let index = 0; index < doc.chunks.length; index += 1) {
      const spec = doc.chunks[index];
      const chunkId = randomUUID();
      chunkIds.set(`${doc.docKey}/${spec.key}`, chunkId);
      chunkRows.push({
        id: chunkId,
        tenantId: input.tenantId,
        knowledgeId: docId,
        knowledgeBaseId: input.kbId,
        content: spec.content,
        chunkIndex: index,
        isEnabled: spec.enabled ?? true,
        preChunkId:
          index > 0
            ? (chunkIds.get(`${doc.docKey}/${doc.chunks[index - 1].key}`) ?? "")
            : "",
        nextChunkId: "",
      });
      if (index > 0) {
        const pre = chunkRows[chunkRows.length - 2];
        pre.nextChunkId = chunkId;
      }
      input.store.points.push({
        id: chunkId,
        vector: deterministicVector(spec.content, input.dimension),
        payload: {
          tenant_id: input.tenantId,
          kb_id: input.kbId,
          doc_id: docId,
          chunk_id: chunkId,
          chunk_index: index,
          chunk_type: "text",
          source_type: "chunk",
          enabled: spec.enabled ?? true,
          content: spec.content,
          context_header: "",
        },
      });
    }
  }
  if (chunkRows.length > 0) {
    await input.kbDb.insert(chunks).values(chunkRows);
  }
  return { docIds, chunkIds };
}
