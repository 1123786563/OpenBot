// server/tests/multitenancy/model-invocation-budget-public.test.ts
// MOD09（Issue #629，根 #620）：受管模型调用与双重预算出口门面的验收钉。
//
// Brief D 段六条，全部对着**现状**钉死（零新策略；两库分工见下）：
//   D1 委托等价：A 门面七能力对注入内件/协作者的参数与答案逐一透传（假件）。
//   D2 验收①：token 界内校验→资金预扣→才给 dispatch 形状（顺序钉，第二阶段
//      失败不误 dispatch——未定价/未配置直接拒绝且预扣零调用；余额不足拒绝且
//      不返回 lifecycle；放行才有 bounds）。
//   D3 验收②：ModelAccess（enterprise/models/public.ts）零 runs/store import、
//      零 billing import（检查器 654 零 delta 的前提）；Run 协作者经构造注入
//      （注入假件编译并委托——依赖倒置的类型证）。
//   D4 验收③：原 Payer 一次解析、全部写入共用（resolve 恰一次）；取消/断流
//      不释放未知费用——stream_error/cancelled 走 markReservationUnknown、
//      releaseReservation 零调用；仅确认无费（provider_error/bound_refused/
//      no_usage）才走普通释放。价格依据 = 装配传入的同一 creditPolicy 对象。
//   D5 验收④：reserve/settle/ack 重放不重扣。资金侧在专用主测试库
//      （TEST_DATABASE_URL，缺 env 显式 skip）对 credits-writer 真件重放：
//      同幂等键预扣答原预扣、同 actual 结算只入账一次、异 actual 冲突；组合体
//      gate 的幂等键形状 = usage:<eventId>（D2 钉）。token 侧在专用企业测试库
//      （ENTERPRISE_TEST_SETUP_DATABASE_URL，缺 env 显式 skip）对 budget 内件
//      真件重放：同幂等键预留答原预留、异输入同键 409、确认重放同用量不冲突、
//      已确认不可释放。
//   D6 验收⑤：token 确认不冒充资金结算、网络调用不入长 DB 事务——源级结构
//      断言（public.ts/model-budget.ts 的禁用词扫描 + A 门面确认只触 budget
//      内件 confirm 的假件证）。
//
// 事实源：enterprise/models/{budget,gateway,public}.ts、assembly/model-budget.ts、
// billing/credits-writer.ts（内件零改动的权威实现）。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createModelBudgetArm } from "../../src/assembly/model-budget";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "../../src/billing/credits-writer";
import {
  createPayerAccount,
  type PayerRef,
  payerKey,
} from "../../src/billing/payer";
import {
  CreditInsufficientError,
  type PayerBinding,
} from "../../src/billing/payer-binding";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "../../src/billing/types";
import type { BillingCreditPolicyConfig } from "../../src/config";
import {
  CreditPolicyUnconfiguredError,
  ModelNotPricedError,
} from "../../src/copilot";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterprisePrincipals,
  enterpriseRuns,
  enterpriseWorkspaceMemberships,
  users,
} from "../../src/db/schema";
import { creditReservations } from "../../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../../src/db/schema/credits";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationStore } from "../../src/enterprise/conversations/store";
import { createModelBudgetService } from "../../src/enterprise/models/budget";
import {
  createModelBudgetPublic,
  type ModelBudgetCreditCollaborator,
} from "../../src/enterprise/models/public";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import { TEST_POOL, testDatabaseUrl } from "../support/database";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseSetupDatabaseVariable,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

// ---------------------------------------------------------------------------
// 源级事实（读本仓库源文件做结构断言；路径相对本测试文件）
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_TS = readFileSync(
  join(REPO_ROOT, "src/enterprise/models/public.ts"),
  "utf8",
);
const ARM_TS = readFileSync(
  join(REPO_ROOT, "src/assembly/model-budget.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 假件（单元段用：录制调用的内件/协作者替身）
// ---------------------------------------------------------------------------

function recorder() {
  const calls: { name: string; args: unknown[] }[] = [];
  return calls;
}

const stubScope: PlatformScope = {
  tenantId: "t-stub",
  workspaceId: "w-stub",
  principalId: "p-stub",
  actorId: "u-stub",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

/** budget 内件替身：与 createModelBudgetService 返回的最小面同形。 */
function stubBudgetService(calls: ReturnType<typeof recorder>) {
  const reservation = {
    reservationId: "res-stub",
    runId: "run-stub",
    tokenLimit: 1000,
    expiresAt: new Date(0).toISOString(),
  };
  return {
    calls,
    reservation,
    async reserveModelBudget(
      scope: PlatformScope,
      input: { runId: string; modelRouteRef: string; maximumTokens: number },
      options?: { idempotencyKey?: string; runCeiling?: boolean },
    ) {
      calls.push({ name: "reserveModelBudget", args: [scope, input, options] });
      return reservation;
    },
    async confirm(
      scope: PlatformScope,
      reservationId: string,
      usedTokens: number,
    ) {
      calls.push({ name: "confirm", args: [scope, reservationId, usedTokens] });
    },
    async release(scope: PlatformScope, reservationId: string) {
      calls.push({ name: "release", args: [scope, reservationId] });
    },
  };
}

/** 资金协作者替身：与 ModelBudgetCreditCollaborator 同形。 */
function stubCredits(calls: ReturnType<typeof recorder>) {
  const instance: ModelBudgetCreditCollaborator = {
    async reserveCredits(input) {
      calls.push({ name: "reserveCredits", args: [input] });
      return { reserved: true, reservationId: "hold-stub" };
    },
    async releaseReservation(reservationId, reason) {
      calls.push({
        name: "releaseReservation",
        args: [reservationId, reason],
      });
    },
    async markReservationUnknown(reservationId, reason) {
      calls.push({
        name: "markReservationUnknown",
        args: [reservationId, reason],
      });
    },
  };
  return instance;
}

/** 定价策略替身：BillingCreditPolicyConfig 的 configured 形状（结构同一定义）。 */
const RATE = { numerator: 1n, denominator: 100n };
type PricedPolicy = Extract<BillingCreditPolicyConfig, { configured: true }>;
function stubPolicy(): PricedPolicy {
  const modelPolicy = {
    input: { rate: RATE, maximumTokens: 100n, maximumCostUnits: 10n },
    output: { rate: RATE, maximumTokens: 50n, maximumCostUnits: 10n },
    maximumReservationUnits: 20n,
  };
  return {
    configured: true,
    mode: "hard_cap",
    models: new Map([["priced-model", modelPolicy]]),
    codeRun: { rate: RATE, maximumTokens: 100n, maximumReservationUnits: 5n },
  };
}

const STUB_PAYER_REF: PayerRef = {
  kind: "legacy_deployment",
  id: "deployment-mod09",
};
function stubPayerBinding(): PayerBinding {
  // 与生产绑定同构：键必须从自身 ref 派生（assertBindingCoherent 的边界）。
  return {
    payer: STUB_PAYER_REF,
    externalCustomerId: payerKey(STUB_PAYER_REF),
    boundAt: new Date(0).toISOString(),
  };
}

function stubOutbox() {
  return {
    async record(input: unknown) {
      lastOutboxFact = input as { externalCustomerId: string };
      return { status: "recorded" as const };
    },
  };
}
let lastOutboxFact: { externalCustomerId: string } | undefined;

/** 装配 gate 组合体（B），返回 gate 函数与录制器。 */
function armWith(
  credits: ModelBudgetCreditCollaborator,
  overrides?: {
    policy?: PricedPolicy | "unconfigured" | undefined;
    payer?: () => PayerBinding | undefined;
  },
) {
  const payer = overrides?.payer ?? stubPayerBinding;
  const outbox = stubOutbox();
  const policy: BillingCreditPolicyConfig | undefined =
    overrides?.policy === "unconfigured"
      ? { configured: false, mode: "hard_cap", issues: [] }
      : (overrides?.policy ?? stubPolicy());
  return createModelBudgetArm({
    credits,
    creditPolicy: policy,
    defaultModelId: "priced-model",
    deploymentPayerBinding: stubPayerBinding(),
    currentPayerBinding: payer,
    currentWorkbenchScope: () => undefined,
    usageOutbox: outbox as never,
  });
}

const GATE_INPUT = {
  eventId: randomUUID(),
  occurredAt: new Date(),
  modelId: "priced-model",
  client: "web" as const,
  attribution: { userId: "u1", botId: "b1" },
};

// ---------------------------------------------------------------------------
// D1 委托等价（单元，无库）
// ---------------------------------------------------------------------------

describe("MOD09 D1 — A 门面七能力委托等价（薄委托，零新策略）", () => {
  test("token 预算三能力逐项委托 budget 内件", async () => {
    const calls = recorder();
    const budget = stubBudgetService(calls);
    const facade = createModelBudgetPublic({ budget });
    const input = { runId: "r1", modelRouteRef: "route", maximumTokens: 10 };
    const answer = await facade.reserveBudget(stubScope, input, {
      idempotencyKey: "run:r1",
    });
    expect(answer).toEqual(budget.reservation);
    expect(calls[0]).toEqual({
      name: "reserveModelBudget",
      args: [stubScope, input, { idempotencyKey: "run:r1" }],
    });
    await facade.settleInvocation(stubScope, "res-1", 42);
    expect(calls[1]).toEqual({
      name: "confirm",
      args: [stubScope, "res-1", 42],
    });
    await facade.releaseUnknown(stubScope, "res-1");
    expect(calls[2]).toEqual({
      name: "release",
      args: [stubScope, "res-1"],
    });
  });

  test("资金三道门逐项委托注入的资金协作者", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const facade = createModelBudgetPublic({ credits });
    const input = {
      externalCustomerId: "cust",
      idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}e1`,
      maximumCents: 100,
      expiresAt: new Date(0),
    };
    const hold = await facade.reserveInvocationHold(input);
    expect(hold).toEqual({ reserved: true, reservationId: "hold-stub" });
    expect(calls[0]).toEqual({ name: "reserveCredits", args: [input] });
    await facade.releaseInvocationHold("h1", "provider_error");
    expect(calls[1]).toEqual({
      name: "releaseReservation",
      args: ["h1", "provider_error"],
    });
    await facade.markInvocationHoldUnknown("h1", "stream_error");
    expect(calls[2]).toEqual({
      name: "markReservationUnknown",
      args: ["h1", "stream_error"],
    });
  });

  test("未装配组的能力是装配错误（TypeError），不是业务拒绝", async () => {
    const facade = createModelBudgetPublic({});
    expect(() =>
      facade.authorizeInvocation(new Request("https://x.invalid")),
    ).toThrow(TypeError);
    expect(() =>
      facade.reserveBudget(stubScope, {
        runId: "r",
        modelRouteRef: "m",
        maximumTokens: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      facade.reserveInvocationHold({
        externalCustomerId: "c",
        idempotencyKey: "k",
        maximumCents: 1,
        expiresAt: new Date(0),
      }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// D2 验收① — 双重预算顺序钉（单元）
// ---------------------------------------------------------------------------

describe("MOD09 D2 验收① — token+资金双放行才 dispatch（顺序钉）", () => {
  test("未定价模型：预扣零调用、无 dispatch 形状（ModelNotPricedError）", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const { usageGate } = armWith(credits);
    await expect(
      usageGate({ ...GATE_INPUT, modelId: "unpriced-model" }),
    ).rejects.toThrow(ModelNotPricedError);
    expect(calls).toEqual([]);
  });

  test("策略未配置：直接拒绝且预扣零调用（CreditPolicyUnconfiguredError）", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const { usageGate } = armWith(credits, { policy: "unconfigured" });
    await expect(usageGate(GATE_INPUT)).rejects.toThrow(
      CreditPolicyUnconfiguredError,
    );
    expect(calls).toEqual([]);
  });

  test("余额不足：CreditInsufficientError、无 lifecycle（第二阶段失败不误 dispatch）", async () => {
    const calls = recorder();
    const credits: ModelBudgetCreditCollaborator = {
      async reserveCredits() {
        calls.push({ name: "reserveCredits", args: [] });
        return { reserved: false, availableCents: 3 };
      },
      async releaseReservation() {},
      async markReservationUnknown() {},
    };
    const { usageGate } = armWith(credits);
    await expect(usageGate(GATE_INPUT)).rejects.toThrow(
      CreditInsufficientError,
    );
    // 恰一次预扣尝试，且失败后无任何释放/未知标记（预扣未成立，hold 不存在）。
    expect(calls).toEqual([{ name: "reserveCredits", args: [] }]);
  });

  test("双放行：先界内校验（策略在册）再预扣，放行返回带 token bounds 的 dispatch 形状", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const { usageGate } = armWith(credits);
    const lifecycle = await usageGate(GATE_INPUT);
    expect(lifecycle.bounds).toBeDefined();
    expect(lifecycle.bounds?.input.enforced).toBe("counted");
    expect(lifecycle.bounds?.output.enforced).toBe("provider_cap");
    expect(lifecycle.finish).toBeInstanceOf(Function);
    expect(lifecycle.fail).toBeInstanceOf(Function);
    // 预扣的幂等键与金额出自装配定价策略（验收③的价格依据集中）。
    const reserve = calls[0] as unknown as {
      name: string;
      args: [{ idempotencyKey: string; maximumCents: number }];
    };
    expect(reserve.name).toBe("reserveCredits");
    expect(reserve.args[0].idempotencyKey).toBe(
      `${USAGE_IDEMPOTENCY_KEY_PREFIX}${GATE_INPUT.eventId}`,
    );
    expect(reserve.args[0].maximumCents).toBe(20);
  });

  test("gate 重放同一 eventId：幂等键不变（组合体不发明第二套键）", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const { usageGate } = armWith(credits);
    await usageGate(GATE_INPUT);
    await usageGate({ ...GATE_INPUT });
    const keys = calls.map(
      (c) => (c.args[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      `${USAGE_IDEMPOTENCY_KEY_PREFIX}${GATE_INPUT.eventId}`,
      `${USAGE_IDEMPOTENCY_KEY_PREFIX}${GATE_INPUT.eventId}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// D3 验收② — 零 runs/store import；Run 协作者构造注入（单元 + 源级）
// ---------------------------------------------------------------------------

describe("MOD09 D3 验收② — ModelAccess 零 Run store import，预算协作者装配注入", () => {
  test("public.ts 源级：零 runs/ 与零 billing/ import（依赖倒置，非模块 import）", () => {
    expect(PUBLIC_TS.includes('from "../runs/')).toBe(false);
    expect(PUBLIC_TS.includes('from "../../runs')).toBe(false);
    expect(PUBLIC_TS.includes('from "../../billing/')).toBe(false);
    expect(PUBLIC_TS.includes('from "../../../billing/')).toBe(false);
  });

  test("Run capability 协作者经构造注入：注入假件编译并委托（类型证）", async () => {
    let received: Request | undefined;
    const facade = createModelBudgetPublic({
      invocations: {
        async resolveInvocation(request) {
          received = request;
          return {
            context: {} as never,
            confirmUsage: async () => {},
            markUnknown: async () => {},
          };
        },
      },
    });
    const request = new Request("https://gateway.invalid/v1", {
      headers: { authorization: "Bearer x" },
    });
    const answer = await facade.authorizeInvocation(request);
    expect(answer.confirmUsage).toBeInstanceOf(Function);
    expect(answer.markUnknown).toBeInstanceOf(Function);
    expect(received).toBe(request);
  });

  test("runtime.ts 组合点：资金协作者来自装配的 billing.creditWriter（源级）", () => {
    const runtimeTs = readFileSync(
      join(REPO_ROOT, "src/assembly/runtime.ts"),
      "utf8",
    );
    expect(runtimeTs.includes("createModelBudgetArm({")).toBe(true);
    expect(runtimeTs.includes("credits: billing.creditWriter,")).toBe(true);
    expect(runtimeTs.includes("setModelUsageGate(usageGate);")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D4 验收③ — 原 Payer 一次固定；取消/断流不释放未知费用（单元）
// ---------------------------------------------------------------------------

describe("MOD09 D4 验收③ — 原 Payer/价格版本固定，未知费用不释放", () => {
  test("一次 gate 调用（含 finish）：付款账户读取恰一次，全部写入同名账户", async () => {
    let payerReads = 0;
    const calls = recorder();
    const credits = stubCredits(calls);
    const { usageGate } = armWith(credits, {
      payer: () => {
        payerReads += 1;
        return stubPayerBinding();
      },
    });
    const lifecycle = await usageGate(GATE_INPUT);
    await lifecycle.finish?.({
      eventId: GATE_INPUT.eventId,
      occurredAt: GATE_INPUT.occurredAt,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(payerReads).toBe(1);
    // 预扣与结算事实（outbox 行）都落在同一次解析出的账户上。
    const reserve = calls.find((c) => c.name === "reserveCredits")!;
    expect(
      (reserve.args[0] as { externalCustomerId: string }).externalCustomerId,
    ).toBe(payerKey(STUB_PAYER_REF));
    expect(lastOutboxFact?.externalCustomerId).toBe(payerKey(STUB_PAYER_REF));
  });

  test("取消/断流/缺用量（cancelled/stream_error/usage_missing）：标记未知，不释放", async () => {
    for (const reason of [
      "cancelled",
      "stream_error",
      "usage_missing",
    ] as const) {
      const calls = recorder();
      const credits = stubCredits(calls);
      const { usageGate } = armWith(credits);
      const lifecycle = await usageGate(GATE_INPUT);
      await lifecycle.fail?.({
        eventId: GATE_INPUT.eventId,
        occurredAt: new Date(),
        reason,
      });
      const names = calls.map((c) => c.name);
      expect(names).toContain("markReservationUnknown");
      expect(names).not.toContain("releaseReservation");
      const mark = calls.find((c) => c.name === "markReservationUnknown")!;
      expect(mark.args).toEqual(["hold-stub", reason]);
    }
  });

  test("仅确认无费（provider_error/bound_refused/no_usage）走普通释放", async () => {
    for (const reason of [
      "provider_error",
      "bound_refused",
      "no_usage",
    ] as const) {
      const calls = recorder();
      const credits = stubCredits(calls);
      const { usageGate } = armWith(credits);
      const lifecycle = await usageGate(GATE_INPUT);
      await lifecycle.fail?.({
        eventId: GATE_INPUT.eventId,
        occurredAt: new Date(),
        reason,
      });
      const names = calls.map((c) => c.name);
      expect(names).toContain("releaseReservation");
      expect(names).not.toContain("markReservationUnknown");
    }
  });

  test("价格依据 = 装配传入的同一 creditPolicy 对象（非门面自造第二价）", async () => {
    const calls = recorder();
    const credits = stubCredits(calls);
    const policy = stubPolicy();
    const { usageGate } = armWith(credits, { policy });
    await usageGate(GATE_INPUT);
    // 预扣金额正是该策略对象的 maximumReservationUnits。
    const reserve = calls[0] as unknown as { args: [{ maximumCents: number }] };
    expect(reserve.args[0].maximumCents).toBe(
      Number(policy.models.get("priced-model")!.maximumReservationUnits),
    );
  });
});

// ---------------------------------------------------------------------------
// D6 验收⑤ — 结构断言（源级，单元）
// ---------------------------------------------------------------------------

describe("MOD09 D6 验收⑤ — token 确认不冒充资金结算；网络调用不入长 DB 事务", () => {
  test("组合体与门面均不含资金结算入口 settleReservation（结算权威留在 billing 内件）", () => {
    expect(ARM_TS.includes("settleReservation")).toBe(false);
    expect(PUBLIC_TS.includes("settleReservation")).toBe(false);
    // 组合体的资金写入全部经门面三道门（budgetPublic 承载）。
    expect(ARM_TS.includes("budgetPublic")).toBe(true);
  });

  test("组合体 gate 内零数据库事务、零网络调用（事务边界：网络不入长 DB 事务）", () => {
    expect(ARM_TS.includes(".transaction(")).toBe(false);
    expect(ARM_TS.includes("fetch(")).toBe(false);
    // gate 的结算事实经 outbox record（写后即返），不在任何长事务里。
    expect(ARM_TS.includes("usageOutbox.record(")).toBe(true);
  });

  test("A 门面 settleInvocation 只触 budget confirm（假件证：零资金协作者调用）", async () => {
    const calls = recorder();
    const budget = stubBudgetService(calls);
    const credits = stubCredits(calls);
    const facade = createModelBudgetPublic({ budget, credits });
    await facade.settleInvocation(stubScope, "res-9", 7);
    expect(calls.map((c) => c.name)).toEqual(["confirm"]);
  });
});

// ---------------------------------------------------------------------------
// D5 验收④ — 重放不重扣（真库；缺 env 显式 skip）
// ---------------------------------------------------------------------------

const CREDITS_ENV_OK = (() => {
  try {
    testDatabaseUrl();
    return true;
  } catch {
    return false;
  }
})();

const describeCreditsDb = CREDITS_ENV_OK ? describe : describe.skip;
const itCreditsDb = CREDITS_ENV_OK ? test : test.skip;

const ENTERPRISE_ENV_OK =
  !!process.env[enterpriseSetupDatabaseVariable()]?.trim();
const describeBudgetDb = ENTERPRISE_ENV_OK ? describe : describe.skip;
const itBudgetDb = ENTERPRISE_ENV_OK ? test : test.skip;

describeCreditsDb(
  "MOD09 D5 验收④（资金侧）— credits 真件重放不重扣（TEST_DATABASE_URL）",
  () => {
    let database: Database | undefined;
    let externalCustomerId: string;

    beforeAll(async () => {
      database = createDatabase(testDatabaseUrl(), TEST_POOL);
      const ref: PayerRef = { kind: "personal", id: `mod09-${randomUUID()}` };
      const { account } = await createPayerAccount(database, ref);
      externalCustomerId = account.externalCustomerId;
    });

    afterAll(async () => {
      if (!database) return;
      await database
        .delete(creditReservations)
        .where(eq(creditReservations.externalCustomerId, externalCustomerId));
      await database
        .delete(creditLedger)
        .where(eq(creditLedger.externalCustomerId, externalCustomerId));
      await database
        .delete(creditGrants)
        .where(eq(creditGrants.externalCustomerId, externalCustomerId));
      await database.$client.close();
    });

    itCreditsDb("同幂等键预扣重放：答原预扣，余额只扣一次", async () => {
      const writer = createCreditWriter(database!);
      const grant = await writer.grantCredits({
        externalCustomerId,
        source: "promo",
        totalCents: 10_000,
        expiresAt: new Date(Date.now() + 3_600_000),
        idempotencyKey: `mod09-grant-${externalCustomerId}`,
      });
      expect(grant.inserted).toBe(true);
      const key = `usage:${randomUUID()}`;
      const first = await writer.reserveCredits({
        externalCustomerId,
        idempotencyKey: key,
        maximumCents: 500,
        expiresAt: new Date(Date.now() + 900_000),
      });
      expect(first.reserved).toBe(true);
      const replay = await writer.reserveCredits({
        externalCustomerId,
        idempotencyKey: key,
        maximumCents: 500,
        expiresAt: new Date(Date.now() + 900_000),
      });
      expect(replay).toEqual(first);
      // 台账：恰好一笔 hold 在册。
      const rows = await database!
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.idempotencyKey, key));
      expect(rows).toHaveLength(1);
    });

    itCreditsDb("同 actual 结算重放：只入账一次，异 actual 冲突", async () => {
      const writer = createCreditWriter(database!);
      const key = `usage:${randomUUID()}`;
      const hold = await writer.reserveCredits({
        externalCustomerId,
        idempotencyKey: key,
        maximumCents: 500,
        expiresAt: new Date(Date.now() + 900_000),
      });
      if (!hold.reserved) throw new Error("hold refused");
      const actual = { numerator: 250n, denominator: 1n };
      const settled = await writer.settleReservation({
        reservationId: hold.reservationId,
        actual,
        title: "mod09 replay probe",
        requestId: key,
      });
      const replay = await writer.settleReservation({
        reservationId: hold.reservationId,
        actual,
        title: "mod09 replay probe",
        requestId: key,
      });
      expect(replay).toEqual(settled);
      await expect(
        writer.settleReservation({
          reservationId: hold.reservationId,
          actual: { numerator: 251n, denominator: 1n },
          title: "mod09 replay probe",
        }),
      ).rejects.toThrow(CreditReservationConflictError);
      // 台账：恰好一行扣费。
      const ledgerRows = await database!
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.requestId, key));
      expect(ledgerRows.length).toBe(1);
    });
  },
);

// --- token 侧（企业测试库）---

let enterpriseScope: PlatformScope | undefined;
let enterpriseData: DataDatabase | undefined;
const enterpriseDisposables: (() => Promise<void> | void)[] = [];
let enterpriseRunId: string | undefined;
let enterprisePrefix = "";

async function openEnterpriseRuntime(role: "directory" | "data" | "operator") {
  const url = enterpriseRuntimeDatabaseUrlFrom(role);
  const database = createDatabase(url, { max: 3 });
  try {
    if (role === "directory") return await verifyDirectoryDatabase(database);
    if (role === "data") return await verifyDataDatabase(database);
    return await verifyOperatorDatabase(database);
  } catch (error) {
    await database.$client.close();
    throw error;
  }
}

describeBudgetDb(
  "MOD09 D5 验收④（token 侧）— budget 真件重放不重扣（企业测试库）",
  () => {
    const prefix = `mod09-${randomUUID()}`;
    const actorId = `${prefix}-actor`;
    const principalId = `${prefix}-principal`;
    const tenantId = `${prefix}-tenant`;
    const workspaceId = `${prefix}-workspace`;
    const routeRef = `${prefix}-route`;
    let setupDatabase: Database | undefined;

    beforeAll(async () => {
      enterprisePrefix = prefix;
      setupDatabase = createDatabase(enterpriseTestDatabaseUrlFrom(), {
        max: 4,
      });
      const directory: DirectoryDatabase =
        await openEnterpriseRuntime("directory");
      const data: DataDatabase = await openEnterpriseRuntime("data");
      const operator: OperatorDatabase =
        await openEnterpriseRuntime("operator");
      enterpriseData = data;
      enterpriseDisposables.push(async () => {
        await directory.$client.close();
        await data.$client.close();
        await operator.$client.close();
        await setupDatabase!.$client.close();
      });
      await setupDatabase.insert(users).values({
        id: actorId,
        email: `${actorId}@example.invalid`,
        name: "MOD09 synthetic actor",
      });
      await setupDatabase
        .insert(enterprisePrincipals)
        .values({ id: principalId, userId: actorId });
      await provisionDeployment(operator, {
        operationId: `${prefix}-provision`,
        operator: principalId,
        tenant: { id: tenantId, name: "MOD09 synthetic tenant" },
        workspace: { id: workspaceId, name: "MOD09 synthetic workspace" },
        members: [{ principalId, userId: actorId, role: "tenant_admin" }],
        resources: [],
      });
      // MT005 门槛（tenancy/store.ts:141-162）：预配不写 workspace_memberships，
      // 唯一插入点在 workspace-admin —— 此处经 operator 通道自种一行 active
      // 成员资格（store.ts:161 的 WORKSPACE_FORBIDDEN 源）。
      await operator.transaction(async (tx) => {
        // 插入策略钉 app.operator_principal_id / app.user_id（provision.ts:157 同款）。
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operator_principal_id', ${principalId}, true), set_config('app.user_id', ${actorId}, true)`,
        );
        await tx
          .insert(enterpriseWorkspaceMemberships)
          .values({
            tenantId,
            workspaceId,
            principalId,
            status: "active",
            epoch: 1,
          })
          .onConflictDoNothing();
      });
      // 受信 scope 必须经 scope resolver 签发（store 的 UNVERIFIED_SCOPE 栅栏）。
      const authenticated = new WeakMap<
        Request,
        AuthenticatedRequestIdentity
      >();
      const resolver = createScopeResolver(directory, {
        authenticate: async (request) => authenticated.get(request) ?? null,
        selectTenant: () => tenantId,
        selectWorkspace: () => workspaceId,
      });
      const scopeRequest = new Request(
        "https://enterprise.example.invalid/runs",
      );
      authenticated.set(scopeRequest, { actorId, entrypoint: "web" });
      enterpriseScope = await resolver.resolve(scopeRequest);
      // 预算链的 run 行（直接种入，走 store 事务保证 RLS 上下文一致）。
      enterpriseRunId = randomUUID();
      await createConversationStore(data).transaction(enterpriseScope, (tx) =>
        tx.insert(enterpriseRuns).values({
          id: enterpriseRunId,
          tenantId,
          workspaceId,
          principalId,
          threadId: randomUUID(),
          clientMessageKey: `${prefix}-message`,
          expertVersionRef: `${prefix}-expert`,
          modelRouteRef: routeRef,
          modelRouteMaximumTokens: 2000,
          leaseExpiresAt: new Date(Date.now() + 600_000),
        }),
      );
    });

    afterAll(async () => {
      for (const dispose of enterpriseDisposables.reverse()) await dispose();
    });

    itBudgetDb(
      "run ceiling 预留建立后，同幂等键预留重放答原预留、不重扣",
      async () => {
        const budget = createModelBudgetService({ data: enterpriseData! });
        const facade = createModelBudgetPublic({ budget });
        // 先立 run ceiling（canonical key），再以自定义幂等键预留。
        await facade.reserveBudget(
          enterpriseScope!,
          {
            runId: enterpriseRunId!,
            modelRouteRef: routeRef,
            maximumTokens: 2000,
          },
          { runCeiling: true },
        );
        const input = {
          runId: enterpriseRunId!,
          modelRouteRef: routeRef,
          maximumTokens: 300,
        };
        const first = await facade.reserveBudget(enterpriseScope!, input, {
          idempotencyKey: `mod09-call-${enterprisePrefix}`,
        });
        const replay = await facade.reserveBudget(enterpriseScope!, input, {
          idempotencyKey: `mod09-call-${enterprisePrefix}`,
        });
        expect(replay).toEqual(first);
        // 异输入同键：409 幂等冲突，不产生第二行预留。
        await expect(
          facade.reserveBudget(
            enterpriseScope!,
            { ...input, maximumTokens: 301 },
            { idempotencyKey: `mod09-call-${enterprisePrefix}` },
          ),
        ).rejects.toThrow(/idempotency/i);
      },
    );

    itBudgetDb(
      "确认（ack）重放同用量不冲突；异用量 409；已确认不可释放",
      async () => {
        const budget = createModelBudgetService({ data: enterpriseData! });
        const facade = createModelBudgetPublic({ budget });
        const input = {
          runId: enterpriseRunId!,
          modelRouteRef: routeRef,
          maximumTokens: 100,
        };
        const reservation = await facade.reserveBudget(
          enterpriseScope!,
          input,
          {
            idempotencyKey: `mod09-ack-${enterprisePrefix}`,
          },
        );
        await facade.settleInvocation(
          enterpriseScope!,
          reservation.reservationId,
          40,
        );
        // 同用量重放：幂等返回，不重复记账。
        await facade.settleInvocation(
          enterpriseScope!,
          reservation.reservationId,
          40,
        );
        // 异用量重放：409 冲突。
        await expect(
          facade.settleInvocation(
            enterpriseScope!,
            reservation.reservationId,
            41,
          ),
        ).rejects.toThrow(/confirmed with different usage/i);
        // 已确认不可释放（未知费用不经过已结算预留）。
        await expect(
          facade.releaseUnknown(enterpriseScope!, reservation.reservationId),
        ).rejects.toThrow(/cannot be released/i);
      },
    );
  },
);
