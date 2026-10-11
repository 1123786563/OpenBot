/**
 * BM25 关键词检索通道：P1 no-op 降级（设计 §7.1 决策）。
 * 接口、注册、融合分支代码全部保留——kw 空数组时 RRF 公式自然退化为仅向量
 * 分支，fuseOrDeduplicate 的三分支结构不变。P2 三档迁移路径（ParadeDB/
 * zhparser/WASM jieba）只换本文件实现。
 */
import type { RetrieveEngine, RetrieveParams } from "./engine";

export function createKeywordsEngine(): RetrieveEngine {
  return {
    engineType: "keywords-noop",
    retrieverTypes: ["keywords"],
    async retrieve(_params: RetrieveParams) {
      // no-op：恒空集。不抛错——空数组是「通道无结果」而非「通道故障」，
      // 融合层按 vector-only 分支继续。
      return [];
    },
  };
}
