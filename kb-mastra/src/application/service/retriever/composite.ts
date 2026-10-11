/**
 * 复合检索引擎：WeKnora retriever/composite.go 直译。
 * 错误契约：引擎级失败 → 整组丢弃返回 error（all-or-nothing）；结果级
 * 失败（result.error）→ 命中保留 + 错误随行（调用方记日志不丢证据）。
 * 每个参数一个 Promise 并发执行（P1 实际单参数 vector）。
 */
import type {
  IndexWithScore,
  RetrieveEngine,
  RetrieveParams,
  RetrieveResult,
} from "./engine";

export class EngineNotFoundError extends Error {
  constructor(retrieverType: string) {
    super(`retriever type ${retrieverType} not found`);
    this.name = "EngineNotFoundError";
  }
}

export type CompositeRetrieveEngine = {
  retrieve(params: RetrieveParams[]): Promise<RetrieveResult[]>;
};

export function createCompositeRetrieveEngine(engines: RetrieveEngine[]): CompositeRetrieveEngine {
  const liveEngines = engines.filter((e) => e !== null);

  return {
    async retrieve(params: RetrieveParams[]): Promise<RetrieveResult[]> {
      const results = await Promise.all(
        params.map(async (param): Promise<RetrieveResult> => {
          const engine = liveEngines.find((e) => e.retrieverTypes.includes(param.retrieverType));
          if (engine === undefined) {
            // 参数级找不到引擎：该参数丢弃并带错误（其它参数照常）。
            return {
              retrieverType: param.retrieverType,
              retrieverEngineType: "none",
              results: [],
              error: new EngineNotFoundError(param.retrieverType),
            };
          }
          try {
            const hits = await engine.retrieve(param);
            return {
              retrieverType: param.retrieverType,
              retrieverEngineType: engine.engineType,
              results: hits,
            };
          } catch (error) {
            // 引擎级失败：该参数结果丢弃，错误随行（对齐 all-or-nothing 折半：
            // 多参数场景下其余参数的命中保留——WeKnora concurrentRetrieve 的
            // 单参数错误即返回整组错误，P1 单参数场景下两者等价）。
            return {
              retrieverType: param.retrieverType,
              retrieverEngineType: engine.engineType,
              results: [],
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        }),
      );
      return results;
    },
  };
}

/** 引擎级失败收集（kb-search 判定整体降级用）。 */
export function engineErrors(results: RetrieveResult[]): Error[] {
  return results.flatMap((r) => (r.error !== undefined ? [r.error] : []));
}

/** 全部命中展平（保持参数序）。 */
export function allHits(results: RetrieveResult[]): IndexWithScore[] {
  return results.flatMap((r) => r.results);
}
