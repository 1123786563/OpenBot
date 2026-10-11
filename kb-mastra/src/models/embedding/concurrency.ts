/**
 * 嵌入并发限流（WeKnora models/embedding/concurrency_wrapper.go 的 ants 池对应物）。
 * p-limit 语义：任意时刻在途嵌入调用 ≤ limit；排队 FIFO。P1 默认 32
 * （KB_EMBED_MAX_CONCURRENCY）。批量内部各自顺序执行，限流发生在批间——
 * 调用方（摄取 worker / kb-search）把每批作为一个受限单元。
 */
import type { Embedder } from "./embedder";

export const DEFAULT_EMBED_MAX_CONCURRENCY = 32;

type Limiter = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

/** 极简 p-limit 等价（避免为单一调用点引入依赖）。 */
export function createLimiter(limit: number): Limiter {
  const effective = limit > 0 ? limit : DEFAULT_EMBED_MAX_CONCURRENCY;
  let active = 0;
  const queue: (() => void)[] = [];

  const next = (): void => {
    if (active >= effective) return;
    const resolve = queue.shift();
    if (resolve === undefined) return;
    active += 1;
    resolve();
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        });
        next();
      });
    },
  };
}

export type ConcurrencyOptions = {
  /** 并发上限（A 线 worker.ts 使用的字段名）。 */
  limit?: number;
  /** 并发上限（maxConcurrency 的别名；两者取先出现者）。 */
  maxConcurrency?: number;
};

/** 包一层并发限流（embed/batchEmbed 各自受限）。 */
export function withConcurrency(
  inner: Embedder,
  options: ConcurrencyOptions = {},
): Embedder {
  const limit =
    options.limit !== undefined && options.limit > 0
      ? options.limit
      : (options.maxConcurrency ?? DEFAULT_EMBED_MAX_CONCURRENCY);
  const limiter = createLimiter(limit);
  return {
    async embed(text) {
      return limiter.run(() => inner.embed(text));
    },
    async batchEmbed(texts) {
      return limiter.run(() => inner.batchEmbed(texts));
    },
    getModelName() {
      return inner.getModelName();
    },
    getDimensions() {
      return inner.getDimensions();
    },
    getModelID() {
      return inner.getModelID();
    },
  };
}
