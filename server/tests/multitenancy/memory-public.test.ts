// server/tests/multitenancy/memory-public.test.ts
// MOD15（Issue #635，根 #620）：M10 PersonalMemory 出口的委托等价、五条验收的
// 现状钉与迁移完整性源级钉。
//
// 事实源（Issue #635 验收 + MOD15 Brief §1.D，逐条对应 describe）：
//   D1 委托等价：createPersonalMemoryPublic 十能力全部薄委托——替身记录调用证明
//      （同参透传/同结果实例/错误实例透传/降级注入同实例/未注入装配错误）。
//   D2 验收①未审核不可召回+权威重读：store.eligibleRows 的 reviewState
//      ∈ {confirmed,edited} 过滤（Bot 侧每条召回路径的资格差）；本人审阅读
//      （list）无此过滤（候选同读——审核语义由两面对照定义）；召回每次调用
//      重读 eligibleSources 与权威行（无缓存字段）。
//   D3 验收②来源范围不扩大+先阻断后清理：bindSource 绑定时公司 pin 盖章一次
//      （tenantId: company?.tenantId ?? null，此后只读）；blockSource 的
//      enabled=false 在 eligibleSources 立即失格（先阻断）；revokeSource 事务内
//      lockDefaults→级联删→recordOptOut（后清理，OpenBot 不再自行加回）。
//   D4 验收③降级同过滤：B 装配臂构造一个降级门面实例、语境组合收同一个实例
//      （recall: degradedRecall）；同一 authority 行搜索（loadRecallEligible）
//      与同一资格谓词（preferenceRecallEligible）同时出现在降级路径与语境
//      路径；runtime 两处装载（Mastra seam 与 governed headless turns）持
//      同一个 renderedLoader（ME10 AC3 one loader）。
//   D5 验收④记忆模型成本经受管调用+Learning Skill 独立：判断链的 eager retain
//      经预算门（budget: hindsightBudgetGate）装配源级钉；memory/public.ts 与
//      memory/integration.ts 零 demonstration/skill 面（结构负向）。
//   D6 验收⑤负向：公开门面不 re-export openmuse 任何面；memory/ 新增两文件零
//      openmuse 引用（openmuse_memories 整表不并入个人记忆，#376 未尽事项不补做）。
//   D7 迁移完整性（源级钉）：四个消费者（agents/agent-resolver.ts、
//      agents/lifecycle-reset.ts、proactive/engine.ts、proactive/store.ts）
//      的记忆 import 已落 M10 公开门面（../memory/public），内件 import 归零
//      ——reports/MOD15-report.md §消费者普查表的可执行孪生。
//
// 存量对照（D 组之外）：memory/hindsight 族套件两树对照与复跑见
// reports/mod15-verification/（基线侧=干净树 @ 9e352088c 首跑，实施侧=同树复跑
// +独立复跑，命令与退出码全表=其 commands.md），不在本文件内。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶），不依赖 Bun 运行时、不触真实数据库：委托语义以注入替身证明
// （替身证明的正是委托本身）；审核/撤销/降级的资格语义以源级结构断言钉住
// 形状，真实 PG 行为由存量套件两树对照钉住（run-lifecycle-public /
// automation-runs-public 先例）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { MemoryIngestion, MemoryStore } from "../../src/memory/public";
import {
  createPersonalMemoryPublic,
  type PersonalMemoryPublic,
} from "../../src/memory/public";

// ---------------------------------------------------------------------------
// 工具（MOD14 同款：源级结构断言的注释剥离器）
// ---------------------------------------------------------------------------

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** 剥掉 // 行注释与块注释后的源码（结构断言不被注释文本干扰）。行注释先剥。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const STORE = "../../src/memory/store.ts";
const INGESTION = "../../src/memory/ingestion.ts";
const PUBLIC = "../../src/memory/public.ts";
const INTEGRATION = "../../src/memory/integration.ts";
const RUNTIME = "../../src/assembly/runtime.ts";
const CONTEXT = "../../src/hindsight/personal-memory-context.ts";
const DEGRADED = "../../src/hindsight/degraded-recall.ts";

/** 一个函数块的名字锚点：从 `marker` 起，跳过参数列表（内联对象类型有自己的
 * 花括号，不是函数体）与可选的返回类型注解，找到函数体开括号，截到配对结束。 */
function blockOf(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const body = /\)\s*(?::\s*[^{;=]+)?\{/.exec(source.slice(start));
  if (!body) throw new Error(`function body not found: ${marker}`);
  const open = start + body.index + body[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block: ${marker}`);
}

// ---------------------------------------------------------------------------
// 替身：记录调用的 store/ingestion 缝（委托证明的正是委托本身）
// ---------------------------------------------------------------------------

type Call = { seam: string; args: unknown[] };

function standIn<T extends (...args: never[]) => unknown>(
  seam: string,
  calls: Call[],
  answer: ReturnType<T>,
): T {
  return ((...args: unknown[]) => {
    calls.push({ seam, args });
    return answer;
  }) as T;
}

/** 记录型 store 替身：每条缝回一个可认定的哨兵值。 */
function recordingStore(calls: Call[], markers: Record<string, unknown>) {
  const face: Record<string, unknown> = {};
  for (const seam of [
    "retrieve",
    "list",
    "create",
    "formMemory",
    "update",
    "remove",
    "sources",
    "createSource",
    "setSourceEnabled",
    "removeSource",
  ]) {
    face[seam] = standIn(seam, calls, markers[seam]);
  }
  return face as unknown as Pick<
    MemoryStore,
    | "retrieve"
    | "list"
    | "create"
    | "formMemory"
    | "update"
    | "remove"
    | "sources"
    | "createSource"
    | "setSourceEnabled"
    | "removeSource"
  >;
}

function recordingIngestion(calls: Call[], markers: Record<string, unknown>) {
  return {
    recall: standIn("recall", calls, markers.recall),
    contextFor: standIn("contextFor", calls, markers.contextFor),
  } as unknown as Pick<MemoryIngestion, "recall" | "contextFor">;
}

const SENTINELS = {
  retrieve: { rows: "retrieve-answer" },
  list: { rows: "list-answer" },
  create: { row: "create-answer" },
  formMemory: { row: "formMemory-answer" },
  update: { row: "update-answer" },
  remove: undefined,
  sources: { rows: "sources-answer" },
  createSource: { row: "createSource-answer" },
  setSourceEnabled: { row: "setSourceEnabled-answer" },
  removeSource: undefined,
  recall: { rows: "recall-answer" },
  contextFor: "contextFor-answer",
};

function faceWithStands(calls: Call[]): {
  face: PersonalMemoryPublic;
  calls: Call[];
} {
  const store = recordingStore(calls, SENTINELS);
  const ingestion = recordingIngestion(calls, SENTINELS);
  return {
    face: createPersonalMemoryPublic({
      store,
      ingestion,
      degradedRecall: FACADE_STAND_IN,
    }),
    calls,
  };
}

const FACADE_STAND_IN = { degraded: true } as unknown as Parameters<
  typeof createPersonalMemoryPublic
>[0]["degradedRecall"];

// ---------------------------------------------------------------------------
// D1 委托等价
// ---------------------------------------------------------------------------

describe("MOD15 D1：PersonalMemory 出口十能力全部薄委托", () => {
  test("recall → ingestion.recall：同参透传、同结果实例", async () => {
    const { face, calls } = faceWithStands([]);
    const answer = await face.recall("owner-1", "bot-1", "term", {
      tenantId: "t-1",
    });
    expect(answer).toBe(SENTINELS.recall);
    expect(calls).toEqual([
      {
        seam: "recall",
        args: ["owner-1", "bot-1", "term", { tenantId: "t-1" }],
      },
    ]);
  });

  test("contextFor → ingestion.contextFor", async () => {
    const { face, calls } = faceWithStands([]);
    const answer = await face.contextFor("owner-1", "bot-1", {
      tenantId: "t-1",
    });
    expect(answer).toBe(SENTINELS.contextFor);
    expect(calls[0].seam).toBe("contextFor");
  });

  test("写面三缝：remember→create、saveObserved→formMemory、forget→remove", async () => {
    const { face, calls } = faceWithStands([]);
    await face.remember("owner-1", { content: "fact" }, { tenantId: "t-1" });
    await face.saveObserved("owner-1", { content: "observed" });
    await face.forget("owner-1", "mem-1");
    expect(calls.map((call) => call.seam)).toEqual([
      "create",
      "formMemory",
      "remove",
    ]);
    expect(calls[0].args).toEqual([
      "owner-1",
      { content: "fact" },
      { tenantId: "t-1" },
    ]);
    expect(calls[1].args).toEqual(["owner-1", { content: "observed" }]);
    expect(calls[2].args).toEqual(["owner-1", "mem-1"]);
  });

  test("审阅读/决定两缝：reviewCandidates→list、reviewEdit→update", async () => {
    const { face, calls } = faceWithStands([]);
    await face.reviewCandidates("owner-1", { tenantId: "t-1" });
    await face.reviewEdit("owner-1", "mem-1", { content: "edited" });
    expect(calls.map((call) => call.seam)).toEqual(["list", "update"]);
  });

  test("来源四缝：sources/createSource/setSourceEnabled/removeSource", async () => {
    const { face, calls } = faceWithStands([]);
    await face.sources("owner-1");
    await face.bindSource("owner-1", { toolRef: "x" }, { tenantId: "t-1" });
    await face.blockSource("owner-1", "src-1", false);
    await face.revokeSource("owner-1", "src-1");
    expect(calls.map((call) => call.seam)).toEqual([
      "sources",
      "createSource",
      "setSourceEnabled",
      "removeSource",
    ]);
    expect(calls[2].args).toEqual(["owner-1", "src-1", false]);
  });

  test("degradedRecall：注入实例原样透传（验收③的同一实例纪律）", () => {
    const { face } = faceWithStands([]);
    expect(face.degradedRecall()).toBe(FACADE_STAND_IN);
  });

  test("degradedRecall 未注入=装配错误（TypeError），不是业务拒绝", () => {
    const face = createPersonalMemoryPublic({
      store: recordingStore([], SENTINELS),
      ingestion: recordingIngestion([], SENTINELS),
    });
    expect(() => face.degradedRecall()).toThrow(TypeError);
  });

  test("内件错误实例原样上抛（MemoryRefusedError 不被吞改）", async () => {
    const refusal = new Error("refused-by-inner") as Error & {
      name: "MemoryRefusedError";
    };
    refusal.name = "MemoryRefusedError";
    const store = {
      ...recordingStore([], SENTINELS),
      remove: (async () => {
        throw refusal;
      }) as unknown as Pick<MemoryStore, "remove">["remove"],
    };
    const face = createPersonalMemoryPublic({
      store,
      ingestion: recordingIngestion([], SENTINELS),
    });
    await expect(face.forget("owner-1", "mem-1")).rejects.toBe(refusal);
  });
});

// ---------------------------------------------------------------------------
// D2 验收①：未审核不可召回 + 权威重读
// ---------------------------------------------------------------------------

describe("MOD15 D2：验收①未审核不可召回+权威重读", () => {
  const store = codeOf(STORE);

  test("召回资格差：eligibleRows 只放行 confirmed/edited（未审核候选不出现在任何 Bot 侧召回）", () => {
    const eligible = blockOf(store, "function eligibleRows(");
    expect(eligible).toContain(
      `inArray(personalMemories.reviewState, ["confirmed", "edited"])`,
    );
  });

  test("本人审阅读无审核过滤：list() 查询不含 reviewState（候选与已审同读——两面之差即审核语义）", () => {
    const list = blockOf(store, "async list(");
    expect(list).not.toContain("reviewState");
  });

  test("权威重读：召回每次调用现查权威行——retrieve 直接落到 database.select（无缓存/记忆化字段）", () => {
    const retrieve = blockOf(store, "async retrieve(");
    expect(retrieve).toContain("eligibleRows(");
    expect(store).not.toMatch(/\b(cache|memo|lru)\b/i);
  });

  test("资格链重读：ingestion.recall 每次调用重解 eligibleSources 与 formed（不缓存资格）", () => {
    const recall = blockOf(codeOf(INGESTION), "async recall(");
    expect(recall).toContain("await eligibleSources(ownerUserId, botId)");
    expect(recall).toContain("await formedFor(botId)");
    expect(recall).toContain("store.retrieve(");
  });

  test("暂停优先于任何行读取：recall 首行即 usagePaused 短路（空答，非错误）", () => {
    const recall = blockOf(codeOf(INGESTION), "async recall(");
    expect(recall.indexOf("usagePaused")).toBeLessThan(
      recall.indexOf("eligibleSources"),
    );
  });
});

// ---------------------------------------------------------------------------
// D3 验收②：来源范围不扩大 + 先阻断后清理
// ---------------------------------------------------------------------------

describe("MOD15 D3：验收②来源范围不扩大+先阻断后清理", () => {
  const store = codeOf(STORE);
  const ingestion = codeOf(INGESTION);

  test("来源范围不扩大：公司 pin 在绑定时盖章一次（createSource 的 tenantId 盖章），此后每次操作只按它过滤", () => {
    const createSource = blockOf(store, "async createSource(");
    expect(createSource).toContain("tenantId: company?.tenantId ?? null");
  });

  test("先阻断：enabled=false 在 eligibleSources 立即失格——召回资格链第一过滤即 source.enabled", () => {
    const eligible = blockOf(ingestion, "async function eligibleSources(");
    expect(eligible).toContain("source.enabled &&");
    // 阻断先于任何行读取：资格过滤发生在 store.sources 读出之后、authorize 之前
    expect(eligible.indexOf("source.enabled")).toBeLessThan(
      eligible.indexOf("authorize(source)"),
    );
  });

  test("后清理：revokeSource=removeSource 事务内三步——lockDefaults → 级联删来源行 → recordOptOut（不再自行加回）", () => {
    const removeSource = blockOf(store, "async removeSource(");
    const lock = removeSource.indexOf("lockDefaults(");
    const del = removeSource.indexOf(".delete(memorySources)");
    const optOut = removeSource.indexOf("recordOptOut(");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(lock);
    expect(optOut).toBeGreaterThan(del);
  });

  test("blockSource 是显式阻断原语：setSourceEnabled 直写 enabled（无派生状态、无延迟）", () => {
    const setEnabled = blockOf(store, "async setSourceEnabled(");
    expect(setEnabled).toContain(".set({ enabled,");
  });
});

// ---------------------------------------------------------------------------
// D4 验收③：Hindsight 故障降级仍同一过滤
// ---------------------------------------------------------------------------

describe("MOD15 D4：验收③降级同过滤", () => {
  test("B 装配臂构造一个门面实例并喂给语境组合：integration.ts 内 recall: degradedRecall（同一实例，无第二次构造）", () => {
    const integration = codeOf(INTEGRATION);
    expect(integration).toContain("const degradedRecall =");
    expect(integration).toContain("recall: degradedRecall,");
    expect(integration.match(/createDegradedRecallFacade\(/g)?.length).toBe(1);
  });

  test("降级路径与语境路径读同一权威行搜索：loadRecallEligible 两处同源", () => {
    expect(codeOf(DEGRADED)).toContain("loadRecallEligible");
    expect(codeOf(CONTEXT)).toContain("loadRecallEligible");
  });

  test("同一资格谓词：preferenceRecallEligible 同时约束降级召回与语境读取", () => {
    expect(codeOf(DEGRADED)).toContain("preferenceRecallEligible(row)");
    expect(codeOf(CONTEXT)).toContain("preferenceRecallEligible(row)");
  });

  test("one loader：runtime 的 Mastra seam 与 governed headless turns 持同一个 renderedLoader（ME10 AC3）", () => {
    const runtime = codeOf(RUNTIME);
    expect(runtime).toContain(
      "setMastraPersonalMemoryContext(hindsightRecallArm.renderedLoader)",
    );
    expect(runtime).toContain(
      "headlessPersonalMemoryContext = hindsightRecallArm.renderedLoader",
    );
  });

  test("装配等价：臂收拢后的参数面与原内联组合一一对应（judgments/pause/recovery 透传）", () => {
    const arm = blockOf(
      codeOf(INTEGRATION),
      "export function createHindsightRecallArm(",
    );
    expect(arm).toContain("judgments: options.judgments");
    expect(arm).toContain("pause: options.pause");
    expect(arm).toContain("recovery: options.recovery");
    const runtime = codeOf(RUNTIME);
    expect(runtime).toContain("judgments: hindsightJudgmentReview,");
    expect(runtime).toContain("pause: hindsightPause,");
    expect(runtime).toContain("recovery: hindsightRecovery.gate,");
  });

  test("sync 臂两段清扫段名与吞错纪律保持（drain → deletionRetry，逐段记账）", () => {
    const sweep = blockOf(
      codeOf(INTEGRATION),
      "export function createHindsightSyncArm(",
    );
    expect(sweep).toContain('"hindsightSyncDrain"');
    expect(sweep).toContain('"hindsightDeletionRetry"');
    const runtime = codeOf(RUNTIME);
    expect(runtime).toMatch(
      /hindsightSyncSweep = repeatAfterEach\(\s*hindsightSyncArm\.sweep,/,
    );
  });
});

// ---------------------------------------------------------------------------
// D5 验收④：记忆模型成本经受管调用 + Learning Skill 独立
// ---------------------------------------------------------------------------

describe("MOD15 D5：验收④记忆模型成本经受管调用+Learning Skill 独立", () => {
  test("记忆链的模型调用经预算门：判断链审阅装配持同一 budget gate（eager retain 准入）", () => {
    const runtime = codeOf(RUNTIME);
    expect(runtime).toContain("budget: hindsightBudgetGate,");
  });

  test("Learning Skill 独立：公开门面零 demonstration/skill 面（负向结构钉）", () => {
    const publicFace = codeOf(PUBLIC);
    expect(publicFace).not.toMatch(/demonstration|skill/i);
  });

  test("装配臂同样零 demonstration/skill 面", () => {
    expect(codeOf(INTEGRATION)).not.toMatch(/demonstration|skill/i);
  });

  test("公开门面不含索引/同步实现面（sync-queue/drain/ledger 不在出口上）", () => {
    const publicFace = codeOf(PUBLIC);
    expect(publicFace).not.toMatch(/drain|syncQueue|revocationLedger/i);
  });
});

// ---------------------------------------------------------------------------
// D6 验收⑤：负向（不默认合并 openmuse、不补做 #376 未尽事项）
// ---------------------------------------------------------------------------

describe("MOD15 D6：验收⑤负向", () => {
  test("公开门面不 re-export openmuse 任何面", () => {
    expect(codeOf(PUBLIC)).not.toContain("openmuse");
  });

  test("memory/ 新增两文件零 openmuse 引用（整表不并入个人记忆）", () => {
    expect(codeOf(INTEGRATION)).not.toContain("openmuse");
    expect(codeOf(PUBLIC)).not.toContain("openmuse-memor");
  });

  test("公开门面不暴露 Hindsight 索引写入/清理入口（#376 未尽事项不在此补做）", () => {
    const publicFace = codeOf(PUBLIC);
    expect(publicFace).not.toMatch(
      /retryOutstandingDeletions|reconcile|cleanup/i,
    );
  });
});

// ---------------------------------------------------------------------------
// D7 迁移完整性（消费者普查表的可执行孪生）
// ---------------------------------------------------------------------------

describe("MOD15 D7：四个消费者的记忆 import 已落 M10 公开门面", () => {
  const CONSUMERS: Array<[string, string, string]> = [
    [
      "agents/agent-resolver.ts（M03）",
      "../../src/agents/agent-resolver.ts",
      'from "../memory/public"',
    ],
    [
      "agents/lifecycle-reset.ts（M03）",
      "../../src/agents/lifecycle-reset.ts",
      'from "../memory/public"',
    ],
    [
      "proactive/engine.ts（AUTOMATION）",
      "../../src/proactive/engine.ts",
      'from "../memory/public"',
    ],
    [
      "proactive/store.ts（AUTOMATION）",
      "../../src/proactive/store.ts",
      'from "../memory/public"',
    ],
  ];

  for (const [label, path, via] of CONSUMERS) {
    test(`${label}：记忆 import 经 ${via}`, () => {
      expect(codeOf(path)).toContain(via);
    });
  }

  test("内件 import 归零：四文件不再直达 memory/tools、memory/defaults、memory/store", () => {
    for (const [, path] of CONSUMERS) {
      const code = codeOf(path);
      expect(code).not.toContain('from "../memory/tools"');
      expect(code).not.toContain('from "../memory/defaults"');
      expect(code).not.toContain('from "../memory/store"');
    }
  });

  test("copilot.ts 的记忆面（PersonalMemoryMiddleware/basis 指针）非本票环边，维持原 import（普查登记不迁移）", () => {
    const copilot = codeOf("../../src/copilot.ts");
    expect(copilot).toContain('from "./memory/tools"');
    expect(copilot).toContain('from "./hindsight/personal-memory-context"');
  });

  test("公开门面的迁移 re-export 面恰为消费者所需四组（类型 LoadPersonalMemory/MemoryStore/MemoryIngestion/MemoryCompany + defaults 三函数）", () => {
    const publicFace = sourceOf(PUBLIC);
    expect(publicFace).toContain("export type { LoadPersonalMemory }");
    expect(publicFace).toContain("export type { MemoryStore }");
    expect(publicFace).toContain(
      "export { lockDefaults, recordOptOut, sourceServerId }",
    );
  });
});
