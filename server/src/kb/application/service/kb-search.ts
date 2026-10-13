/**
 * HybridSearch 编排：WeKnora knowledgebase_search.go 的 P1 投影。
 * 查询嵌入一次 → composite 并发（vector + keywords no-op）→ fuseOrDeduplicate
 * 三分支（仅向量=余弦分+ChunkID 去重取最高分；混合=RRF 0.7/0.3/k=60 代码
 * 保留，kw 空数组自然退化）→ top_k 截断 → 上下文扩展（相邻链表一跳）→
 * 组装 SearchResult → 可选 rerank（默认关）。
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { chunks, knowledges } from "../../db/schema";
import type { Embedder } from "../../models/embedding/embedder";
import type { Reranker } from "../../models/rerank/openai-compat";
import { type RerankRow, rerank } from "../../reranking/rerank";
import {
  type CompositeRetrieveEngine,
  engineErrors,
} from "./retriever/composite";
import type { RetrieveParams } from "./retriever/engine";

/** RRF 参数（WeKnora RetrievalConfig 默认值）：k=60，向量 0.7 / 关键词 0.3。 */
export const RRF_K = 60;
export const RRF_VECTOR_WEIGHT = 0.7;
export const RRF_KEYWORD_WEIGHT = 0.3;

export type SearchRequest = {
  tenantId: string;
  kbIds: string[];
  query: string;
  topK: number;
  scoreThreshold: number;
  /** P1 固定 true（OpenBot 中间件契约）；参数必须接受不 422。 */
  hybrid: boolean;
  /** rerank 开关（默认 false，对齐 kb-service 契约）。 */
  rerank?: boolean;
};

/** 对外 SearchResult（wire 投影的直接来源）。 */
export type SearchResult = {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  /** knowledge.source（file/url/manual）。 */
  source: string;
  title: string;
  metadata: Record<string, string>;
};

export type SearchOutcome = {
  results: SearchResult[];
  count: number;
  /** rerank 诊断（未启用时 undefined）。 */
  rerankOutcome?: string;
};

/** IndexWithScore 的融合中间形态（含 keywords 通道分数）。 */
type FusedRow = {
  chunkId: string;
  score: number;
  docId: string;
  kbId: string;
  content: string;
  contextHeader: string;
  chunkIndex: number;
};

export type KbSearchDeps = {
  embedder: Embedder;
  composite: CompositeRetrieveEngine;
  db: Db;
  reranker?: Reranker;
  rerankDefaults?: { enabled: boolean; threshold: number; topK: number };
};

/** 检索主入口。 */
export async function hybridSearch(
  deps: KbSearchDeps,
  request: SearchRequest,
): Promise<SearchOutcome> {
  // 1. 查询嵌入一次。
  const queryVector = await deps.embedder.embed(request.query);

  // 2. composite 并发：vector 通道 +（hybrid 时）keywords no-op 通道。
  const params: RetrieveParams[] = [
    {
      retrieverType: "vector",
      tenantId: request.tenantId,
      kbIds: request.kbIds,
      queryVector,
      topK: request.topK,
      scoreThreshold: request.scoreThreshold,
    },
  ];
  if (request.hybrid) {
    params.push({
      retrieverType: "keywords",
      tenantId: request.tenantId,
      kbIds: request.kbIds,
      queryText: request.query,
      topK: request.topK,
      scoreThreshold: 0,
    });
  }
  const retrieveResults = await deps.composite.retrieve(params);
  const _errors = engineErrors(retrieveResults);
  // 引擎级失败：vector 通道挂了 = 无候选（G4 miss 语义），keywords 空数组本就无贡献。
  // P1 单 vector 引擎：错误时自然空结果；日志由 composite 上层记录。

  const vectorLists = retrieveResults
    .filter((r) => r.retrieverType === "vector" && r.results.length > 0)
    .map((r) => r.results);
  const keywordLists = retrieveResults
    .filter((r) => r.retrieverType === "keywords" && r.results.length > 0)
    .map((r) => r.results);

  // 3. 融合三分支。
  const fused = fuseOrDeduplicate(vectorLists, keywordLists);

  // 4. top_k 截断。
  const topRows = fused.slice(0, request.topK);

  // 5. 相邻链表一跳扩展 + chunk 元数据批量取回。
  const expanded = await expandNeighbors(deps.db, topRows, request.tenantId);

  // 6. 组装。
  const assembled = await assembleSearchResults(deps.db, expanded);

  // 7. 可选 rerank（默认关；模型失败优雅降级保检索序）。
  const rerankEnabled = request.rerank ?? deps.rerankDefaults?.enabled ?? false;
  if (rerankEnabled && deps.reranker !== undefined && assembled.length > 0) {
    const rows: RerankRow[] = assembled.map((r) => ({
      chunkId: r.chunkId,
      score: r.score,
      content: r.content,
      contextHeader: r.metadata.context_header ?? "",
      knowledgeTitle: r.title,
      extra: {},
    }));
    const reranked = await rerank(deps.reranker, request.query, rows, {
      threshold: deps.rerankDefaults?.threshold,
      topK: deps.rerankDefaults?.topK,
    });
    const byChunk = new Map(assembled.map((r) => [r.chunkId, r]));
    const results = reranked.results
      .map((row) => byChunk.get(row.chunkId))
      .filter((r): r is SearchResult => r !== undefined)
      .map((r, i) => ({ ...r, score: reranked.results[i].score }));
    return { results, count: results.length, rerankOutcome: reranked.outcome };
  }

  return { results: assembled, count: assembled.length };
}

// ---- 融合三分支（knowledgebase_search_fusion.go 直译）----

function flatten<T>(lists: T[][]): T[] {
  return lists.flat();
}

function sortByScoreDesc(a: { score: number }, b: { score: number }): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return 0;
}

/** ChunkID 去重取最高分，按分数降序。 */
function deduplicateByScore<T extends { chunkId: string; score: number }>(
  results: T[],
): T[] {
  const map = new Map<string, T>();
  for (const r of results) {
    const existing = map.get(r.chunkId);
    if (existing === undefined || r.score > existing.score)
      map.set(r.chunkId, r);
  }
  return [...map.values()].sort(sortByScoreDesc);
}

/** 融合入口：三分支（vector-only / keyword-only / RRF hybrid）。 */
export function fuseOrDeduplicate(
  vectorLists: FusedRow[][],
  keywordLists: FusedRow[][],
): FusedRow[] {
  if (keywordLists.length === 0) {
    // 仅向量：保留原始余弦分（FAQ 阈值依赖它）。
    return deduplicateByScore(flatten(vectorLists));
  }
  if (vectorLists.length === 0) {
    // 仅关键词：每列表按自身最高分归一化到 [0,1]（BM25 无界）。
    for (const list of keywordLists) rescaleUnboundedScores(list);
    return deduplicateByScore(flatten(keywordLists));
  }
  // 混合：加权 RRF，除以最大值落 [0,1]。
  return fuseWithRRF(vectorLists, keywordLists);
}

function rescaleUnboundedScores(rows: { score: number }[]): void {
  let maxScore = 0;
  for (const r of rows) {
    if (Number.isNaN(r.score) || !Number.isFinite(r.score)) continue;
    if (r.score > maxScore) maxScore = r.score;
  }
  if (maxScore <= 1) return;
  for (const r of rows) {
    if (Number.isNaN(r.score) || r.score <= 0) r.score = 0;
    else r.score = r.score / maxScore;
  }
}

/**
 * 加权 RRF：score = (vw/(k+vRank) + kw/(k+kRank)) / ((vw+kw)/(k+1))。
 * 每 chunk 的 rank = 其在该检索类型任一列表中的最佳 1-based 名次。
 */
function fuseWithRRF(
  vectorLists: FusedRow[][],
  keywordLists: FusedRow[][],
): FusedRow[] {
  const maxRRF = (RRF_VECTOR_WEIGHT + RRF_KEYWORD_WEIGHT) / (RRF_K + 1);
  const vectorRanks = bestRanks(vectorLists);
  const keywordRanks = bestRanks(keywordLists);

  const chunkMap = new Map<string, FusedRow>();
  for (const r of flatten(vectorLists)) {
    const existing = chunkMap.get(r.chunkId);
    if (existing === undefined || r.score > existing.score)
      chunkMap.set(r.chunkId, r);
  }
  for (const r of flatten(keywordLists)) {
    if (!chunkMap.has(r.chunkId)) chunkMap.set(r.chunkId, r);
  }

  const out: FusedRow[] = [];
  for (const [chunkId, info] of chunkMap) {
    let rrf = 0;
    const vRank = vectorRanks.get(chunkId);
    if (vRank !== undefined) rrf += RRF_VECTOR_WEIGHT / (RRF_K + vRank);
    const kRank = keywordRanks.get(chunkId);
    if (kRank !== undefined) rrf += RRF_KEYWORD_WEIGHT / (RRF_K + kRank);
    out.push({ ...info, score: rrf / maxRRF });
  }
  return out.sort(sortByScoreDesc);
}

function bestRanks(lists: FusedRow[][]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const list of lists) {
    const deduped = deduplicateByScore(list);
    for (let i = 0; i < deduped.length; i += 1) {
      const rank = i + 1;
      const current = ranks.get(deduped[i].chunkId);
      if (current === undefined || rank < current) {
        ranks.set(deduped[i].chunkId, rank);
      }
    }
  }
  return ranks;
}

// ---- 上下文扩展（相邻链表一跳）+ 组装 ----

/**
 * 相邻链表一跳扩展：对每个命中行查 pre/next chunk（payload 链表在 DB）。
 * 扩展行不改变排序位置——按 chunkIndex 就近附加在命中行内容尾部（P1 投影：
 * 命中块内容 + 相邻一跳拼接，分数沿用命中块）。
 */
async function expandNeighbors(
  db: Db,
  rows: FusedRow[],
  tenantId: string,
): Promise<FusedRow[]> {
  if (rows.length === 0) return [];
  const chunkIds = rows.map((r) => r.chunkId);
  const neighborIds = new Set<string>();
  const rowsFromDb = await db
    .select({ id: chunks.id, pre: chunks.preChunkId, next: chunks.nextChunkId })
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), inArray(chunks.id, chunkIds)));
  const byId = new Map(rowsFromDb.map((r) => [r.id, r]));
  for (const row of rows) {
    const dbRow = byId.get(row.chunkId);
    if (dbRow === undefined) continue;
    if (dbRow.pre !== "") neighborIds.add(dbRow.pre);
    if (dbRow.next !== "") neighborIds.add(dbRow.next);
  }
  if (neighborIds.size === 0) return rows;

  const neighborRows = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      contextHeader: chunks.contextHeader,
      chunkIndex: chunks.chunkIndex,
      knowledgeId: chunks.knowledgeId,
      knowledgeBaseId: chunks.knowledgeBaseId,
    })
    .from(chunks)
    .where(
      and(eq(chunks.tenantId, tenantId), inArray(chunks.id, [...neighborIds])),
    );
  const neighborsById = new Map(neighborRows.map((r) => [r.id, r]));

  return rows.map((row) => {
    const dbRow = byId.get(row.chunkId);
    if (dbRow === undefined) return row;
    const parts: string[] = [row.content];
    // pre 在前 next 在后；只附加以防缺失安全跳过。
    const pre = dbRow.pre !== "" ? neighborsById.get(dbRow.pre) : undefined;
    if (pre !== undefined) parts.unshift(pre.content);
    const next = dbRow.next !== "" ? neighborsById.get(dbRow.next) : undefined;
    if (next !== undefined) parts.push(next.content);
    return { ...row, content: parts.join("\n") };
  });
}

/** 组装 SearchResult：批量取 knowledge 行（title/source）。 */
async function assembleSearchResults(
  db: Db,
  rows: FusedRow[],
): Promise<SearchResult[]> {
  if (rows.length === 0) return [];
  const docIds = [...new Set(rows.map((r) => r.docId))].filter(
    (id) => id !== "",
  );
  const docs = docIds.length
    ? await db
        .select({
          id: knowledges.id,
          title: knowledges.title,
          source: knowledges.source,
          type: knowledges.type,
          updatedAt: knowledges.updatedAt,
        })
        .from(knowledges)
        .where(inArray(knowledges.id, docIds))
    : [];
  const docById = new Map(docs.map((d) => [d.id, d]));

  return rows.map((row) => {
    const doc = docById.get(row.docId);
    return {
      chunkId: row.chunkId,
      docId: row.docId,
      kbId: row.kbId,
      content: row.content,
      score: row.score,
      source: doc?.source ?? "",
      title: doc?.title ?? "",
      metadata: {
        title: doc?.title ?? "",
        chunk_index: String(row.chunkIndex),
        source_type: doc?.type ?? "",
        // The craft company-search relay's citation contract (onyx-cli) reads
        // updated_at for its --days filter; ISO string, WeKnora wire shape.
        updated_at: (doc?.updatedAt ?? new Date(0)).toISOString(),
        ...(row.contextHeader !== ""
          ? { context_header: row.contextHeader }
          : {}),
      },
    };
  });
}
