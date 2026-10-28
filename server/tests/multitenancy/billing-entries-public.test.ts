// server/tests/multitenancy/billing-entries-public.test.ts
// MOD10（Issue #630，根 #620）：M07 账务查询/支付收款/权益交付/付款人解析门面的
// 委托等价、路由级双路等价与五条验收的现状钉。
//
// 事实源（Issue #630 验收 + MOD10 Brief §1/§2，逐条对应 describe）：
//   D1 委托等价：门面四族 vs 直调内件替身——同参（对象同一性）、同结果
//      （toBe 同一实例，catalog 为同一映射引用）、同错误实例透传（注入替身
//      证明委托本身）；未装配组调用 = TypeError（装配错误，MOD09 先例）。
//   D2 路由级双路等价：C2/C3/C4/C5/C8/C9 六条迁移臂——注入门面与缺省直用
//      两臂的 wire 状态/正文同形；门面臂确实经门面（计数钉）；伪造账户参数
//      400 与实时/异步 503 准入逐字节不变；POST /purchases 的 owner 由服务器
//      解析且请求体无字段可提供（AC14/Q27）。
//   D3 验收①权限分离：company-finance-visibility 判定门（assertCompanyFinance
//      Reader）先于一切账务事实读取的源级现状钉 + 门面零成员/Bot 管理写面
//      （恰四族、写面标识符零出现）。
//   D4 验收②回调 Payer=服务器订单映射：回调工厂未迁移（仍直调
//      service.handleCallback，不经门面）的源级钉 + 服务内「按渠道事实的
//      outTradeNo 读回已记录订单、Payer 只出自订单行」的源级钉。
//   D5 验收③重复/迟到收款保留独立渠道事实 + 权益幂等：claimed/duplicate
//      两分支同答 success、渠道交易事实逐笔落库、grant 幂等键插入即唯一
//      （inserted:false 答原 grant）的源级钉；真实存储语义由存量
//      billing/payments 套件 BASE 对照钉住（见 reports/MOD10-report.md §5）。
//   D6 验收④收款成功权益失败独立恢复：可重试失败不写 applied、由 sweep/
//      重放回调重跑，恢复证据经管理面 recovery-items 独立查询的源级钉。
//   D7 验收⑤对账只读 + 处置具名：门面无对账/处置成员；管理面每 handler
//      requireAdmin（计数 = 注册路数）；对账 handler 只读服务报告 + 审计；
//      处置命令的 operator 只出自会话。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生
// 收集（覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库：委托语义
// 用注入替身证明（门面只做委托，替身证明的正是委托本身）；验收①-⑤的行为
// 语义以源级结构断言钉住形状，真实 PG/RLS 与渠道时序行为由存量套件两树
// BASE 对照钉住（MOD04/05/09 同法）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { AppVariables, AuthenticatedActor } from "../../src/auth/guards";
import type { PayerRef } from "../../src/billing/payer";
import { createPaymentRoutes } from "../../src/billing/payments/routes";
import { createBillingEntriesPublic } from "../../src/billing/public";
import {
  createBillingCreditRoutes,
  createBillingRoutes,
  createBillingStatementRoutes,
} from "../../src/billing/routes";

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

/** 源码切片：从 `start` 起到 `end`（缺省切到尾）。 */
function sliceFrom(source: string, start: string, end?: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`anchor not found: ${start}`);
  if (end === undefined) return source.slice(from);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`end anchor not found: ${end}`);
  return source.slice(from, to);
}

/** 路由工厂 deps 的类型面（类型经既有签名提取，不新拟第二套形状）。 */
type BillingRouteDeps = Parameters<typeof createBillingRoutes>[0];
type StatementRouteDeps = Parameters<typeof createBillingStatementRoutes>[0];
type CreditRouteDeps = Parameters<typeof createBillingCreditRoutes>[0];
type PaymentRouteDeps = Parameters<typeof createPaymentRoutes>[0];

const ACTOR: AuthenticatedActor = {
  id: "user-mod10-entries",
  email: "mod10@openbot.test",
  role: "user",
};

/** 会话桩：与生产 requireUser 同形——把认证主体放进 context.var。 */
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", ACTOR);
  await next();
};

/** 管理面桩：放行（本文件只断言只读路径的形状，不重测授权矩阵）。 */
const requireAdminAllow = () => undefined;

function jsonBody(response: Response): Promise<unknown> {
  return response.json();
}

// ---------------------------------------------------------------------------
// 内件替身（只承载委托断言；结果形状不是本测试的对象——内件形状与真实
// 存储语义由存量 billing/payments 套件两树 BASE 对照钉住）
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] };

function statementsStub() {
  const calls: Call[] = [];
  const results = {
    planUsage: { marker: "plan-usage" },
    invoices: { marker: "invoices" },
    invoice: { marker: "invoice" },
  };
  const statements = {
    async planUsage(...args: unknown[]) {
      calls.push({ method: "planUsage", args });
      return results.planUsage;
    },
    async invoices(...args: unknown[]) {
      calls.push({ method: "invoices", args });
      return results.invoices;
    },
    async invoice(...args: unknown[]) {
      calls.push({ method: "invoice", args });
      return results.invoice;
    },
  } as unknown as StatementRouteDeps["statements"];
  return { statements, calls, results };
}

function creditsStub() {
  const calls: Call[] = [];
  const catalog = new Map<string, unknown>([["pro", { marker: "plan" }]]);
  const results = {
    personalBalance: { marker: "balance" },
    summary: { marker: "summary" },
    grants: [{ marker: "grant" }],
    consumption: { marker: "consumption" },
  };
  const credits = {
    catalog,
    async personalBalance(...args: unknown[]) {
      calls.push({ method: "personalBalance", args });
      return results.personalBalance;
    },
    async summary(...args: unknown[]) {
      calls.push({ method: "summary", args });
      return results.summary;
    },
    async grants(...args: unknown[]) {
      calls.push({ method: "grants", args });
      return results.grants;
    },
    async consumption(...args: unknown[]) {
      calls.push({ method: "consumption", args });
      return results.consumption;
    },
  } as unknown as CreditRouteDeps["credits"];
  return { credits, calls, results, catalog };
}

function realtimeStub() {
  const calls: Call[] = [];
  const sessions = [{ marker: "session" }];
  const realtimeUsage = {
    async realtimeSessionsForPayer(...args: unknown[]) {
      calls.push({ method: "realtimeSessionsForPayer", args });
      return sessions;
    },
  } as unknown as CreditRouteDeps["realtimeUsage"] & {};
  return { realtimeUsage, calls, sessions };
}

function asyncJobsStub() {
  const calls: Call[] = [];
  const jobs = [{ marker: "job" }];
  const asyncJobsView = {
    async asyncJobsForPayer(...args: unknown[]) {
      calls.push({ method: "asyncJobsForPayer", args });
      return jobs;
    },
  } as unknown as CreditRouteDeps["asyncJobsView"] & {};
  return { asyncJobsView, calls, jobs };
}

function entitlementStub() {
  const calls: Call[] = [];
  const entitlements = {
    active: true,
    planCode: "pro",
    codes: ["pro"],
    subscription: null,
  };
  const service = {
    async entitlements(...args: unknown[]) {
      calls.push({ method: "entitlements", args });
      return entitlements;
    },
  } as unknown as BillingRouteDeps["service"];
  return { service, calls, entitlements };
}

function paymentsStub() {
  const calls: Call[] = [];
  const results = {
    catalog: { marker: "payment-catalog" },
    readOrder: { order: { orderId: "order-1" } },
    readCurrentOrder: { order: null },
    createPurchase: { order: { orderId: "created-1" } },
  };
  const service = {
    catalog(...args: unknown[]) {
      calls.push({ method: "catalog", args });
      return results.catalog;
    },
    async readOrder(...args: unknown[]) {
      calls.push({ method: "readOrder", args });
      return results.readOrder;
    },
    async readCurrentOrder(...args: unknown[]) {
      calls.push({ method: "readCurrentOrder", args });
      return results.readCurrentOrder;
    },
    async createPurchase(...args: unknown[]) {
      calls.push({ method: "createPurchase", args });
      return results.createPurchase;
    },
    async cancelPurchase(...args: unknown[]) {
      calls.push({ method: "cancelPurchase", args });
      return { outcome: "unknown" as const };
    },
  } as unknown as PaymentRouteDeps["service"];
  return { service, calls, results };
}

// ---------------------------------------------------------------------------
// D1 委托等价（门面 vs 内件替身）
// ---------------------------------------------------------------------------

describe("D1 门面委托等价", () => {
  test("accountQuery：statements 三读、credits 四读、实时/异步两读逐项委托", async () => {
    const statements = statementsStub();
    const credits = creditsStub();
    const realtime = realtimeStub();
    const asyncJobs = asyncJobsStub();
    const facade = createBillingEntriesPublic({
      statements: statements.statements,
      credits: credits.credits,
      realtimeUsage: realtime.realtimeUsage,
      asyncJobsView: asyncJobs.asyncJobsView,
    });

    const window = { from: null, to: null, page: 1 };
    const scope = { actorPayerRef: { kind: "personal" as const, id: "u-1" } };
    const payer = { kind: "personal" as const, id: "u-1" };

    expect(await facade.accountQuery.planUsage("customer-key")).toBe(
      statements.results.planUsage,
    );
    expect(await facade.accountQuery.invoices(window, scope)).toBe(
      statements.results.invoices,
    );
    expect(await facade.accountQuery.invoice("bill-1", scope)).toBe(
      statements.results.invoice,
    );
    expect(facade.accountQuery.catalog).toBe(credits.catalog);
    expect(await facade.accountQuery.personalBalance(payer)).toBe(
      credits.results.personalBalance,
    );
    expect(await facade.accountQuery.grants(payer)).toBe(
      credits.results.grants,
    );
    expect(await facade.accountQuery.consumption(window, payer)).toBe(
      credits.results.consumption,
    );
    expect(await facade.accountQuery.realtimeSessionsForPayer(payer)).toBe(
      realtime.sessions,
    );
    expect(await facade.accountQuery.asyncJobsForPayer(payer)).toBe(
      asyncJobs.jobs,
    );

    // 同参：对象同一性（门面不做一次改造、一次复制）
    expect(statements.calls[0]?.args[0]).toBe("customer-key");
    expect(statements.calls[1]?.args[0]).toBe(window);
    expect(statements.calls[1]?.args[1]).toBe(scope);
    expect(statements.calls[2]?.args[1]).toBe(scope);
    expect(credits.calls[0]?.args[0]).toBe(payer);
    expect(credits.calls[2]?.args[0]).toBe(window);
    expect(credits.calls[2]?.args[1]).toBe(payer);
    expect(realtime.calls[0]?.args[0]).toBe(payer);
    expect(asyncJobs.calls[0]?.args[0]).toBe(payer);
  });

  test("orders：payment service 三读逐项委托（同参、同结果实例）", async () => {
    const payments = paymentsStub();
    const facade = createBillingEntriesPublic({
      payments: payments.service,
    });
    const scope = { actorPayerRef: { kind: "personal" as const, id: "u-1" } };

    expect(facade.orders.catalog(true, "pro")).toBe(payments.results.catalog);
    expect(await facade.orders.readOrder("order-1", scope)).toBe(
      payments.results.readOrder,
    );
    expect(await facade.orders.readCurrentOrder(scope)).toBe(
      payments.results.readCurrentOrder,
    );
    expect(payments.calls[0]?.args).toEqual([true, "pro"]);
    expect(payments.calls[1]?.args).toEqual(["order-1", scope]);
    expect(payments.calls[2]?.args).toEqual([scope]);
  });

  test("entitlementDelivery：entitlements 逐项委托（客户键原样透传）", async () => {
    const entitlement = entitlementStub();
    const facade = createBillingEntriesPublic({
      entitlement: entitlement.service,
    });
    expect(await facade.entitlementDelivery.entitlements()).toBe(
      entitlement.entitlements,
    );
    expect(await facade.entitlementDelivery.entitlements("customer-key")).toBe(
      entitlement.entitlements,
    );
    expect(entitlement.calls[0]?.args[0]).toBeUndefined();
    expect(entitlement.calls[1]?.args[0]).toBe("customer-key");
  });

  test("resolvePayer.personal 委托组内纯函数：结果同形、畸形身份同错", () => {
    const facade = createBillingEntriesPublic({});
    expect(facade.resolvePayer.personal({ id: "user-1" })).toEqual({
      kind: "personal",
      id: "user-1",
    } satisfies PayerRef);
    // 内件纪律原样：空 id / 首尾空白是 TypeError，门面不吞不改。
    expect(() => facade.resolvePayer.personal({ id: "" })).toThrow(TypeError);
    expect(() => facade.resolvePayer.personal({ id: " padded" })).toThrow(
      TypeError,
    );
  });

  test("未装配组调用 = TypeError（各装配错误面）", () => {
    const facade = createBillingEntriesPublic({});
    expect(() => facade.accountQuery.planUsage()).toThrow(TypeError);
    expect(() => facade.accountQuery.catalog).toThrow(TypeError);
    expect(() => facade.accountQuery.personalBalance({} as PayerRef)).toThrow(
      TypeError,
    );
    expect(() =>
      facade.accountQuery.realtimeSessionsForPayer({} as PayerRef),
    ).toThrow(TypeError);
    expect(() => facade.accountQuery.asyncJobsForPayer({} as PayerRef)).toThrow(
      TypeError,
    );
    expect(() => facade.orders.catalog(true, null)).toThrow(TypeError);
    expect(() => facade.entitlementDelivery.entitlements()).toThrow(TypeError);
    // resolvePayer 族没有依赖：任何装配下都可用。
    expect(facade.resolvePayer.personal({ id: "u" })).toEqual({
      kind: "personal",
      id: "u",
    });
  });

  test("内件错误实例原样透传（委托本身，不包装）", async () => {
    const boom = new Error("INTERNAL_MARK");
    const facade = createBillingEntriesPublic({
      statements: {
        planUsage: async () => {
          throw boom;
        },
      } as unknown as NonNullable<
        Parameters<typeof createBillingEntriesPublic>[0]["statements"]
      >,
    });
    let caught: unknown = null;
    try {
      await facade.accountQuery.planUsage();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// D2 路由级双路等价（六条迁移臂）
// ---------------------------------------------------------------------------

describe("D2 路由级双路等价（门面臂 ↔ 直用臂）", () => {
  test("C2 GET /entitlements：两臂 wire 同形，门面臂经门面", async () => {
    const entitlement = entitlementStub();
    const facade = createBillingEntriesPublic({
      entitlement: entitlement.service,
    });
    const viaFacade = createBillingRoutes({
      service: entitlement.service,
      requireUser,
      entitlementDelivery: facade.entitlementDelivery,
    });
    const direct = createBillingRoutes({
      service: entitlement.service,
      requireUser,
    });

    const facadeAnswer = await viaFacade.request(
      "http://example.invalid/entitlements",
    );
    const directAnswer = await direct.request(
      "http://example.invalid/entitlements",
    );
    expect(facadeAnswer.status).toBe(200);
    expect(await jsonBody(facadeAnswer)).toEqual(await jsonBody(directAnswer));
    // 两臂都读到同一替身（门面臂的委托链 = 替身调用）
    expect(entitlement.calls).toHaveLength(2);
  });

  test("C3 账单三读：两臂 wire 同形、scope 的 Payer 同一、404 同形", async () => {
    const statements = statementsStub();
    const facade = createBillingEntriesPublic({
      statements: statements.statements,
    });
    const make = (withFacade: boolean) =>
      createBillingStatementRoutes({
        statements: statements.statements,
        requireUser,
        ...(withFacade
          ? {
              accountQuery: facade.accountQuery,
              resolvePayer: facade.resolvePayer,
            }
          : {}),
      });
    const viaFacade = make(true);
    const direct = make(false);

    for (const url of [
      "http://example.invalid/plan-usage",
      "http://example.invalid/invoices",
      "http://example.invalid/invoices/bill-1",
    ]) {
      const facadeAnswer = await viaFacade.request(url);
      const directAnswer = await direct.request(url);
      expect(facadeAnswer.status).toBe(directAnswer.status);
      expect(await jsonBody(facadeAnswer)).toEqual(
        await jsonBody(directAnswer),
      );
    }
    // scope 的 Payer 由会话解析（服务器侧），两臂同值
    const scope = statements.calls.find((call) => call.method === "invoices")
      ?.args[1] as { actorPayerRef: PayerRef } | undefined;
    expect(scope?.actorPayerRef).toEqual({
      kind: "personal",
      id: ACTOR.id,
    });
  });

  test("C4/C5 积分六读：两臂 wire 同形；伪造账户参数 400 不变", async () => {
    const credits = creditsStub();
    const realtime = realtimeStub();
    const asyncJobs = asyncJobsStub();
    const facade = createBillingEntriesPublic({
      credits: credits.credits,
      realtimeUsage: realtime.realtimeUsage,
      asyncJobsView: asyncJobs.asyncJobsView,
    });
    const make = (withFacade: boolean) =>
      createBillingCreditRoutes({
        credits: credits.credits,
        requireUser,
        realtimeUsage: realtime.realtimeUsage,
        asyncJobsView: asyncJobs.asyncJobsView,
        ...(withFacade
          ? {
              accountQuery: facade.accountQuery,
              resolvePayer: facade.resolvePayer,
            }
          : {}),
      });
    const viaFacade = make(true);
    const direct = make(false);

    for (const url of [
      "http://example.invalid/catalog",
      "http://example.invalid/credits/summary",
      "http://example.invalid/credits/grants",
      "http://example.invalid/credits/consumption",
      "http://example.invalid/credits/realtime-sessions",
      "http://example.invalid/credits/async-jobs",
    ]) {
      const facadeAnswer = await viaFacade.request(url);
      const directAnswer = await direct.request(url);
      expect(facadeAnswer.status).toBe(directAnswer.status);
      expect(await jsonBody(facadeAnswer)).toEqual(
        await jsonBody(directAnswer),
      );
    }
    // 伪造账户参数：两臂都 400（拒绝语义逐字节不动）
    for (const routes of [viaFacade, direct]) {
      const forged = await routes.request(
        "http://example.invalid/credits/summary?userId=someone-else",
      );
      expect(forged.status).toBe(400);
    }
  });

  test("C5 503 准入不变：读者缺席时门面臂也一样拒答", async () => {
    const credits = creditsStub();
    const facade = createBillingEntriesPublic({ credits: credits.credits });
    const routes = createBillingCreditRoutes({
      credits: credits.credits,
      requireUser,
      accountQuery: facade.accountQuery,
      resolvePayer: facade.resolvePayer,
    });
    for (const url of [
      "http://example.invalid/credits/realtime-sessions",
      "http://example.invalid/credits/async-jobs",
    ]) {
      const answer = await routes.request(url);
      expect(answer.status).toBe(503);
    }
  });

  test("C8 订单三读：两臂 wire 同形（含 404）", async () => {
    const payments = paymentsStub();
    const facade = createBillingEntriesPublic({ payments: payments.service });
    const make = (withFacade: boolean) =>
      createPaymentRoutes({
        service: payments.service,
        requireUser,
        requireAdmin: requireAdminAllow,
        activePlanCode: async () => "pro",
        ...(withFacade
          ? { orders: facade.orders, resolvePayer: facade.resolvePayer }
          : {}),
      });
    const viaFacade = make(true);
    const direct = make(false);

    for (const url of [
      "http://example.invalid/purchases/catalog",
      "http://example.invalid/purchases/current",
      "http://example.invalid/purchases/order-1",
    ]) {
      const facadeAnswer = await viaFacade.request(url);
      const directAnswer = await direct.request(url);
      expect(facadeAnswer.status).toBe(directAnswer.status);
      expect(await jsonBody(facadeAnswer)).toEqual(
        await jsonBody(directAnswer),
      );
    }
    // catalog 的判定入参两臂同形（canPurchase 由 requireAdmin 结果决定）
    const catalogCall = payments.calls.find(
      (call) => call.method === "catalog",
    );
    expect(catalogCall?.args).toEqual([true, "pro"]);
  });

  test("C9 POST /purchases：owner 由服务器解析，两臂同值，请求体无字段可提供", async () => {
    const payments = paymentsStub();
    const facade = createBillingEntriesPublic({ payments: payments.service });
    const make = (withFacade: boolean) =>
      createPaymentRoutes({
        service: payments.service,
        requireUser,
        requireAdmin: requireAdminAllow,
        activePlanCode: async () => "pro",
        ...(withFacade
          ? { orders: facade.orders, resolvePayer: facade.resolvePayer }
          : {}),
      });
    const body = JSON.stringify({
      planCode: "pro",
      provider: "alipay",
      cycle: "monthly",
    });
    for (const routes of [make(true), make(false)]) {
      const answer = await routes.request("http://example.invalid/purchases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(answer.status).toBe(200);
    }
    const created = payments.calls.filter(
      (call) => call.method === "createPurchase",
    );
    expect(created).toHaveLength(2);
    for (const call of created) {
      const input = call.args[0] as {
        ownerPayerRef: PayerRef;
        cycle: string;
        createdBy: string | null;
      };
      expect(input.ownerPayerRef).toEqual({ kind: "personal", id: ACTOR.id });
      expect(input.cycle).toBe("monthly");
      expect(input.createdBy).toBe(ACTOR.id);
    }
    // 请求体携带账户身份 → 400（strictObject，AC14/Q27）
    const forged = await make(true).request(
      "http://example.invalid/purchases",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planCode: "pro",
          provider: "alipay",
          cycle: "monthly",
          userId: "someone-else",
        }),
      },
    );
    expect(forged.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// D3 验收①权限分离
// ---------------------------------------------------------------------------

describe("D3 验收①：公司财务授权面与成员/Bot 管理面分离（现状钉）", () => {
  test("company-finance 判定门先于一切账务事实读取", () => {
    const finance = codeOf("../../src/billing/company-finance-visibility.ts");
    expect(finance).toContain("assertCompanyFinanceReader");
    expect(finance).toContain("COMPANY_FINANCE_REQUIRED");
    expect(finance).toContain("async companyBooks(");
    const books = sliceFrom(finance, "async companyBooks(", "async ");
    const gate = books.indexOf("this.assertCompanyFinanceReader({");
    const firstRead = books.indexOf(".select(");
    expect(gate).toBeGreaterThanOrEqual(0);
    if (firstRead >= 0) expect(gate).toBeLessThan(firstRead);
  });

  test("门面恰四族、成员的写面/管理面标识符零出现", () => {
    const facade = createBillingEntriesPublic({});
    expect(Object.keys(facade).sort()).toEqual([
      "accountQuery",
      "entitlementDelivery",
      "orders",
      "resolvePayer",
    ]);
    expect(Object.keys(facade.accountQuery).sort()).toEqual(
      [
        "asyncJobsForPayer",
        "catalog",
        "consumption",
        "grants",
        "invoice",
        "invoices",
        "personalBalance",
        "planUsage",
        "realtimeSessionsForPayer",
      ].sort(),
    );
    expect(Object.keys(facade.orders).sort()).toEqual([
      "catalog",
      "readCurrentOrder",
      "readOrder",
    ]);
    expect(Object.keys(facade.entitlementDelivery)).toEqual(["entitlements"]);
    expect(Object.keys(facade.resolvePayer)).toEqual(["personal"]);

    const facadeCode = codeOf("../../src/billing/public.ts");
    for (const forbidden of [
      "createPurchase",
      "cancelPurchase",
      "handleCallback",
      "handleWebhook",
      "grantReward",
      "grantCredits",
      "createRecoveryDisposal",
      "reserveCredits",
      "releaseReservation",
      "markReservationUnknown",
      "reconcile(",
      "asyncJobsForReview",
      "snapshot(",
    ]) {
      expect(facadeCode).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// D4 验收②回调 Payer = 服务器订单映射（现状钉）
// ---------------------------------------------------------------------------

describe("D4 验收②：渠道回调 Payer 按服务器订单映射（现状钉）", () => {
  test("回调工厂未迁移：直调 service.handleCallback，不经门面", () => {
    const routes = codeOf("../../src/billing/payments/routes.ts");
    const callback = sliceFrom(
      routes,
      "export function createPaymentCallbackRoutes",
      "async function callbackAnswer(",
    );
    expect(callback).toContain("deps.service.handleCallback(");
    expect(callback).not.toContain("deps.orders");
    expect(callback).not.toContain("deps.resolvePayer");
    expect(callback).not.toContain("billingReadScopeOf");
  });

  test("服务按渠道事实的 outTradeNo 读回已记录订单，Payer 只出自订单行", () => {
    const service = codeOf("../../src/billing/payments/service.ts");
    // 锚在 handleCallback 本体段内（全文另有更早的 settlePaidFact 调用段）
    const callback = sliceFrom(
      service,
      "async handleCallback(",
      "async sweepExpired(",
    );
    const readAt = callback.indexOf("deps.store.readOrder(fact.outTradeNo)");
    const settleAt = callback.indexOf("settlePaidFact(order, fact)");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThan(readAt);
    // 权益归属来自订单行自己的 owner，回调字节里没有可读的用户字段
    expect(service).toContain("const owner = order.ownerPayerRef;");
    expect(service).toContain("if (order.ownerPayerRef)");
  });
});

// ---------------------------------------------------------------------------
// D5 验收③重复/迟到收款保留独立渠道事实 + 权益幂等（现状钉）
// ---------------------------------------------------------------------------

describe("D5 验收③：重复/迟到收款渠道事实与权益幂等（现状钉）", () => {
  test("claimed 与 duplicate 两分支同答 success（迟到/重复不报错、不双记）", () => {
    const service = codeOf("../../src/billing/payments/service.ts");
    expect(service).toContain('case "claimed":');
    expect(service).toContain('case "duplicate":');
    expect(service).toContain('return { kind: "success" };');
    // 渠道交易事实逐笔落库（金额/流水号出自渠道事实，不被权益结果吞掉）
    expect(service).toContain(
      "channelTransactionId: fact.channelTransactionId",
    );
  });

  test("grant 幂等：唯一键插入即收敛，重放答原 grant（inserted:false）", () => {
    const writer = codeOf("../../src/billing/credits-writer.ts");
    expect(writer).toContain("target: creditGrants.idempotencyKey");
    expect(writer).toContain(
      "return { inserted: false, grant: resultOf(existing) };",
    );
    // 权益发放的幂等键按订单固定（plan:<orderId>，装配层 grantor，sweep/重放
    // 回调/重开页面重跑时收敛为同一份发放）
    const runtime = codeOf("../../src/assembly/runtime.ts");
    const dollar = "$";
    expect(runtime).toContain(
      `idempotencyKey: \`plan:${dollar}{input.orderId}\``,
    );
  });
});

// ---------------------------------------------------------------------------
// D6 验收④收款成功权益失败独立恢复（现状钉）
// ---------------------------------------------------------------------------

describe("D6 验收④：收款成功、权益失败可独立恢复（现状钉）", () => {
  test("可重试失败不写 applied，由 sweep/重放回调重跑（幂等收敛）", () => {
    const service = codeOf("../../src/billing/payments/service.ts");
    expect(service).toContain('return { kind: "retryable-failure"');
    expect(service).toContain("grantPlanCreditsFor(");
    // 恢复证据走管理面独立查询：未解除的 recovery item 列表
    const routes = codeOf("../../src/billing/routes.ts");
    expect(routes).toContain('routes.get("/recovery-items"');
    expect(routes).toContain('ne(creditRecoveryItems.state, "resolved")');
  });
});

// ---------------------------------------------------------------------------
// D7 验收⑤对账只读 + 处置具名（结构断言）
// ---------------------------------------------------------------------------

describe("D7 验收⑤：对账只读与处置具名授权（结构断言）", () => {
  test("管理面每个 handler 各自 requireAdmin（注册路数 = 检查次数）", () => {
    const routes = codeOf("../../src/billing/routes.ts");
    const admin = sliceFrom(routes, "export function createBillingAdminRoutes");
    const registered = admin.match(/routes\.(?:get|post)\(/g) ?? [];
    const checked = admin.match(/deps\.requireAdmin\(context\)/g) ?? [];
    expect(registered.length).toBe(9);
    expect(checked.length).toBe(registered.length);
  });

  test("对账 handler 只读报告 + 审计，不写账本", () => {
    const routes = codeOf("../../src/billing/routes.ts");
    const reconcile = sliceFrom(
      routes,
      'routes.post("/reconcile"',
      'routes.get("/cleanup/execution"',
    );
    expect(reconcile).toContain("await deps.service.reconcile()");
    expect(reconcile).not.toContain("creditWriter");
    expect(reconcile).not.toContain("disposal");
  });

  test("处置命令的 operator 只出自会话；审阅面永不处置", () => {
    const routes = codeOf("../../src/billing/routes.ts");
    const disposal = sliceFrom(
      routes,
      'routes.post("/recovery-items/:itemId/disposal"',
    );
    expect(disposal).toContain("deps.requireAdmin(context)");
    expect(disposal).toContain("operatorId: context.var.actor.id");
    // 审阅读面（GET /recovery-items 与 GET /async-jobs）不含处置命令
    const review = sliceFrom(
      routes,
      'routes.get("/recovery-items"',
      'routes.get("/async-jobs"',
    );
    expect(review).not.toContain("disposal.dispose");
    // 门面同样不暴露对账/处置（写面零暴露的运行时面）
    const facade = createBillingEntriesPublic({});
    const forbidden = [
      "reconcile",
      "dispose",
      "createRecoveryDisposal",
      "creditWriter",
      "grantCredits",
    ];
    for (const name of forbidden) {
      expect(Object.hasOwn(facade, name)).toBe(false);
      expect(Object.hasOwn(facade.accountQuery, name)).toBe(false);
      expect(Object.hasOwn(facade.orders, name)).toBe(false);
    }
  });
});
