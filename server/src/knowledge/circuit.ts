/**
 * 知识库检索的进程内熔断器。
 *
 * KB-Service 挂掉时每次对话仍会发起检索请求（中间件每轮必查），没有熔断就是一个
 * 拒绝服务放大器：上游越慢、积压越深。这里是经典的三态开关——连续 N 次失败转
 * open 并冷却 M 秒，冷却过后 half-open 只放行一次探测，探测成功才恢复。纯内存、
 * 进程内单例（由 createKnowledgeRuntime 创建，中间件与工具共享），多副本部署下
 * 各自熔断，可接受：保护的是上游而不是全局配额。
 *
 * 时钟可注入，测试不必等真实冷却。
 */

export type KnowledgeCircuitState = "closed" | "open" | "half-open";

export type KnowledgeCircuit = {
  /** 是否放行本次调用。open 期一律 false；half-open 期仅放行 1 次探测。 */
  allow(): boolean;
  /** 计数清零，half-open 的探测成功后回到 closed。 */
  recordSuccess(): void;
  /** 连续失败达阈值则转 open 并重记冷却截止时间；half-open 探测失败同样由此回到 open。 */
  recordFailure(): void;
  state(): KnowledgeCircuitState;
};

/** 连续失败多少次熔断。A8：代码常量不做 env，需要运维调参时再提。 */
export const CIRCUIT_FAILURE_THRESHOLD = 3;
/** open 之后冷却多久才允许半开探测。 */
export const CIRCUIT_COOLDOWN_MS = 30_000;

export function createKnowledgeCircuit(options?: {
  failureThreshold?: number;
  cooldownMs?: number;
  /** 测试注入时钟，默认 Date.now。 */
  now?: () => number;
}): KnowledgeCircuit {
  const failureThreshold =
    options?.failureThreshold ?? CIRCUIT_FAILURE_THRESHOLD;
  const cooldownMs = options?.cooldownMs ?? CIRCUIT_COOLDOWN_MS;
  const now = options?.now ?? Date.now;

  let failures = 0;
  let cooldownUntil = 0;
  // half-open 期探测是否在途：放行一次之后、结果回来之前，其余调用仍被拒。
  let probing = false;

  return {
    allow() {
      if (failures < failureThreshold) return true; // closed
      if (now() < cooldownUntil) return false; // open：冷却未过
      if (probing) return false; // half-open：探测已在途
      probing = true;
      return true; // half-open：放行唯一一次探测
    },
    recordSuccess() {
      failures = 0;
      cooldownUntil = 0;
      probing = false;
    },
    recordFailure() {
      failures += 1;
      if (failures >= failureThreshold) {
        // open（或 half-open 探测失败重新 open）：重记冷却窗口，探测位复位。
        cooldownUntil = now() + cooldownMs;
        probing = false;
      }
    },
    state() {
      if (failures < failureThreshold) return "closed";
      return now() < cooldownUntil ? "open" : "half-open";
    },
  };
}
