/**
 * 重排阶段：WeKnora reranking/rerank.go 直译。
 * 候选截断（MaxCandidates=200）→ ModelPassage 构建 → fitPassages → 模型打分 →
 * 阈值 0.2（全灭降级 ×0.7 下限 0.3，仍全灭保底 best≥0.15）→ 模型失败优雅
 * 降级保检索序 → compositeScore（0.6*model + 0.3*base + 0.1*sourceWeight，clamp [0,1]）
 * → 可选 MMR TopK 选择。
 */
import type { RankResult, Reranker } from "../models/rerank/openai-compat";
import { DEFAULT_MMR_LAMBDA, selectMMR } from "./mmr";
import { fitPassages, modelPassage } from "./passage";

export const DEFAULT_THRESHOLD = 0.2;
export const DEFAULT_FALLBACK_MIN_SCORE = 0.15;
const DEGRADE_FLOOR = 0.3;
const DEGRADE_FACTOR = 0.7;
export const DEFAULT_MAX_CANDIDATES = 200;

export type RerankOutcome =
  | "ok"
  | "no_candidates"
  | "model_error"
  | "threshold_degraded"
  | "fallback_top1"
  | "all_below_threshold";

export type RerankRow = {
  chunkId: string;
  score: number;
  content: string;
  contextHeader: string;
  knowledgeTitle: string;
  /** 透传的附加字段（组装 SearchResult 时原样带回）。 */
  extra: Record<string, unknown>;
};

export type RerankOptions = {
  threshold?: number;
  topK?: number;
  fallbackMinScore?: number;
  maxCandidates?: number;
};

export type RerankResult = {
  /** 通过阈值（或降级/保底）的行，best first；模型失败时=输入原序。 */
  results: RerankRow[];
  /** results[i] 在输入中的下标。 */
  indices: number[];
  outcome: RerankOutcome;
  effectiveThreshold: number;
  applied: boolean;
  /** 模型错误文案（outcome=model_error 时）。 */
  error?: string;
  topScore?: number;
  candidateCount: number;
};

/** 检索分与模型分的融合（WeKnora CompositeScore；sourceWeight 恒 1，web_search 权重裁剪）。 */
export function compositeScore(modelScore: number, baseScore: number): number {
  const composite = 0.6 * modelScore + 0.3 * baseScore + 0.1 * 1.0;
  return Math.min(Math.max(composite, 0), 1);
}

/** 重排主入口。模型调用失败不是错误：返回输入行原序 + model_error，调用方降级。 */
export async function rerank(
  model: Reranker,
  query: string,
  rows: RerankRow[],
  options: RerankOptions = {},
): Promise<RerankResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const fallbackMinScore =
    options.fallbackMinScore ?? DEFAULT_FALLBACK_MIN_SCORE;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const result: RerankResult = {
    results: [],
    indices: [],
    outcome: "no_candidates",
    effectiveThreshold: threshold,
    applied: false,
    candidateCount: 0,
  };

  // 候选截断：只保留检索分最高的 maxCandidates 行（并列取早）。
  const keep = topByScore(rows, maxCandidates);
  const candidateIdx: number[] = [];
  const candidates: RerankRow[] = [];
  const passages: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (keep !== null && !keep.has(i)) continue;
    const passage = modelPassage({
      content: rows[i].content,
      contextHeader: rows[i].contextHeader,
      knowledgeTitle: rows[i].knowledgeTitle,
    });
    if (passage.trim() === "") continue;
    candidateIdx.push(i);
    candidates.push(rows[i]);
    passages.push(passage);
  }
  result.candidateCount = candidates.length;
  if (candidates.length === 0) {
    result.outcome = "no_candidates";
    return result;
  }

  const limit = model.maxPassageRunes?.(query) ?? 0;
  fitPassages(passages, limit);

  let scores: RankResult[];
  try {
    scores = await model.rerank(query, passages);
  } catch (error) {
    result.outcome = "model_error";
    result.error = (error as Error).message;
    // 优雅降级：输入行原序原分返回。
    result.results = rows.map((r) => ({ ...r }));
    result.indices = rows.map((_, i) => i);
    return result;
  }

  // 丢弃越界 index（模型返回脏数据防御）。
  const valid = scores.filter(
    (s) => s.index >= 0 && s.index < candidates.length,
  );
  result.applied = true;
  const top = bestScore(valid);
  if (top !== null) result.topScore = top.relevanceScore;

  const applied = applyThreshold(valid, threshold, fallbackMinScore);
  result.outcome = applied.outcome;
  result.effectiveThreshold = applied.effectiveThreshold;

  const scored: RerankRow[] = [];
  const scoredIdx: number[] = [];
  for (const rr of applied.passing) {
    const row = candidates[rr.index];
    scoredIdx.push(candidateIdx[rr.index]);
    scored.push({
      ...row,
      extra: {
        ...row.extra,
        base_score: row.score.toFixed(4),
        model_score: rr.relevanceScore.toFixed(4),
      },
      score: compositeScore(rr.relevanceScore, row.score),
    });
  }

  // 排序：composite 降序；并列按 pre-boost（model score）降序。
  const order = scored.map((_, i) => i);
  order.sort((a, b) => {
    if (scored[a].score !== scored[b].score)
      return scored[b].score - scored[a].score;
    return (
      Number.parseFloat(String(scored[b].extra.model_score ?? "0")) -
      Number.parseFloat(String(scored[a].extra.model_score ?? "0"))
    );
  });

  const orderedRows = order.map((i) => scored[i]);
  const orderedIdx = order.map((i) => scoredIdx[i]);

  // MMR 选择（topK>0 时）。
  let picks: number[];
  if ((options.topK ?? 0) > 0 && orderedRows.length > 0) {
    const k = Math.min(options.topK ?? 0, orderedRows.length);
    const mmrPicks = selectMMR(
      orderedRows.map((r) => ({ score: r.score, passage: r.content })),
      k,
      DEFAULT_MMR_LAMBDA,
    );
    picks = mmrPicks;
  } else {
    picks = orderedRows.map((_, i) => i);
  }

  result.results = picks.map((p) => orderedRows[p]);
  result.indices = picks.map((p) => orderedIdx[p]);
  return result;
}

/** 检索分最高的 limit 行下标集合；limit≤0 或全员装下时 null（不裁）。 */
function topByScore(rows: RerankRow[], limit: number): Set<number> | null {
  if (limit <= 0 || rows.length <= limit) return null;
  const order = rows.map((_, i) => i);
  order.sort((a, b) => {
    if (rows[a].score !== rows[b].score) return rows[b].score - rows[a].score;
    return a - b; // 并列保早
  });
  return new Set(order.slice(0, limit));
}

function applyThreshold(
  scores: RankResult[],
  threshold: number,
  fallbackMinScore: number,
): {
  passing: RankResult[];
  outcome: RerankOutcome;
  effectiveThreshold: number;
} {
  let effective = threshold;
  const direct = scores.filter((s) => s.relevanceScore >= threshold);
  if (direct.length > 0)
    return { passing: direct, outcome: "ok", effectiveThreshold: effective };

  if (threshold > DEGRADE_FLOOR) {
    effective = Math.max(threshold * DEGRADE_FACTOR, DEGRADE_FLOOR);
    const degraded = scores.filter((s) => s.relevanceScore >= effective);
    if (degraded.length > 0) {
      return {
        passing: degraded,
        outcome: "threshold_degraded",
        effectiveThreshold: effective,
      };
    }
  }

  const top = bestScore(scores);
  if (top !== null && top.relevanceScore >= fallbackMinScore) {
    return {
      passing: [top],
      outcome: "fallback_top1",
      effectiveThreshold: effective,
    };
  }
  return {
    passing: [],
    outcome: "all_below_threshold",
    effectiveThreshold: effective,
  };
}

function bestScore(scores: RankResult[]): RankResult | null {
  if (scores.length === 0) return null;
  let top = scores[0];
  for (const s of scores.slice(1)) {
    if (s.relevanceScore > top.relevanceScore) top = s;
  }
  return top;
}
