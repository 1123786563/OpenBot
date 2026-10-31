// server/tests/multitenancy/observability-observer-public.test.ts
// MOD17（Issue #637，根 #620）：M11 Observability observer 接入门面
// （ai-observability/public.ts）的迁移等价与五条验收的现状钉。
//
// 事实源（Issue #637 验收 + MOD17 Brief §1.C，逐条对应 describe）：
//   D1 委托/移动等价：门面 observer vs 原装配闭包（:7383/:7444 逐字段搬迁的
//      oracle 在本文件内联复刻）——同参（对象同一性）、同观察（toEqual 深等）、
//      同错误实例透传（注入替身证明门面零包含）、observationEnabled 只读透传、
//      最小 sink（Pick<"record">）可用。
//   D2 验收①观察归属=服务器真实 Run/Attempt：copilot.ts 的 fact 只在服务端构造
//      （scope=currentRunObservationScope() ambient 读、trace=currentTraceContext()，
//      cell 开闸时捕获）；fact 构造切片零 wire 标识符（req/body/query/headers/client）；
//      门面侧 scope 只出自 fact.scope（零 ambient 读、零发明）。
//   D3 验收②关闭/故障不影响执行+队列有界：装配仅 observationEnabled 时注册（源级
//      钉）；未注册=零捕获（observer undefined 早退，源级钉）；观察故障被 copilot
//      try/catch 包含（"Observation never takes the product path down."）而门面自身
//      零包含（行为钉）；行为钉=真实 recorder+health 有界队列链路（容量 1、挂起
//      port、第三笔 dropped_full 计数、observe 调用亚 50ms 返回）。
//   D4 验收③强制审计独立：src/audit.ts 零观测 import；门面零 audit 面；M11 自身
//      审计 await recordAuditEvent 直写（不经 observer 队列）；copilot 观察包含块内
//      零 modelBillingAudit（审计不降 best effort）。
//   D5 验收④查询/导出按当前权限：admin-summary 授权先行（manage gate→ownership→
//      新铸 scope）、请求只贡献 timeFrom/timeTo/botId 过滤；runs 查询 scope 键控
//      （bindCursor/cacheKey，转移/撤权即失效）；exports 请求零贡献+撤权走
//      cancelForActor 控制面。
//   D6 验收⑤负向：门面 import 面=恰 4 个组内模块、零运行时依赖；export 面=恰
//      3 能力+4 类型；零 Hono/路由/db schema/队列复制；迁移臂后全仓对门面的引用
//      =runtime.ts import+两注册（零新存储/页面/挂载）。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库/网络：委托语义用
// 注入替身证明；行为级队列语义用真实内件+注入 port 证明；跨模块边界与权限语义
// 以源级结构断言钉住形状，真实 PG/RLS、Opik 传输与脱敏行为由存量 opik 套件
// 两树 BASE 对照钉住（证据见 reports/MOD17-report.md §5，Brief §1.C 第 7 项）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { ObservationScope } from "../../src/ai-observability/contracts";
import { createOpikHealthService } from "../../src/ai-observability/health";
import { createModelSpanRecorder } from "../../src/ai-observability/model-span";
import type { OpikPort } from "../../src/ai-observability/opik-port";
import {
  type BuiltinModelSpanFact,
  type BuiltinToolStepFact,
  type ModelSpanObserverSink,
  modelSpanObserver,
  observationEnabled,
  type ToolStepObserverSink,
  toolStepObserver,
} from "../../src/ai-observability/public";

// ---------------------------------------------------------------------------
// 工具（MOD10 先例：源级结构断言不被注释文本干扰）
// ---------------------------------------------------------------------------

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** 剥掉 // 行注释与块注释后的源码。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 源码切片：从 `start` 起到 `end`（缺省切到尾）。 */
function sliceFrom(source: string, start: string, end?: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`anchor not found: ${start}`);
  if (end === undefined) return source.slice(from);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`end anchor not found: ${end}`);
  return source.slice(from, to);
}

// ---------------------------------------------------------------------------
// 替身与 oracle（D1；事实与观察的形状源头=内件签名，不新拟第二套）
// ---------------------------------------------------------------------------

type RecordedCall = { observation: unknown };

function recordingSink(): {
  sink: ModelSpanObserverSink;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sink: {
      record(observation: unknown) {
        calls.push({ observation });
      },
    },
  };
}

function recordingToolSink(): {
  sink: ToolStepObserverSink;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sink: {
      record(observation: unknown) {
        calls.push({ observation });
      },
    },
  };
}

/** MOD17 前装配闭包（runtime.ts :7383-7417）的逐字段复刻——D1 的等价 oracle。 */
function legacyModelSpanAdapter(fact: BuiltinModelSpanFact) {
  return {
    occurredAt: fact.startedAt,
    endedAt: fact.endedAt,
    provider: fact.provider,
    modelId: fact.modelId,
    ending: fact.ending,
    input: fact.input,
    output: fact.output,
    scope: fact.scope as ObservationScope | undefined,
    ...(fact.trace
      ? {
          trace: {
            traceId: fact.trace.traceId,
            parentSpanId: fact.trace.spanId,
          },
        }
      : {}),
  };
}

/** MOD17 前装配闭包（runtime.ts :7444-7482）的逐字段复刻。 */
function legacyToolStepAdapter(fact: BuiltinToolStepFact) {
  return {
    toolCallId: fact.toolCallId,
    toolName: fact.toolName ?? undefined,
    proposedAt: fact.proposedAt ?? undefined,
    endedAt: fact.endedAt,
    proposalObserved: fact.proposalObserved,
    executionObserved: fact.executionObserved,
    receiptObserved: fact.receiptObserved,
    execution: fact.execution,
    window: fact.window,
    input: fact.input,
    output: fact.output,
    scope: fact.scope as ObservationScope | undefined,
    ...(fact.trace
      ? {
          trace: {
            traceId: fact.trace.traceId,
            parentSpanId: fact.trace.spanId,
          },
        }
      : {}),
  };
}

const SCOPE: ObservationScope = {
  key: "actor=user-1;bot=bot-1;owner=actor;epoch=1",
} as unknown as ObservationScope;

const baseModelFact = (): BuiltinModelSpanFact => ({
  eventId: "evt-1",
  startedAt: new Date("2026-10-25T00:00:00.000Z"),
  endedAt: new Date("2026-10-25T00:00:02.000Z"),
  provider: "openai-compatible",
  modelId: "gpt-test",
  ending: { kind: "succeeded", inputTokens: 12, outputTokens: 34 },
  input: "prompt text",
  output: "answer text",
  scope: SCOPE,
  trace: {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
  },
});

const baseToolFact = (): BuiltinToolStepFact => ({
  toolCallId: "call-1",
  toolName: "web_search",
  proposedAt: new Date("2026-10-25T00:00:00.500Z"),
  endedAt: new Date("2026-10-25T00:00:03.000Z"),
  proposalObserved: true,
  executionObserved: true,
  receiptObserved: true,
  execution: { kind: "succeeded", output: "result text" },
  window: "terminal",
  scope: SCOPE,
  trace: {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
  },
  input: '{"query":"a"}',
  output: "result text",
});

// ---------------------------------------------------------------------------
// D1 委托/移动等价
// ---------------------------------------------------------------------------

describe("D1 门面委托/移动等价（Brief §1.C 第 1 项）", () => {
  test("modelSpanObserver：与原装配闭包逐字段等价（succeeded+scope+trace）", () => {
    const fact = baseModelFact();
    const { sink, calls } = recordingSink();
    modelSpanObserver(sink)(fact);
    expect(calls.length).toBe(1);
    expect(calls[0].observation).toEqual(legacyModelSpanAdapter(fact));
    // 对象同一性：时间戳不复制、不重铸。
    const observation = calls[0].observation as { occurredAt: Date };
    expect(observation.occurredAt).toBe(fact.startedAt);
  });

  test("modelSpanObserver：refused/usage_missing、无 trace、无 scope 各态等价", () => {
    const refused: BuiltinModelSpanFact = {
      ...baseModelFact(),
      ending: { kind: "refused", code: "credit_gate_failed" },
      scope: undefined,
      trace: null,
      input: null,
      output: null,
    };
    const usageMissing: BuiltinModelSpanFact = {
      ...baseModelFact(),
      ending: { kind: "usage_missing" },
      scope: undefined,
      trace: null,
    };
    for (const fact of [refused, usageMissing]) {
      const { sink, calls } = recordingSink();
      modelSpanObserver(sink)(fact);
      expect(calls.length).toBe(1);
      expect(calls[0].observation).toEqual(legacyModelSpanAdapter(fact));
      // 无 trace → 观察对象上零 trace 键（不发明链）；无 scope → undefined 原样。
      const observation = calls[0].observation as Record<string, unknown>;
      expect("trace" in observation).toBe(false);
      expect(observation.scope).toBeUndefined();
    }
  });

  test("toolStepObserver：executed 与 proposal-only（interrupted）逐字段等价", () => {
    const executed = baseToolFact();
    const proposalOnly: BuiltinToolStepFact = {
      ...baseToolFact(),
      toolName: null,
      proposedAt: null,
      executionObserved: false,
      execution: null,
      window: "interrupted",
      trace: null,
      input: null,
      output: null,
    };
    for (const fact of [executed, proposalOnly]) {
      const { sink, calls } = recordingToolSink();
      toolStepObserver(sink)(fact);
      expect(calls.length).toBe(1);
      expect(calls[0].observation).toEqual(legacyToolStepAdapter(fact));
    }
    // null → undefined 归一（内件 optional 形状）在门面臂复刻：toolName/proposedAt。
    const { sink, calls } = recordingToolSink();
    toolStepObserver(sink)(proposalOnly);
    const observation = calls[0].observation as Record<string, unknown>;
    expect(observation.toolName).toBeUndefined();
    expect(observation.proposedAt).toBeUndefined();
  });

  test("门面零包含：sink 抛错时同一实例透传（包含是 copilot 调用点的事，见 D3）", () => {
    const boom = new Error("sink-defect");
    const sink = {
      record(): void {
        throw boom;
      },
    };
    let thrown: unknown;
    try {
      modelSpanObserver(sink)(baseModelFact());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
  });

  test("最小 sink（仅 record）即可装配——Pick 最小面成立", () => {
    const sink = { record() {} };
    modelSpanObserver(sink)(baseModelFact());
    toolStepObserver(sink)(baseToolFact());
    // 到这里即通过：门面不读 sink 的任何其他成员。
  });

  test("observationEnabled：boot 配置判定只读透传，零第二意见", () => {
    expect(observationEnabled({ enabled: true })).toBe(true);
    expect(observationEnabled({ enabled: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D2 验收①：观察归属=服务器真实 Run/Attempt，不取客户端自报
// ---------------------------------------------------------------------------

describe("D2 验收① 运行归属=服务器真实 Run/Attempt（源级钉）", () => {
  const copilot = codeOf("../../src/copilot.ts");

  test("model-span fact 的 scope/trace 在服务端入口捕获（ambient 读，非 wire）", () => {
    // scope 的唯一生产点：doStream 入口读本 boot 建立的 ambient store。
    expect(
      copilot.includes(
        "spanObserver !== undefined ? currentRunObservationScope() : undefined",
      ),
    ).toBe(true);
    // fact 携带的是入口捕获值，settlement 侧不再重读 ambient。
    const factSlice = sliceFrom(copilot, "const reportSpan = (ending", "};");
    expect(factSlice.includes("scope: spanScope")).toBe(true);
    expect(factSlice.includes("trace: spanTrace")).toBe(true);
    expect(factSlice.includes("currentRunObservationScope()")).toBe(false);
  });

  test("tool-step fact 的 scope/trace 在 cell 开闸时于服务端捕获", () => {
    expect(copilot.includes("scope: currentRunObservationScope(),")).toBe(true);
    expect(copilot.includes("trace: currentTraceContext() ?? null,")).toBe(
      true,
    );
    // settlement 只携带 cell 已捕获值。
    const settleSlice = sliceFrom(
      copilot,
      "const observer = builtinToolStepObserver;",
      "} catch {",
    );
    expect(settleSlice.includes("trace: cell.trace")).toBe(true);
    expect(settleSlice.includes("scope: cell.scope")).toBe(true);
  });

  test("两个 fact 构造切片零 wire 标识符（req/body/query/headers/client）", () => {
    const modelSlice = sliceFrom(copilot, "spanObserver({", ");");
    const toolSlice = sliceFrom(copilot, "observer({", ");");
    const wireIdents = /\b(req|body|query|headers|client)\b/;
    expect(wireIdents.test(modelSlice)).toBe(false);
    expect(wireIdents.test(toolSlice)).toBe(false);
  });

  test("门面侧 scope 只出自 fact.scope：零 ambient 读、零发明", () => {
    const facade = codeOf("../../src/ai-observability/public.ts");
    expect(facade.includes("currentRunObservationScope")).toBe(false);
    expect(facade.includes("currentTraceContext")).toBe(false);
    // 门面不新造 scope：映射中 scope 只有一个来源。
    const modelBody = sliceFrom(
      facade,
      "export function modelSpanObserver",
      "export function toolStepObserver",
    );
    const scopeSources = modelBody.match(/scope:/g) ?? [];
    expect(scopeSources.length).toBe(1);
    expect(
      modelBody.includes("scope: fact.scope as ObservationScope | undefined"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D3 验收②：关闭/故障不影响普通执行，队列与丢弃有界
// ---------------------------------------------------------------------------

describe("D3 验收② 关闭/故障隔离+队列有界", () => {
  test("装配：五个观察注册/接线点均以 observationEnabled 为门（闭包已迁移）", () => {
    const runtime = codeOf("../../src/assembly/runtime.ts");
    // 两个注册门各恰好一次，且两注册都在门内（闭包形态已消失）。
    const gates = [
      ...runtime.matchAll(/if \(observationEnabled\(opikBootConfig\)\) \{/g),
    ];
    expect(gates.length).toBe(5);
    const modelArm = sliceFrom(
      runtime,
      "if (observationEnabled(opikBootConfig)) {",
      "const opikToolSteps = createToolStepRecorder",
    );
    expect(
      modelArm.includes(
        "setBuiltinModelSpanObserver(modelSpanObserver(opikModelSpans))",
      ),
    ).toBe(true);
    const toolArm = runtime.slice(
      modelArm.length +
        runtime.indexOf("if (observationEnabled(opikBootConfig)) {"),
    );
    expect(
      toolArm.includes(
        "setBuiltinToolStepObserver(toolStepObserver(opikToolSteps))",
      ),
    ).toBe(true);
    // 原地闭包不再存在于装配。
    expect(runtime.includes("setBuiltinModelSpanObserver((fact) =>")).toBe(
      false,
    );
    expect(runtime.includes("setBuiltinToolStepObserver((fact) =>")).toBe(
      false,
    );
    // 装配对 ObservationScope 只剩三处：类型 import、run observer 的
    // resolveRunObservationScope 回调名、observer fact 的 cast（M11 归口后新增的
    // run lifecycle 观察点）；不得再出现 scope 构造。
    expect((runtime.match(/ObservationScope/g) ?? []).length).toBe(3);
  });

  test("未注册=零记账：两观察点在 observer 缺席时早退（源级钉）", () => {
    const copilot = codeOf("../../src/copilot.ts");
    expect(copilot.includes("if (observer === undefined) return stream;")).toBe(
      true,
    );
    expect(
      copilot.includes(
        "if (observer === undefined || toolCallId === undefined) return run();",
      ),
    ).toBe(true);
    // model-span 的捕获（prompt 序列化/输出累积）本身以 observer 在场为前提。
    expect(copilot.includes("if (spanObserver !== undefined) {")).toBe(true);
  });

  test("故障隔离在执行侧：观察异常被调用点 try/catch 包含，五处同词", () => {
    const copilot = sourceOf("../../src/copilot.ts");
    const containment = copilot.match(
      /Observation never takes the product path down\./g,
    );
    expect(containment?.length).toBe(5);
  });

  test("行为：真实 recorder+health 链路经门面 observe——容量 1、第三笔 dropped_full、调用亚 50ms 返回", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probes = 0;
    const refuse = async (): Promise<never> => {
      throw new Error("not part of this test");
    };
    const port: OpikPort = {
      healthCheck: async () => {
        probes += 1;
        if (probes === 1) return { outcome: "ok", value: { healthy: true } };
        await gate;
        return { outcome: "ok", value: { healthy: true } };
      },
      retrieveProject: refuse,
      createTrace: refuse,
      writeSpans: async () => {
        await gate;
        return { outcome: "ok", value: { accepted: true } };
      },
      listTraces: refuse,
      listSpans: refuse,
    };
    const service = createOpikHealthService({
      config: () => ({
        enabled: true,
        baseUrl: "http://opik.secret-host.test/api",
        apiKey: null,
        workspaceName: null,
        port: 5174,
        otlpHttpPort: 5418,
        otlpGrpcPort: 5417,
      }),
      port,
      writeCapacity: 1,
    });
    expect(await service.readiness()).toEqual({ ready: true });

    // 生产形态的链路：装配建 recorder（队列在内件），门面只做事实→观察。
    const recorder = createModelSpanRecorder({ healthService: service });
    const observe = modelSpanObserver(recorder);

    const at = Date.now();
    observe(baseModelFact()); // 写 1：入泵（writeSpans 挂起，占住容量外的在飞位）
    observe(baseModelFact()); // 写 2：排队（容量 1 占满）
    observe(baseModelFact()); // 写 3：队列满 → dropped_full，计数丢弃
    expect(Date.now() - at).toBeLessThan(50);

    const stats = service.writeStats();
    expect(stats.capacity).toBe(1);
    expect(stats.droppedFull).toBe(1);

    release();
    await service.drain();
  });

  test("行为：observationEnabled=false 时装配不注册（门面判定与 config 语义一致）", () => {
    // config.ts 的判定：仅字面 true 启用。门面透传同一布尔。
    const config = codeOf("../../src/ai-observability/config.ts");
    expect(config.includes('env.OPIK_ENABLED === "true"')).toBe(true);
    expect(observationEnabled({ enabled: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D4 验收③：强制审计失败不能一起降为 best effort（审计独立）
// ---------------------------------------------------------------------------

describe("D4 验收③ 审计独立（源级钉）", () => {
  test("src/audit.ts 零观测依赖（审计写入不经 observer/best-effort 通道）", () => {
    const audit = sourceOf("../../src/audit.ts");
    expect(audit.includes("ai-observability")).toBe(false);
    expect(audit.includes("telemetry")).toBe(false);
    expect(audit.includes("setBuiltin")).toBe(false);
  });

  test("门面零 audit 面：无审计写入、无 store、无队列复制", () => {
    const facade = codeOf("../../src/ai-observability/public.ts");
    expect(facade.includes("recordAuditEvent")).toBe(false);
    expect(facade.includes("AuditStore")).toBe(false);
    expect(facade.includes("createAuditStore")).toBe(false);
  });

  test("M11 自身审计=await 直写（不乘 observer 队车）", () => {
    for (const file of [
      "../../src/ai-observability/experiments.ts",
      "../../src/ai-observability/retention.ts",
      "../../src/ai-observability/executions.ts",
      "../../src/ai-observability/case-review.ts",
    ]) {
      expect(codeOf(file).includes("await recordAuditEvent(")).toBe(true);
    }
  });

  test("copilot 观察包含块内零 modelBillingAudit（审计不在观察 try/catch 里降级）", () => {
    const copilot = codeOf("../../src/copilot.ts");
    const reportSpanSlice = sliceFrom(
      copilot,
      "const reportSpan = (ending",
      "};",
    );
    expect(reportSpanSlice.includes("modelBillingAudit")).toBe(false);
    // 审计 sink 是独立注册 seam（装配处 setModelBillingAudit），与 observer 并列。
    const runtime = codeOf("../../src/assembly/runtime.ts");
    expect(runtime.includes("setModelBillingAudit(")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D5 验收④：查询/导出按当前权限，公司汇总不放开私人内容
// ---------------------------------------------------------------------------

describe("D5 验收④ 查询/导出权限现状（源级钉，现状保持零改动）", () => {
  test("admin-summary：授权先行（manage gate→显式 ownership→新铸 scope）", () => {
    const route = codeOf("../../src/ai-observability/routes/admin-summary.ts");
    expect(
      route.includes("await resolveObservationBot(deps.canManageBot, actor"),
    ).toBe(true);
    expect(route.includes("explicitObservationOwnership(actor")).toBe(true);
    expect(route.includes("resolveObservationScope({")).toBe(true);
  });

  test("admin-summary：请求只贡献 timeFrom/timeTo/botId 过滤，零身份/范围自报", () => {
    const route = codeOf("../../src/ai-observability/routes/admin-summary.ts");
    const queries = [...route.matchAll(/req\.query\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(queries.sort()).toEqual(["botId", "timeFrom", "timeTo"]);
    expect(route.includes("req.json()")).toBe(false);
  });

  test("runs 查询：scope 键控分页/缓存（转移/撤权/epoch 提升即失效）", () => {
    const runs = codeOf("../../src/ai-observability/queries/runs.ts");
    expect(runs.includes("cacheKey(scope,")).toBe(true);
    expect(runs.includes("bindCursor(scope,")).toBe(true);
    expect(runs.includes("scopeCacheKey")).toBe(true);
  });

  test("exports：请求零贡献，撤权走控制面 cancelForActor（非路由）", () => {
    const route = sourceOf("../../src/ai-observability/routes/exports.ts");
    expect(
      route.includes("The request contributes nothing but its identity"),
    ).toBe(true);
    expect(route.includes("cancelForActor")).toBe(true);
    const store = codeOf("../../src/ai-observability/exports.ts");
    expect(store.includes("async cancelForActor(actorId)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D6 验收⑤：不重复 #4 原树新观测页面/存储（负向）
// ---------------------------------------------------------------------------

describe("D6 验收⑤ 负向：零新存储/页面/挂载", () => {
  const facadeSource = sourceOf("../../src/ai-observability/public.ts");

  test("门面 import 面=恰 4 个组内类型模块，零运行时依赖", () => {
    const modules = [...facadeSource.matchAll(/from "(\.\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(modules.sort()).toEqual([
      "./config",
      "./contracts",
      "./model-span",
      "./tool-steps",
    ]);
    // 全部 type-only：无任何值 import（import 后面不跟 type 即违规）。
    // 剥注释后判定——头注释里的中文叙述含 "import" 一词。
    expect(
      codeOf("../../src/ai-observability/public.ts").match(/import\s(?!type)/),
    ).toBeNull();
  });

  test("门面 export 面=恰 3 能力+6 类型；零 Hono/路由/db/schema/队列面", () => {
    const fns = [...facadeSource.matchAll(/^export function (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(fns.sort()).toEqual([
      "modelSpanObserver",
      "observationEnabled",
      "toolStepObserver",
    ]);
    const types = [...facadeSource.matchAll(/^export type (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(types.sort()).toEqual([
      "BuiltinModelSpanFact",
      "BuiltinToolStepFact",
      "EvaluationUsageOutbox",
      "EvaluationUsageOutboxInput",
      "ModelSpanObserverSink",
      "ToolStepObserverSink",
    ]);
    expect(facadeSource.includes("hono")).toBe(false);
    expect(facadeSource.includes("db/schema")).toBe(false);
    expect(facadeSource.includes("createOpikHealthService")).toBe(false);
  });

  test("迁移臂不新增存储/页面：全仓对门面的引用=定义+装配 import+五处注册/接线点", () => {
    // 装配面：import 一处 + 恰两调用；无路由挂载、无 schema、无新页字段。
    const runtime = codeOf("../../src/assembly/runtime.ts");
    expect(
      (runtime.match(/modelSpanObserver\(opikModelSpans\)/g) ?? []).length,
    ).toBe(1);
    expect(
      (runtime.match(/toolStepObserver\(opikToolSteps\)/g) ?? []).length,
    ).toBe(1);
    expect(
      (runtime.match(/observationEnabled\(opikBootConfig\)/g) ?? []).length,
    ).toBe(5);
  });
});
