/**
 * 引擎注册与工厂（WeKnora retriever/{factory,registry}.go 对应物，裁剪为
 * 进程内静态注册）。P1 注册两个引擎：qdrant vector + keywords no-op。
 */
import type { RetrieveEngine } from "./engine";
import { createKeywordsEngine } from "./keywords";
import { createQdrantVectorEngine } from "../../repository/retriever/qdrant/vector";

export type RetrieverRegistry = {
  engines(): RetrieveEngine[];
};

export function createRetrieverRegistry(engines: RetrieveEngine[]): RetrieverRegistry {
  const live = engines.filter((e) => e !== null);
  return {
    engines() {
      return live;
    },
  };
}

/** P1 工厂：qdrant 检索引擎 + keywords no-op。 */
export function createDefaultRegistry(
  qdrantDeps: Parameters<typeof createQdrantVectorEngine>[0],
): RetrieverRegistry {
  return createRetrieverRegistry([
    createQdrantVectorEngine(qdrantDeps),
    createKeywordsEngine(),
  ]);
}
