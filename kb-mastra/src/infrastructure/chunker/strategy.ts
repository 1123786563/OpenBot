/**
 * 自适应切分策略入口：WeKnora chunker/strategy.go 直译。
 * 调用方用 split/splitParentChild（而非 legacy splitText/splitTextParentChild）；
 * 策略解析器按文档画像与 Strategy 提示选层，逐层校验、失败降级到 legacy 兜底。
 */

import { mergeBreadcrumbs } from "./breadcrumbs";
import { splitByHeadingsImpl } from "./heading-splitter";
import { splitByHeuristicsImpl } from "./heuristic-splitter";
import {
  type DocProfile,
  profileDocument,
  type StrategyTier,
  selectStrategy,
} from "./profiler";
import {
  type Chunk,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SEPARATORS,
  runeLen,
  type SplitterConfig,
  splitText,
} from "./splitter";
import { charsForTokenLimit } from "./tokens";
import { validateChunks } from "./validator";

export type StrategyValue =
  | "auto"
  | "heading"
  | "heuristic"
  | "recursive"
  | "legacy";

export type TierRejection = { tier: StrategyTier; reason: string };

export type Diagnostics = {
  selectedTier: StrategyTier;
  tierChain: StrategyTier[];
  rejected: TierRejection[];
  profile: DocProfile | null;
};

/**
 * 按配置策略切分。Strategy 空或 "auto" 时由画像选层。总是返回非空结果：
 * 层失败时链式落到 legacy（原 Tier 3 实现）。
 */
export function split(text: string, cfg: SplitterConfig): Chunk[] {
  if (text === "") return [];
  const merged = ensureDefaults(cfg);
  const { chain, profile } = resolveChainWithProfile(text, merged);
  const totalChars = runeLen(text);

  let lastOut: Chunk[] | null = null;
  for (let i = 0; i < chain.length; i += 1) {
    const tier = chain[i];
    const out = runTier(tier, text, merged, profile);
    const v = validateChunks(out, totalChars, merged.chunkSize);
    if (v.ok) return out;
    if (tier === "legacy" && i === chain.length - 1) lastOut = out;
  }
  if (lastOut !== null) return lastOut;
  return splitText(text, merged);
}

/** split 的诊断版（预览端点用）：还返回选中层、完整链、拒绝原因、画像。 */
export function splitWithDiagnostics(
  text: string,
  cfg: SplitterConfig,
): { chunks: Chunk[]; diagnostics: Diagnostics } {
  const diag: Diagnostics = {
    selectedTier: "legacy",
    tierChain: [],
    rejected: [],
    profile: null,
  };
  if (text === "") return { chunks: [], diagnostics: diag };
  const merged = ensureDefaults(cfg);
  const { chain, profile } = resolveChainWithProfile(text, merged);
  diag.tierChain = chain;
  diag.profile = profile;
  const totalChars = runeLen(text);

  let lastOut: Chunk[] | null = null;
  let lastTier: StrategyTier = "legacy";
  for (let i = 0; i < chain.length; i += 1) {
    const tier = chain[i];
    const out = runTier(tier, text, merged, profile);
    const v = validateChunks(out, totalChars, merged.chunkSize);
    if (v.ok) {
      diag.selectedTier = tier;
      return { chunks: out, diagnostics: diag };
    }
    diag.rejected.push({ tier, reason: v.reason });
    if (tier === "legacy" && i === chain.length - 1) {
      lastOut = out;
      lastTier = tier;
    }
  }
  if (lastOut !== null) {
    diag.selectedTier = lastTier;
    return { chunks: lastOut, diagnostics: diag };
  }
  return { chunks: splitText(text, merged), diagnostics: diag };
}

// ---- 父子两级切分 ----

export type ChildChunk = Chunk & { parentIndex: number };
export type ParentChildResult = { parents: Chunk[]; children: ChildChunk[] };

/**
 * splitTextParentChild 的策略感知版：父级切分过策略选择器，每个父块再用
 * 小 chunk 配置二次切分。子级尊重 childCfg.strategy（空/auto 时父块内部的
 * 子标题/编号节由合适层接住，子块面包屑比父块更细）。子 Seq 全文档唯一。
 */
export function splitParentChild(
  text: string,
  parentCfg: SplitterConfig,
  childCfg: SplitterConfig,
): ParentChildResult {
  const parent = ensureDefaults(parentCfg);
  const child = ensureDefaults(childCfg);

  const parents = split(text, parent);
  if (parents.length === 0) return { parents: [], children: [] };

  const newParents: Chunk[] = [];
  const children: ChildChunk[] = [];
  let childSeq = 0;
  for (const p of parents) {
    const subs = mapChildrenToSource(p, split(p.content, child));

    let parentIndex = -1;
    if (
      subs.length > 1 ||
      (subs.length === 1 && subs[0].content !== p.content)
    ) {
      parentIndex = newParents.length;
      newParents.push(p);
    }
    for (const sub of subs) {
      children.push({
        ...sub,
        seq: childSeq,
        contextHeader: mergeBreadcrumbs(p.contextHeader, sub.contextHeader),
        parentIndex,
      });
      childSeq += 1;
    }
  }
  return { parents: newParents, children };
}

/**
 * 把 parent.content 内的偏移映射回文档偏移。父块可能带不占原文位置的合成表头
 * 前缀：保留在 Content 中，但排除在映射区间外；只含合成前缀的子块被丢弃。
 */
export function mapChildrenToSource(parent: Chunk, children: Chunk[]): Chunk[] {
  const offset = parent.end - runeLen(parent.content);
  const out: Chunk[] = [];
  for (const child of children) {
    const start = Math.max(parent.start, offset + child.start);
    const end = child.end + offset;
    if (end <= start) continue;
    out.push({ ...child, start, end });
  }
  return out;
}

// ---- 配置归一 ----

/** 与摄取管线一致的基础默认值（service 调用方与直接调用方拿到同一组数字）。 */
export function normalizeSplitterConfig(cfg: SplitterConfig): SplitterConfig {
  const out = { ...cfg, separators: [...cfg.separators] };
  if (out.chunkSize <= 0) out.chunkSize = DEFAULT_CHUNK_SIZE;
  if (out.chunkOverlap <= 0) out.chunkOverlap = DEFAULT_CHUNK_OVERLAP;
  if (out.separators.length === 0) out.separators = [...DEFAULT_SEPARATORS];
  return out;
}

/**
 * 摄取管线用的父子配置推导（预览与摄取保持同步的单一出处）。
 * Languages 双层同拷贝；TokenLimit 只拷给子级（父级保持配置的上下文窗口）。
 */
export function deriveParentChildConfigs(
  base: SplitterConfig,
  parentSize: number,
  childSize: number,
): { parent: SplitterConfig; child: SplitterConfig } {
  const pSize = parentSize > 0 ? parentSize : 4096;
  const cSize = childSize > 0 ? childSize : 384;
  return {
    parent: {
      chunkSize: pSize,
      chunkOverlap: base.chunkOverlap,
      separators: [...base.separators],
      strategy: base.strategy,
      tokenLimit: 0,
      languages: [...base.languages],
    },
    child: {
      chunkSize: cSize,
      chunkOverlap: Math.floor(cSize / 5),
      separators: [...base.separators],
      strategy: base.strategy,
      tokenLimit: base.tokenLimit,
      languages: [...base.languages],
    },
  };
}

function resolveChainWithProfile(
  text: string,
  cfg: SplitterConfig,
): { chain: StrategyTier[]; profile: DocProfile | null } {
  switch (cfg.strategy) {
    case "heading":
      return { chain: ["heading", "legacy"], profile: null };
    case "heuristic":
      return { chain: ["heuristic", "legacy"], profile: null };
    case "recursive":
      // "recursive" 是 "legacy" 的公开别名（存量配置兼容）。
      return { chain: ["legacy"], profile: null };
    case "legacy":
    case "":
      return { chain: ["legacy"], profile: null };
    default: {
      const profile = profileDocument(text);
      return { chain: selectStrategy(profile), profile };
    }
  }
}

function runTier(
  tier: StrategyTier,
  text: string,
  cfg: SplitterConfig,
  profile: DocProfile | null,
): Chunk[] {
  switch (tier) {
    case "heading":
      return splitByHeadingsImpl(text, cfg, profile);
    case "heuristic":
      return splitByHeuristicsImpl(text, cfg, profile);
    case "legacy":
      return splitText(text, cfg);
  }
  return splitText(text, cfg);
}

/** 零值字段填默认。TokenLimit 设置时把 ChunkSize clamp 到 token 预算内（0.9 安全系数）。 */
export function ensureDefaults(cfg: SplitterConfig): SplitterConfig {
  const out = {
    ...cfg,
    separators: [...cfg.separators],
    languages: [...cfg.languages],
  };
  if (out.chunkSize <= 0) out.chunkSize = DEFAULT_CHUNK_SIZE;
  if (out.chunkOverlap <= 0) out.chunkOverlap = DEFAULT_CHUNK_OVERLAP;
  if (out.separators.length === 0) out.separators = [...DEFAULT_SEPARATORS];
  if (out.tokenLimit > 0) {
    const lang = out.languages.length > 0 ? out.languages[0] : "mixed";
    const charBudget = charsForTokenLimit(out.tokenLimit, lang);
    if (charBudget > 0 && charBudget < out.chunkSize) {
      out.chunkSize = charBudget;
    }
  }
  // 病态 overlap 防护：Overlap 超 ChunkSize 一半时几乎每块都是复制内容。
  if (out.chunkOverlap > out.chunkSize / 2 && out.chunkSize > 0) {
    out.chunkOverlap = Math.floor(out.chunkSize / 2);
  }
  return out;
}
