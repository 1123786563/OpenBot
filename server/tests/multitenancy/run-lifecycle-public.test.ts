// server/tests/multitenancy/run-lifecycle-public.test.ts
// MOD07（Issue #627，根 #620）：M05 RunLifecycle 门面的委托等价与行为钉。
//
// 事实源（Issue #627 验收 + MOD07 Brief §D，逐条对应 describe）：
//   D1 委托等价：门面五能力 vs 直调内件——同参（对象同一性）、同结果
//      （toBe 同一实例）、同错误实例透传（注入替身证明委托本身）+ 生产组合
//      恒注入门面、runner admit 双路的源级钉（缺省回退内件，存量直构测试
//      不破；MOD06 routes 双路先例）。
//   D2 验收① 幂等与固定归属：同一 clientMessageKey 同线程仅一份（advisory
//      lock + RUN_IDEMPOTENCY_CONFLICT 源级钉）、活动运行冲突、过期租约同
//      事务真终态回收；Run/Attempt/generation 全部服务端铸造（randomUUID/
//      generation = 1 源级钉），StartRunInput 无客户端身份字段；Bot 版本与
//      路由 ref 在事务内解析并核对（EXPERT_AGENT_MISMATCH/RUN_ROUTE_MISMATCH）。
//   D3 验收② 旧 lease/generation 拒写与取消-完成竞争：stop 的 generation/
//      attempt 栅栏（RUN_ATTEMPT_STALE）、终态先到者赢（cancel 对终态行原样
//      返回；transitionTerminal 对非活动状态返回 false）、条件 UPDATE 并发
//      冲突（RUN_STATE_CONFLICT）与尝试竞争（RUN_ATTEMPT_TERMINAL_RACE）。
//   D4 验收③ Mastra 只执行准入事实、消息经 Conversation：runner 提交先经
//      M04 单写者 append，admission 的 expertVersionRef/routeRef 由服务端
//      组合签发；carrier 的 executionBinding 在 bind 时铸造（admission 时
//      不存在，未绑定即拒）；copilot 只把 server-issued facts 交给
//      executeGovernedMastra；M05 门面/臂结构性不含引擎执行细节。
//   D5 验收④⑤ 断线 vs 主动取消维持、零新 durable workflow 权威、目标消费者
//      完成迁移：断线 finalize 以 MODEL_EXECUTION_FAILED 失败结算（超时取消
//      仅作回退）、用户停止经 user_requested 代次栅栏；门面对象恰五能力、
//      worker/engine 面结构性缺席；具名臂唯一值导出且逐字节转发内件工厂；
//      三个 carrier 装配点全部改经臂、零直接内件调用；runner 组合恒注入门面
//      且 admit 经门面（非仅换出口文件）。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生
// 收集（覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库：委托语义
// 用注入替身证明（门面只做委托，替身证明的正是委托本身）；幂等/栅栏/竞争
// 事务语义以源级结构断言钉住形状，真实 PG/RLS 行为由存量套件两树 BASE 对照
// 钉住（reports/MOD07-report.md §验证门；MOD04/05/06 同法）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type {
  EventService,
  PlatformScope,
  RunDTO,
  RunService,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import type { ExpertVersionRef } from "../../src/enterprise/experts/version-catalog";
import {
  type ActiveThreadRunState,
  createRunLifecyclePublic,
  type RunLifecyclePublic,
  type RunLifecyclePublicDeps,
  type RunLifecycleScope,
  type TrustedRunLifecycleAdmission,
} from "../../src/enterprise/runs/public";
import {
  createProductionRunner,
  type ProductionRunnerDependencies,
} from "../../src/enterprise/runs/runner";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** 剥掉 // 行注释与块注释后的源码（结构断言不被注释文本干扰）。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SCOPE: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "team-a1",
  principalId: "principal-a",
  actorId: "user-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

const RUN_DTO: RunDTO = {
  run_id: "run-server",
  thread_id: "thread-server",
  status: "queued",
  created_at: "1970-01-01T00:00:00.000Z",
  updated_at: "1970-01-01T00:00:00.000Z",
};
const ACTIVE_STATE: ActiveThreadRunState = {
  run: RUN_DTO,
  attemptId: "attempt-server",
  generation: 1,
};
/**
 * M-1（r2）：ExpertVersionRef 是品牌型（`string & { __brand }`）——直接写字面量
 * 不可赋值（TS2322）。按内件签发的构造方式显式断言，测试替身才与契约同型。
 */
const EXPERT_VERSION_REF = "expert:v1:stub-server-ref" as ExpertVersionRef;
/** 准入路由 ref（门面夹具的 modelRoutes.put 桩签发值）。 */
const STUB_ROUTE_REF = "route-ref-server";

const ADMISSION: TrustedRunAdmission = {
  input: {
    threadId: "thread-server",
    clientMessageKey: "key-server",
    messageDigest: "digest-server",
    attachmentRefs: [],
    entrypoint: "web",
    forwardedProps: {},
  },
  agentId: "bot-a",
  expertVersionRef: EXPERT_VERSION_REF,
  routeRef: STUB_ROUTE_REF,
};

/** 五能力录音替身：记录每次调用的实参（对象同一性）并返回稳定实例。 */
function recordingRuns() {
  const calls: Array<{ capability: string; args: unknown[] }> = [];
  const runs = {
    start: async (scope: unknown, admission: unknown) => {
      calls.push({ capability: "start", args: [scope, admission] });
      return RUN_DTO;
    },
    get: async (scope: unknown, runId: unknown) => {
      calls.push({ capability: "get", args: [scope, runId] });
      return RUN_DTO;
    },
    getActiveForThread: async (scope: unknown, threadId: unknown) => {
      calls.push({ capability: "getActiveForThread", args: [scope, threadId] });
      return ACTIVE_STATE;
    },
    cancel: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "cancel", args: [scope, input] });
      return RUN_DTO;
    },
    stop: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "stop", args: [scope, input] });
      return RUN_DTO;
    },
  };
  return { calls, runs };
}

/**
 * M-2（r2）：可绿跑的 admit 链夹具（无 DB、无引擎、无供应商）。
 *
 * 构造完整的 ProductionRunnerDependencies，`facade: true` 时 `runLifecycle` 注入
 * **真实** createRunLifecyclePublic（内件 = 记录型 RunService 桩，五能力前面的
 * start 额外包一层只做记录的包装，其余四能力原样来自真实门面）；`facade: false`
 * 时不注入 runLifecycle，走直构回退臂。未提供治理协作者 ⇒ carrier=null ⇒ 链在
 * 既有 no-model 拒执路径上结算（RUN_STARTED → RUN_ERROR），整条链不触数据库。
 */
function admitFixture(options: { facade: boolean }) {
  const resolvedScope: PlatformScope = { ...SCOPE };
  const started: Array<{
    scope: PlatformScope;
    admission: TrustedRunAdmission;
  }> = [];
  const facadeStarted: Array<{
    scope: RunLifecycleScope;
    admission: TrustedRunLifecycleAdmission;
  }> = [];
  let leaseSeed = 0;
  let eventSeq = 0;
  const unused = () => {
    throw new Error("UNUSED_CAPABILITY_IN_ADMIT_FIXTURE");
  };
  const runs: RunService = {
    async start(scope, admission) {
      started.push({ scope, admission });
      return RUN_DTO;
    },
    async getActiveForThread() {
      return null;
    },
    async cancel() {
      return RUN_DTO;
    },
    async stop() {
      return RUN_DTO;
    },
    async acquireRequestLease() {
      leaseSeed += 1;
      return {
        runId: RUN_DTO.run_id,
        attemptId: `attempt-${leaseSeed}`,
        generation: 1,
        ownerToken: `owner-${leaseSeed}`,
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    async releaseRequestLease() {
      return true;
    },
    async fail() {
      return true;
    },
    async get() {
      return unused();
    },
    async renewRequestLease() {
      return unused();
    },
    async complete() {
      return unused();
    },
    async getActiveAttemptGeneration() {
      return unused();
    },
    async markRunSuspended() {
      return unused();
    },
    async reactivateSuspensionLease() {
      return unused();
    },
    async reserveModelBudget() {
      return unused();
    },
    async issueModelInvocationCapability() {
      return unused();
    },
    async resolveModelInvocationCapability() {
      return unused();
    },
    async confirmModelInvocationUsage() {
      return unused();
    },
    async markModelInvocationUnknown() {
      return unused();
    },
    async releaseModelInvocation() {
      return unused();
    },
  };
  const events: EventService = {
    async append() {
      eventSeq += 1;
      return { eventId: `event-${eventSeq}`, seq: eventSeq, duplicate: false };
    },
    async replay() {
      return unused();
    },
    // AsyncIterable 面（非 Promise）：非 async 的抛出函数返回 never，可赋值。
    subscribe() {
      return unused();
    },
  };
  const facade = createRunLifecyclePublic({ runs });
  const recordingFacade: RunLifecyclePublic = {
    ...facade,
    start(scope, admission) {
      facadeStarted.push({ scope, admission });
      return facade.start(scope, admission);
    },
  };
  const deps: ProductionRunnerDependencies = {
    scopeResolver: {
      async resolve() {
        return resolvedScope;
      },
      async resolveForThread() {
        return resolvedScope;
      },
    },
    conversations: {
      async append() {
        return {};
      },
    } as never,
    runs,
    events,
    expertVersions: {
      async putOrGet() {
        return EXPERT_VERSION_REF;
      },
    } as never,
    modelRoutes: {
      async put() {
        return { routeRef: STUB_ROUTE_REF } as never;
      },
      async get() {
        return null;
      },
    } as never,
    resolveBuiltInBotForActor: async (_actor, agentId) => ({
      agent: {} as AbstractAgent,
      definitionFacts: {
        agentId,
        source: "tenant_package",
        systemPrompt: "Admit-chain fixture Bot instructions.",
      },
    }),
    identifyActor: async () => ({ id: resolvedScope.actorId, role: "user" }),
    modelSelection: () => ({
      route: {
        model: { provider: "openai", defaultModel: "stub-model" },
        credentialSecretRef: "credential-stub",
      },
    }),
    ...(options.facade ? { runLifecycle: recordingFacade } : {}),
  };
  const runner = createProductionRunner(deps)(
    new Request("http://localhost/api/copilotkit/agent/bot-a/run"),
  );
  return { started, facadeStarted, resolvedScope, runner };
}

/** 驱动 admit 链到完成：订阅 runner 的流并收集事件。 */
async function admitEvents(
  fixture: ReturnType<typeof admitFixture>,
): Promise<BaseEvent[]> {
  const stream = fixture.runner.run({
    threadId: "thread-server",
    agent: { agentId: "bot-a" },
    input: {
      threadId: "thread-server",
      runId: "client-run-1",
      messages: [{ id: "key-server", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: { maxOutputTokens: 1024 },
    },
  } as never);
  return firstValueFrom(stream.pipe(toArray()));
}

// ---------------------------------------------------------------------------
// D1 委托等价
// ---------------------------------------------------------------------------

describe("MOD07 D1: facade delegates to the internal service verbatim", () => {
  test("start passes the identical (scope, admission) objects through and returns the very DTO", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const result = await lifecycle.start(SCOPE, ADMISSION);
    expect(result).toBe(RUN_DTO);
    expect(calls[0]?.capability).toBe("start");
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe(ADMISSION);
  });

  test("get passes the identical (scope, runId) through and returns the very DTO", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const result = await lifecycle.get(SCOPE, "run-server");
    expect(result).toBe(RUN_DTO);
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe("run-server");
  });

  test("getActiveForThread passes the identical thread id through and returns the very state", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const result = await lifecycle.getActiveForThread(SCOPE, "thread-server");
    expect(result).toBe(ACTIVE_STATE);
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe("thread-server");
  });

  test("cancel passes the identical input object through", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const input = { runId: "run-server", reason: "timeout" as const };
    const result = await lifecycle.cancel(SCOPE, input);
    expect(result).toBe(RUN_DTO);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("stop passes the identical fenced input object through", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const input = {
      runId: "run-server",
      reason: "user_requested" as const,
      attemptId: "attempt-server",
      generation: 1,
    };
    const result = await lifecycle.stop(SCOPE, input);
    expect(result).toBe(RUN_DTO);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("every capability propagates the internal error as the SAME instance", async () => {
    const boom = new Error("INTERNAL_MARK");
    const runs = {
      start: async () => {
        throw boom;
      },
      get: async () => {
        throw boom;
      },
      getActiveForThread: async () => {
        throw boom;
      },
      cancel: async () => {
        throw boom;
      },
      stop: async () => {
        throw boom;
      },
    };
    const lifecycle = createRunLifecyclePublic({ runs });
    for (const capability of [
      "start",
      "get",
      "getActiveForThread",
      "cancel",
      "stop",
    ] as const) {
      let caught: unknown = null;
      try {
        await lifecycle[capability](SCOPE, {} as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(boom);
    }
  });

  test("the facade performs zero transformation — no mapping/projection/caching statements", () => {
    const code = codeOf("../../src/enterprise/runs/public.ts");
    expect(code).not.toMatch(
      /\.map\(|\.filter\(|JSON\.parse|new Map|new WeakMap/,
    );
    expect(code).not.toMatch(/\blet\s|cache/i);
    // 五能力体全部是 `return runs.<capability>(...)` 单语句。
    expect(code.match(/return runs\./g)?.length).toBe(5);
  });

  test("source pin: the production composition always injects the facade and admit takes the dual path", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    // 生产组合恒注入（生产链恒走门面）。
    expect(runner).toContain(
      "runLifecycle: createRunLifecyclePublic({ runs }),",
    );
    // admit 双路：注入时经门面，直构存量调用方缺省回退内件——两臂同参同结果。
    expect(runner).toContain(
      "() => (deps.runLifecycle ?? deps.runs).start(scope, admission),",
    );
  });

  test("the extracted facade types are the very M02 contract shapes (compile-level equivalence)", () => {
    const toPlatform = (scope: RunLifecycleScope): PlatformScope => scope;
    const toLifecycle = (scope: PlatformScope): RunLifecycleScope => scope;
    const toAdmission = (
      admission: TrustedRunLifecycleAdmission,
    ): TrustedRunAdmission => admission;
    const toLifecycleAdmission = (
      admission: TrustedRunAdmission,
    ): TrustedRunLifecycleAdmission => admission;
    expect(toPlatform(SCOPE)).toBe(SCOPE);
    expect(toLifecycle(SCOPE)).toBe(SCOPE);
    expect(toAdmission(ADMISSION)).toBe(ADMISSION);
    expect(toLifecycleAdmission(ADMISSION)).toBe(ADMISSION);
  });

  test("behavior: the admit chain enters start through the injected facade with the identical (scope, admission) as the direct fallback arm", async () => {
    // M-2（r2）：runner-production 的 admit 用例全部直构 deps 走回退臂，组合
    // 用例只断言构造形状；本用例第一次以绿路径执行**门面注入臂**：真实
    // createRunLifecyclePublic 挂进 ProductionRunnerDependencies，驱动既有
    // admit 链到 start 调用点，并与直构回退臂逐项对照。
    const throughFacade = admitFixture({ facade: true });
    const facadeEvents = await admitEvents(throughFacade);
    const directFallback = admitFixture({ facade: false });
    const fallbackEvents = await admitEvents(directFallback);

    // 臂选择：注入时门面 start 被执行且只执行一次；直构时不经过门面。
    expect(throughFacade.facadeStarted).toHaveLength(1);
    expect(directFallback.facadeStarted).toHaveLength(0);
    // 两臂都把这次提交交给了同一个记录型内件。
    expect(throughFacade.started).toHaveLength(1);
    expect(directFallback.started).toHaveLength(1);

    const [viaFacade] = throughFacade.started;
    const [viaFallback] = directFallback.started;

    // 门面闭包收到的那一对对象就是随后原样转发给内件的同一对对象（无克隆）。
    expect(throughFacade.facadeStarted[0]?.scope).toBe(viaFacade?.scope);
    expect(throughFacade.facadeStarted[0]?.admission).toBe(
      viaFacade?.admission,
    );
    // 链上解析出的 scope 实例本身（对象同一性），不是重新拼装的副本。
    expect(viaFacade?.scope).toBe(throughFacade.resolvedScope);

    // 与直构回退臂同参：同一请求在两条臂上得到逐字段相同的 (scope, admission)。
    expect(viaFallback?.scope).toEqual(viaFacade?.scope);
    expect(viaFallback?.admission).toEqual(viaFacade?.admission);
    // 准入事实仍由服务端签发：ref 来自 catalog 桩，摘要由 runner 服务端铸造。
    expect(viaFacade?.admission.expertVersionRef).toBe(EXPERT_VERSION_REF);
    expect(viaFacade?.admission.routeRef).toBe(STUB_ROUTE_REF);
    expect(viaFacade?.admission.agentId).toBe("bot-a");
    expect(viaFacade?.admission.input.threadId).toBe("thread-server");
    expect(viaFacade?.admission.input.clientMessageKey).toBe("key-server");
    expect(viaFacade?.admission.input.messageDigest).not.toBe("");
    // 同结果：两条臂把同一份 run 交给同一后续链，事件序列与拒绝码一致。
    expect(facadeEvents.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);
    expect(fallbackEvents.map((event) => event.type)).toEqual(
      facadeEvents.map((event) => event.type),
    );
    expect((facadeEvents[1] as { code?: string }).code).toBe(
      (fallbackEvents[1] as { code?: string }).code,
    );
  });
});

// ---------------------------------------------------------------------------
// D2 验收①：提交幂等 + 固定归属，Run/Attempt/generation 非客户端选择
// ---------------------------------------------------------------------------

describe("MOD07 D2: idempotent submission with server-fixed ownership", () => {
  test("source pin: one run per (thread, clientMessageKey) under an advisory transaction lock", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    // 提交串行化：同 tenant/thread 的 start 在同一把 advisory 锁下。
    expect(store).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(store).toContain(
      '"enterprise-run-start", scope.tenantId, input.threadId',
    );
    // 同键第二次提交 = 冲突，不产生第二份 Run。
    expect(store).toContain("RUN_IDEMPOTENCY_CONFLICT");
    expect(store).toMatch(
      /if \(priorSubmission\) \{\s*throw new RunDomainError\(\s*"RUN_IDEMPOTENCY_CONFLICT"/s,
    );
    // 线程已有活动运行时拒绝；租约过期的活动行在同事务真终态回收后再接纳。
    expect(store).toContain("ACTIVE_RUN_CONFLICT");
    expect(store).toMatch(
      /existing\.leaseExpiresAt\.getTime\(\) > now\.getTime\(\)[\s\S]*?ACTIVE_RUN_CONFLICT/s,
    );
  });

  test("source pin: Run/Attempt/generation are minted server-side — randomUUID and generation 1", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain("const runId = randomUUID();");
    expect(store).toContain("const attemptId = randomUUID();");
    expect(store).toContain("const generation = 1;");
    // 客户端 wire 输入没有运行身份字段——Run/Attempt/generation 无从选择。
    const contracts = sourceOf("../../src/enterprise/contracts.ts");
    const startBlock = contracts.slice(
      contracts.indexOf("export interface StartRunInput"),
      contracts.indexOf("export interface TrustedRunAdmission"),
    );
    expect(startBlock).toContain("readonly clientMessageKey: string;");
    // L-1（r2）：收窄到字段声明行——切片内其他文本提到 runId 等词不再误红。
    expect(startBlock).not.toMatch(
      /^\s*readonly\s+(runId|attemptId|generation)\b/m,
    );
    // 准入的两个 ref 是服务端组合独立签发，不是客户端 wire 字段。
    const admissionBlock = contracts.slice(
      contracts.indexOf("Server-only Run admission input"),
      contracts.indexOf("export interface CancelRunInput"),
    );
    expect(admissionBlock).toContain(
      "readonly expertVersionRef: ExpertVersionRef;",
    );
    expect(admissionBlock).toContain("readonly routeRef: string;");
    expect(admissionBlock).toContain("Neither ref is a client wire field.");
  });

  test("source pin: Bot version and route ref are resolved and checked inside the run transaction", () => {
    const service = codeOf("../../src/enterprise/runs/service.ts");
    expect(service).toContain("validateStart(scope, input);");
    expect(service).toContain("store.transaction(scope, async (tx) => {");
    expect(service).toContain("deps.expertVersions.resolveInTransaction(");
    expect(service).toContain("EXPERT_VERSION_NOT_FOUND");
    expect(service).toContain("EXPERT_AGENT_MISMATCH");
    // 准入路由必须是请求绑定生产者刚铸造的同一 ref（客户端不可指定）。
    expect(service).toContain("admission.routeRef !== route.routeRef");
    expect(service).toContain("RUN_ROUTE_MISMATCH");
    // 预算预留以 run 的固定幂等键写入同一事务。
    expect(service).toContain("runCeilingIdempotencyKey(created.runId)");
  });

  test("source pin: the facade's start is a single unconditional delegation — no local admission or retry", () => {
    const code = codeOf("../../src/enterprise/runs/public.ts");
    expect(code).toMatch(
      /start\(scope: RunLifecycleScope, admission: TrustedRunLifecycleAdmission\) \{\s*return runs\.start\(scope, admission\);/,
    );
    expect(code).not.toMatch(/for\s*\(|while\s*\(|retry/i);
  });

  test("source pin: the mastra-backend submission must be finalized with the server digest", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain("RUN_INPUT_NOT_FOUND");
    expect(store).toContain("RUN_INPUT_NOT_FINALIZED");
    expect(store).toContain("validateMastraRunIntent(intent, {");
    expect(store).toContain("RUN_ATTACHMENT_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// D3 验收②：旧 lease/generation 拒写；取消与完成竞争确定
// ---------------------------------------------------------------------------

describe("MOD07 D3: stale leases cannot write; cancel/complete races settle once", () => {
  test("source pin: stop validates its fenced tuple and hands the attempt generation to the store", () => {
    const service = codeOf("../../src/enterprise/runs/service.ts");
    expect(service).toContain("validateStopInput(input);");
    expect(service).toMatch(
      /return store\.cancel\(\s*scope,\s*input\.runId,[\s\S]*?\{ attemptId: input\.attemptId, generation: input\.generation \},/s,
    );
  });

  test("source pin: the store refuses stale attempt/generation fences with RUN_ATTEMPT_STALE", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain(
      "row.attemptGeneration !== expectedAttempt.generation",
    );
    expect(store).toMatch(
      /if \(!attempt\) throw new RunDomainError\("RUN_ATTEMPT_STALE", 409\);/,
    );
  });

  test("source pin: the first terminal wins — cancel on a terminal row returns it unchanged", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    expect(store).toContain(
      'if (["succeeded", "failed", "cancelled"].includes(row.status))',
    );
    // 终态竞争由条件 UPDATE 收口：状态集合 + generation 同时匹配，否则冲突。
    expect(store).toContain("RUN_STATE_CONFLICT");
    expect(store).toMatch(
      /eq\(enterpriseRuns\.attemptGeneration, row\.attemptGeneration\),\s*sql`\$\{enterpriseRuns\.status\} in \('queued', 'running', 'waiting_approval', 'suspended'\)`/,
    );
  });

  test("source pin: complete/fail settle only under the exact lease and generation (false = refused)", () => {
    const store = codeOf("../../src/enterprise/runs/store.ts");
    // 运行 generation 与 lease generation 必须同一；否则 false（不写）。
    expect(store).toContain(
      "if (!run || run.attemptGeneration !== input.generation) return false;",
    );
    expect(store).toContain("isCurrentRunLeaseSnapshot(");
    // 尝试在结算期间被替换：掷出命名竞争错误，不静默覆盖。
    expect(store).toContain("RUN_ATTEMPT_TERMINAL_RACE");
    // 服务层：失败/完成都必须携带完整且未过期的租约。
    const service = codeOf("../../src/enterprise/runs/service.ts");
    expect(service).toContain("validateRunFailureInput(input);");
    expect(service).toContain("validateRunSuccessInput(input);");
    expect(service).toContain("INVALID_RUN_FAILURE_INPUT");
    expect(service).toContain("INVALID_RUN_SUCCESS_INPUT");
  });

  test("source pin: the facade adds no fencing policy of its own — the internal validation stays authoritative", () => {
    const code = codeOf("../../src/enterprise/runs/public.ts");
    expect(code).not.toContain("RUN_ATTEMPT_STALE");
    expect(code).not.toContain("validateStopInput");
    expect(code).not.toContain("attemptId");
    expect(code).not.toContain("generation");
    // 输入形状经内件 stop 签名提取（StopRunLifecycleInput），不重新声明。
    expect(code).toMatch(
      /export type StopRunLifecycleInput = Parameters<\s*InternalRunService\["stop"\]\s*>\[1\];/,
    );
  });

  test("behavior: cancel and stop reach the internal service with the caller's own input", async () => {
    const { runs, calls } = recordingRuns();
    const lifecycle = createRunLifecyclePublic({ runs });
    const cancelInput = { runId: "run-server", reason: "superseded" as const };
    const stopInput = {
      runId: "run-server",
      reason: "user_requested" as const,
      attemptId: "attempt-server",
      generation: 7,
    };
    await lifecycle.cancel(SCOPE, cancelInput);
    await lifecycle.stop(SCOPE, stopInput);
    expect(calls[0]?.args[1]).toBe(cancelInput);
    expect(calls[1]?.args[1]).toBe(stopInput);
  });
});

// ---------------------------------------------------------------------------
// D4 验收③：Mastra 只执行准入事实；消息经 Conversation 写入
// ---------------------------------------------------------------------------

describe("MOD07 D4: the engine executes admitted facts only; messages go through Conversation", () => {
  test("source pin: the submission is appended through the M04 single writer before admission", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    expect(runner).toContain("deps.conversations.append(scope, {");
    expect(runner).toContain(
      "const { digest } = messageDigest(content, attachments);",
    );
    // 消息之后才建立准入；admission 携带服务端签发的 ref 与摘要。
    expect(runner.indexOf("deps.conversations.append(scope, {")).toBeLessThan(
      runner.indexOf("const admission: TrustedRunAdmission = {"),
    );
    // runner 不直写会话/引擎存储（单写者保持）。
    expect(runner).not.toContain("saveMessages");
    expect(runner).not.toContain("enterprise_messages");
    expect(runner).not.toContain("mastraMessageIntents");
  });

  test("source pin: M04's outlet is the injected conversation face (type-level injection)", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    expect(runner).toContain("readonly conversations: ConversationService;");
    // M04 公开出口就位（门面存在；append 是五能力之一）——M05 经该 Interface 消费。
    const conversations = codeOf(
      "../../src/enterprise/conversations/public.ts",
    );
    expect(conversations).toContain(
      "export function createConversationPublic(",
    );
    expect(conversations).toContain("appendEngineMessage");
    const contracts = codeOf("../../src/enterprise/contracts.ts");
    expect(contracts).toContain("export interface ConversationService {");
  });

  test("source pin: the execution identity is minted at bind, never at admission (unbound fails closed)", () => {
    const governed = sourceOf(
      "../../src/enterprise/runs/governed-execution.ts",
    );
    expect(governed).toContain("let executionKey: string | undefined;");
    expect(governed).toContain("Minted");
    expect(governed).toContain("at bind (not admission)");
    expect(governed).toContain("GOVERNED_EXECUTION_UNBOUND");
    // capability 必须与本次准入逐字段一致：scope/run/attempt/generation/route/ceiling。
    expect(governed).toContain("MODEL_INVOCATION_BINDING_MISMATCH");
    expect(governed).toContain("context.runId !== binding.runId");
    expect(governed).toContain("context.generation !== binding.generation");
    expect(governed).toContain("context.maximumTokens > deps.ceiling");
  });

  test("source pin: the engine is handed the carrier's server-issued facts, not client selectors", () => {
    const copilot = codeOf("../../src/copilot.ts");
    expect(copilot).toContain(
      "const facts = governedModel.executionBinding?.();",
    );
    expect(copilot).toContain("executeGovernedMastra({");
    expect(copilot.indexOf("executionBinding?.()")).toBeLessThan(
      copilot.indexOf("executeGovernedMastra({"),
    );
  });

  test("source pin: engine execution details stay off the M05 public face and named arm", () => {
    for (const file of [
      "../../src/enterprise/runs/public.ts",
      "../../src/enterprise/runs/integration.ts",
    ]) {
      const code = codeOf(file);
      expect(code).not.toMatch(
        /executeGovernedMastra|ExecuteMastra|ExecutionBinding/,
      );
      expect(code).not.toMatch(/from "\.\.\/mastra|from "\.\.\/\.\.\/mastra/);
    }
    const publicCode = codeOf("../../src/enterprise/runs/public.ts");
    expect(publicCode).not.toMatch(/governed|capability|lease|suspension/i);
  });
});

// ---------------------------------------------------------------------------
// D5 验收④⑤：断线与主动取消维持；零新 durable workflow；消费者已迁移
// ---------------------------------------------------------------------------

describe("MOD07 D5: disconnect vs stop preserved; no new workflow authority; consumers migrated", () => {
  test("source pin: a disconnected stream settles as failure first, timeout-cancel only as the fallback", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    const finalize = runner.slice(runner.indexOf("private finalizeRun("));
    expect(finalize).toContain("MODEL_EXECUTION_FAILED");
    expect(finalize).toMatch(
      /\.fail\(scope, \{ lease, errorCode: "MODEL_EXECUTION_FAILED" \}\)[\s\S]*?\.cancel\(scope, \{ runId: state\.runId, reason: "timeout" \}\)/,
    );
  });

  test("source pin: an explicit user stop stays a fenced user_requested cancellation", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    expect(runner).toMatch(
      /await this\.deps\.runs\.stop\(scope, \{\s*runId: active\.run\.run_id,\s*reason: "user_requested",\s*attemptId: active\.attemptId,\s*generation: active\.generation,\s*\}\)/s,
    );
    // 旧代次的停止是安静 no-op（结构化 stale 码），其它错误照常上抛。
    expect(runner).toContain(
      'if (error instanceof RunDomainError && error.code === "RUN_ATTEMPT_STALE")',
    );
  });

  test("zero new durable workflow authority: the facade and arm persist nothing and import no storage", () => {
    for (const file of [
      "../../src/enterprise/runs/public.ts",
      "../../src/enterprise/runs/integration.ts",
    ]) {
      const code = codeOf(file);
      expect(code).not.toMatch(
        /\.insert\(|\.update\(|\.delete\(|\.transaction\(/,
      );
      expect(code).not.toMatch(/outbox|drizzle|db\/schema|randomUUID/);
    }
    // 组内唯一 import：门面只提取内件签名，臂只转发内件工厂。
    const specifiers = (file: string) =>
      [...sourceOf(file).matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    expect(specifiers("../../src/enterprise/runs/public.ts")).toEqual([
      "./service",
    ]);
    expect(specifiers("../../src/enterprise/runs/integration.ts")).toEqual([
      "./governed-execution",
    ]);
  });

  test("the facade object surface is exactly the five business capabilities", () => {
    const lifecycle = createRunLifecyclePublic({
      runs: recordingRuns().runs,
    });
    expect(Object.keys(lifecycle).sort()).toEqual([
      "cancel",
      "get",
      "getActiveForThread",
      "start",
      "stop",
    ]);
    // worker/engine 面结构性缺席（模块目录 M05：领取/续约/complete/fail/
    // capability issue 等进入内部 Interface，不向浏览器开放）。
    const asRecord = lifecycle as unknown as Record<string, unknown>;
    for (const hidden of [
      "acquireRequestLease",
      "renewRequestLease",
      "releaseRequestLease",
      "complete",
      "fail",
      "issueModelInvocationCapability",
      "resolveModelInvocationCapability",
      "confirmModelInvocationUsage",
      "markModelInvocationUnknown",
      "releaseModelInvocation",
      "reserveModelBudget",
      "getActiveAttemptGeneration",
      "markRunSuspended",
      "reactivateSuspensionLease",
      "disposeUnresumableSuspensions",
    ]) {
      expect(asRecord[hidden]).toBeUndefined();
    }
  });

  test("integration.ts is the single named arm: one value export, byte-for-byte forwarding", async () => {
    const module = await import("../../src/enterprise/runs/integration");
    expect(Object.keys(module).sort()).toEqual(["createGovernedExecutionArm"]);
    const code = codeOf("../../src/enterprise/runs/integration.ts");
    expect(code).not.toContain("export *");
    expect(code).toMatch(/return createGovernedModelExecution\(input\);/);
    expect(code).not.toMatch(
      /new |process\.env|BOT_MODEL|BOT_PROVIDER|\?\?|await /,
    );
  });

  test("acceptance 5: every carrier assembly site goes through the named arm — zero direct internal calls outside M05", () => {
    for (const file of [
      "../../src/enterprise/runs/runner.ts",
      "../../src/assembly/runtime.ts",
    ]) {
      const code = codeOf(file);
      expect(code).toContain("createGovernedExecutionArm({");
      expect(code).not.toContain("createGovernedModelExecution(");
    }
    // 浏览器路径 1 处 + headless 治理回合 + 续跑回路 = 3 处。
    expect(
      codeOf("../../src/enterprise/runs/runner.ts").match(
        /createGovernedExecutionArm\(\{/g,
      )?.length,
    ).toBe(1);
    expect(
      codeOf("../../src/assembly/runtime.ts").match(
        /createGovernedExecutionArm\(\{/g,
      )?.length,
    ).toBe(2);
  });

  test("acceptance 5: the migrated consumer is the chat-submit chain, not merely a renamed export", () => {
    const runner = codeOf("../../src/enterprise/runs/runner.ts");
    // 门面在组合内构造并注入——生产链恒经门面。
    expect(runner).toContain("createRunLifecyclePublic({ runs })");
    // admit 提交点经门面（缺省回退只为存量直构调用方）。
    expect(runner).toContain(
      "(deps.runLifecycle ?? deps.runs).start(scope, admission)",
    );
    // 门面不是 re-export 壳：public.ts 自带五能力实现，且只 import 内件类型。
    const publicCode = codeOf("../../src/enterprise/runs/public.ts");
    expect(publicCode).not.toMatch(/export \* from|export \{/);
    expect(publicCode).toContain("export function createRunLifecyclePublic(");
    expect(publicCode).toContain("export interface RunLifecyclePublic {");
  });

  test("module-imports.json keeps the M05 grouping this facade relies on", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../tests/config/module-imports.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      moduleRoots: Array<{ path: string; module: string; kind: string }>;
    };
    const byPath = new Map(config.moduleRoots.map((root) => [root.path, root]));
    expect(byPath.get("server/src/enterprise/runs")?.module).toBe("M05");
    expect(byPath.get("server/src/mastra")?.module).toBe("M05");
  });

  test("the deps face is exactly the five business capabilities — proven by the direct tsc gate on this file", () => {
    // M-1（r2）：本文件经 `tsc --noEmit --strict` 直查（brief 门禁），因此下面
    // 的运行时构造与类型级断言都是真编译证据：一个只有五能力、没有任何
    // worker/engine 面（acquireRequestLease/complete/fail/... 皆无）的对象就能
    // 构造门面——依赖面不是完整内件服务。
    const onlyFive = {
      async start() {
        return RUN_DTO;
      },
      async get() {
        return RUN_DTO;
      },
      async getActiveForThread() {
        return null;
      },
      async cancel() {
        return RUN_DTO;
      },
      async stop() {
        return RUN_DTO;
      },
    };
    const lifecycle = createRunLifecyclePublic({ runs: onlyFive });
    expect(Object.keys(lifecycle).sort()).toEqual([
      "cancel",
      "get",
      "getActiveForThread",
      "start",
      "stop",
    ]);
    // 依赖面键集恰为五能力：多一个或少一个都会让这行编译失败。
    type Exactly<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    const exactlyFive: Exactly<
      keyof RunLifecyclePublicDeps["runs"],
      "start" | "get" | "getActiveForThread" | "cancel" | "stop"
    > = true;
    expect(exactlyFive).toBe(true);
    // 负向：单能力 stub 不构成 deps 面（缺 get/getActiveForThread/cancel/stop）。
    type StartOnly = { start: () => Promise<RunDTO> };
    const startOnlyIsNotAFace: StartOnly extends RunLifecyclePublicDeps["runs"]
      ? false
      : true = true;
    expect(startOnlyIsNotAFace).toBe(true);
  });
});
